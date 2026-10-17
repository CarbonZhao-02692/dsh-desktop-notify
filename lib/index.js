/**
 * @dsh-external/dsh-desktop-notify — DSH 桌面通知（host 半侧）。
 *
 * 触发条件：所有 DSH Web 前端都失焦（window/document 无焦点）时，才向 Windows
 * 通知中心发 toast。四类事件：
 *   ① user-questions/request → 需要你选择决策
 *   ② approval/request       → 需要你授权
 *   ③ turn/end error/interrupted/max-tokens、api-session/error → 意外中断，请重试
 *   ④ turn/end completed     → 任务已完成
 *
 * 通知标题 = 会话标题（sessionTitle 折叠；没有时回退首条用户消息），
 * 内容 = 对应提示。
 *
 * 前端失焦状态由 client.js 通过 /dsh-desktop-notify/focus 心跳上报；host 汇总
 * 所有标签页/窗口，任意一个“可见且拥有焦点”就静默。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = '@dsh-external/dsh-desktop-notify'
export const inject = ['webServer', 'sessions', 'sessionTitle', 'connection']

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FOCUS_TTL_MS = 180000
const HEARTBEAT_MS = 3000
const DEDUPE_MS = 2500

const DEFAULTS = {
  notifyOnDecision: true,
  notifyOnApproval: true,
  notifyOnInterruption: true,
  notifyOnComplete: true,
  onlyWhenUnfocused: true,
  ignoreSubagent: true,
  minTurnDurationMs: 0,
  clickToOpen: true,
  toastAppId: 'DeepSeek.DSH.Notify',
  toastAppName: 'Deepseek Harness Notification',
  toastIconPath: '',
  toastAppIconPath: '',
  logFile: '',
}

function truncate(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function formatDuration(ms) {
  if (!ms || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' 秒'
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
}

function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Never persist or return the launch token in logs / HTTP responses. */
function redactLaunch(value) {
  return String(value || '')
    .replace(/([?&]token=)[^&#]*/gi, '$1***')
    .replace(/([?&]key=)[^&#]*/gi, '$1***')
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * ToastGeneric XML: title + body + official whale logo. `launch` uses protocol
 * activation so a click opens the DSH web URL (which the client half turns into
 * the target conversation). The fragment carries the session id and survives
 * the launch-token 303 redirect; query parameters would be dropped.
 */
export function buildToastXml(title, body, iconPng, launch) {
  const launchAttr = launch
    ? ' activationType="protocol" launch="' + escapeXml(launch) + '"'
    : ''
  const image = iconPng
    ? '<image placement="appLogoOverride" src="' + escapeXml(pathToFileURL(iconPng).href) + '" hint-crop="none"/>'
    : ''
  const actions = launch
    ? '<actions><action content="回到对话" activationType="protocol" arguments="' + escapeXml(launch) + '"/></actions>'
    : ''
  return '<toast' + launchAttr + '><visual><binding template="ToastGeneric">'
    + '<text>' + escapeXml(title) + '</text>'
    + '<text>' + escapeXml(body) + '</text>'
    + image
    + '</binding></visual>'
    + actions
    + '<audio src="ms-winsoundevent:Notification.Default"/></toast>'
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const clients = new Map()
  const turnStarted = new Map()
  const lastNotified = new Map()
  const recent = []
  let pendingActivation = null
  let lastFocused = null
  const openSecret = randomBytes(16).toString('hex')

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = cfg.logFile || join(dshHome, 'super-injector', 'dsh-desktop-notify.log')
  const toastIconPath = cfg.toastIconPath || join(PLUGIN_ROOT, 'assets', 'deepseek-harness.png')
  const toastAppIconPath = cfg.toastAppIconPath || join(PLUGIN_ROOT, 'assets', 'deepseek-harness.ico')
  const showToastPath = join(PLUGIN_ROOT, 'assets', 'show-toast.ps1')
  const notifyCardPath = join(PLUGIN_ROOT, 'assets', 'notify-card.ps1')

  function log(message) {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + message + '\n')
    } catch {
      /* logging must never break a notification path */
    }
  }

  function purgeClients(now) {
    for (const [id, entry] of clients) {
      if (now - entry.lastSeen > FOCUS_TTL_MS) clients.delete(id)
    }
  }

  /**
   * “所有 DSH 前端都失焦”的唯一判据：没有任何一个已上报页面处于 focused
   * 状态。任一页面 focused=true（哪怕 visible 上报暂时矛盾）都保守地视为
   * “未全部失焦”并静默；没有页面上报（全部关闭）才视为全部失焦。
   * 页面通过 blur/focus/visibilitychange 与 3s 心跳更新；后台标签页的定时器可能被
   * 浏览器节流，所以 3 分钟无心跳才按关闭处理（正常关闭会 sendBeacon 立即移除）。
   */
  function focusedFrontend() {
    const now = Date.now()
    purgeClients(now)
    for (const entry of clients.values()) {
      if (entry.focused) return true
    }
    return false
  }

  /** The most recently focused DSH page; the activation prefers this one. */
  function currentFocusedClientId() {
    const now = Date.now()
    let best = null
    for (const [id, entry] of clients) {
      if (now - entry.lastSeen > FOCUS_TTL_MS) continue
      if (!entry.focused) continue
      if (!best || entry.lastSeen > best.lastSeen) best = { id, lastSeen: entry.lastSeen }
    }
    if (best) return best.id
    // 浏览器窗口刚失焦时，所有页面都报 focused=false；仍优先把点击交给
    // 用户最后使用的那个页面（它仍是浏览器里选中的标签页）。
    if (lastFocused && clients.has(lastFocused.id)) {
      const entry = clients.get(lastFocused.id)
      if (now - entry.lastSeen <= FOCUS_TTL_MS) return lastFocused.id
    }
    return null
  }

  /**
   * Fallback only when no DSH page is open. The helper opens this URL in the
   * default browser; the bootstrap page stores the session id and redirects
   * into DSH, where the freshly loaded client opens the conversation.
   */
  function fallbackUrlFor(sessionId) {
    return ctx.webServer.getOrigin() + '/dsh-desktop-notify/open?session=' + encodeURIComponent(sessionId)
      + '&key=' + openSecret
  }

  function sessionOf(sessionId) {
    try {
      const sessions = ctx.sessions || (ctx.get && ctx.get('sessions'))
      return sessions && sessions.get ? sessions.get(sessionId) : undefined
    } catch {
      return undefined
    }
  }

  function isSubagent(sessionId, session) {
    if (!session) return false
    const header = session.header || {}
    // fork（有 parentSession 但没有 origin）是用户自己的对话，不静音。
    return header.origin === 'subagent'
  }

  /** Conversation title: folded session title, else the first user message. */
  function titleFor(sessionId) {
    const session = sessionOf(sessionId)
    if (!session) return String(sessionId)
    try {
      const titles = ctx.sessionTitle || (ctx.get && ctx.get('sessionTitle'))
      const snapshot = titles && titles.get ? titles.get(session) : undefined
      if (snapshot && snapshot.title) return truncate(snapshot.title, 80)
    } catch { /* fall through */ }
    try {
      const events = session.snapshotEvents ? session.snapshotEvents() : []
      for (const event of events) {
        if (event.type !== 'user/message') continue
        const text = blocksToText(event.data && event.data.content)
        if (text.trim()) return truncate(text, 60)
      }
    } catch { /* fall through */ }
    return String(sessionId)
  }

  /**
   * Toast click target: a custom URI handled by assets/open.ps1. The helper
   * POSTs the session id back to this host; the already-open DSH page polls the
   * activation endpoint and switches conversations. No new browser tab.
   */
  function launchFor(sessionId) {
    if (!cfg.clickToOpen || !sessionId) return ''
    const origin = ctx.webServer.getOrigin()
    return 'dsh-desktop-notify://open?session=' + encodeURIComponent(sessionId)
      + '&origin=' + encodeURIComponent(origin)
  }

  function sendToast(title, body, sessionId) {
    if (process.platform !== 'win32') {
      log('skip toast: platform=' + process.platform)
      return false
    }
    const base = 'dsh-desktop-notify-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const toastJobFile = join(tmpdir(), base + '-toast.json')
    const cardJobFile = join(tmpdir(), base + '-card.json')
    const toastJob = {
      xml: buildToastXml(title, body, toastIconPath, ''),
      aumid: cfg.toastAppId,
      appName: cfg.toastAppName,
      iconUri: toastAppIconPath ? pathToFileURL(toastAppIconPath).href : '',
      suppressPopup: true,
    }
    const cardJob = {
      title,
      body,
      appName: cfg.toastAppName,
      iconPng: pathToFileURL(toastIconPath).href,
      helperPath: join(PLUGIN_ROOT, 'assets', 'open.ps1'),
      sessionId: sessionId || '',
      origin: ctx.webServer.getOrigin(),
    }
    const run = (script, jobFile) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, jobFile],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => log('notification spawn error: ' + String(error && error.message)))
      child.on('close', (code) => {
        const detail = stderr.trim()
        log('notification exit=' + code + ' script=' + script.split(/[\\/]/).pop() + (detail ? ' stderr=' + detail.slice(0, 300) : ''))
      })
      return child
    }
    try {
      writeFileSync(toastJobFile, JSON.stringify(toastJob), 'utf8')
      writeFileSync(cardJobFile, JSON.stringify(cardJob), 'utf8')
      run(showToastPath, toastJobFile)
      run(notifyCardPath, cardJobFile)
      return true
    } catch (error) {
      log('notification spawn throw: ' + String(error && error.message))
      return false
    }
  }

  function notify(kind, sessionId, body, options) {
    const opts = options || {}
    const enabledKey = {
      decision: 'notifyOnDecision',
      approval: 'notifyOnApproval',
      interruption: 'notifyOnInterruption',
      complete: 'notifyOnComplete',
    }[kind]
    if (enabledKey && cfg[enabledKey] === false) return { sent: false, reason: 'disabled' }

    const session = sessionId ? sessionOf(sessionId) : undefined
    if (cfg.ignoreSubagent && isSubagent(sessionId, session)) {
      return { sent: false, reason: 'subagent' }
    }

    if (cfg.onlyWhenUnfocused && !opts.force && focusedFrontend()) {
      log('suppressed ' + kind + ' session=' + sessionId + ': a DSH frontend is focused')
      return { sent: false, reason: 'focused' }
    }

    const key = kind + ':' + sessionId
    const now = Date.now()
    const previous = lastNotified.get(key)
    if (!opts.force && previous && now - previous < DEDUPE_MS) {
      return { sent: false, reason: 'dedupe' }
    }
    lastNotified.set(key, now)

    const title = opts.title || (sessionId ? titleFor(sessionId) : 'DSH')
    const text = truncate(opts.body || body, 300)
    const launch = opts.launch !== undefined ? opts.launch : launchFor(sessionId)
    const sent = sendToast(title, text, sessionId)
    const shownLaunch = redactLaunch(launch)
    recent.unshift({ at: now, kind, sessionId: sessionId || '', title, body: text, sent, launch: shownLaunch })
    if (recent.length > 20) recent.length = 20
    log('notify kind=' + kind + ' session=' + sessionId + ' sent=' + sent + ' title=' + title + ' body=' + text + (launch ? ' launch=' + shownLaunch : ''))
    return { sent, reason: sent ? 'sent' : 'spawn-failed', title, body: text, launch: shownLaunch }
  }

  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (!size) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function json(res, status, value) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  }

  function isLoopback(req) {
    const address = (req.socket && req.socket.remoteAddress) || ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  // 兜底：没有任何已打开页面时，由 host 打开一个带会话 id 的引导页
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-desktop-notify/open',
    handler(req, res) {
      try {
        if (!isLoopback(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        const url = new URL(req.url || '/', 'http://dsh.invalid')
        if (url.searchParams.get('key') !== openSecret) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        const sessionId = url.searchParams.get('session') || ''
        let target = ctx.webServer.getOrigin() + '/'
        try {
          if (ctx.connection && typeof ctx.connection.authenticatedUrl === 'function') {
            target = ctx.connection.authenticatedUrl(target)
          }
        } catch { /* cookie auth may already be present */ }
        const payload = JSON.stringify({ sessionId, at: Date.now() })
        log('bootstrap page served session=' + sessionId)
        const html = '<!doctype html><html><head><meta charset="utf-8"><title>DSH</title></head><body><script>'
          + 'try{localStorage.setItem("dsh-desktop-notify:open",' + JSON.stringify(payload) + ')}catch(e){}'
          + 'location.replace(' + JSON.stringify(target) + ');'
          + '</script></body></html>'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('open failed')
      }
    },
  }), '@dsh-external/dsh-desktop-notify: open route')

  // 自定义协议 helper 回传：记录一次“点击通知 → 打开会话”的请求
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-desktop-notify/activate',
    async handler(req, res) {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' })
        const body = await readJson(req)
        const sessionId = truncate(body.sessionId, 120)
        if (!sessionId) return json(res, 400, { error: 'missing sessionId' })
        const now = Date.now()
        purgeClients(now)
        pendingActivation = {
          sessionId,
          at: now,
          target: currentFocusedClientId(),
        }
        const livePages = clients.size
        log('activation queued session=' + sessionId + ' target=' + (pendingActivation.target || 'any') + ' live=' + livePages)
        const fallbackUrl = (livePages === 0 || body.forceFallback === true)
          ? fallbackUrlFor(sessionId)
          : ''
        if (fallbackUrl) log('fallback offered session=' + sessionId)
        const targetEntry = pendingActivation.target ? clients.get(pendingActivation.target) : undefined
        return json(res, 200, {
          ok: true,
          livePages,
          fallbackUrl,
          targetTitle: targetEntry ? targetEntry.title || '' : '',
          sessionTitle: titleFor(sessionId),
        })
      } catch (error) {
        log('activate route error: ' + String(error && error.message))
        return json(res, 400, { error: 'bad request' })
      }
    },
  }), '@dsh-external/dsh-desktop-notify: activate route')

  // 已开启的 DSH 页面轮询这里；只把请求交给最近聚焦的页面，避免多标签一起跳
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-desktop-notify/activation',
    handler(req, res) {
      try {
        if (!pendingActivation) return json(res, 200, { sessionId: null })
        if (Date.now() - pendingActivation.at > 20000) {
          pendingActivation = null
          return json(res, 200, { sessionId: null })
        }
        const url = new URL(req.url || '/', 'http://dsh.invalid')
        const clientId = url.searchParams.get('id') || ''
        const target = pendingActivation.target || currentFocusedClientId()
        if (target && clientId !== target) return json(res, 200, { sessionId: null })
        const sessionId = pendingActivation.sessionId
        pendingActivation = null
        log('activation delivered session=' + sessionId + ' client=' + (clientId || 'any'))
        return json(res, 200, { sessionId })
      } catch (error) {
        log('activation route error: ' + String(error && error.message))
        return json(res, 200, { sessionId: null })
      }
    },
  }), '@dsh-external/dsh-desktop-notify: activation route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-desktop-notify/focus',
    async handler(req, res) {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        const id = truncate(body.id, 80)
        if (!id) return json(res, 400, { error: 'missing id' })
        if (body.closed) {
          clients.delete(id)
          if (lastFocused && lastFocused.id === id) lastFocused = null
        } else {
          clients.set(id, {
            focused: Boolean(body.focused),
            visible: Boolean(body.visible),
            title: truncate(body.title, 200),
            lastSeen: Date.now(),
          })
          if (body.focused) lastFocused = { id, at: Date.now() }
        }
        return json(res, 200, { ok: true, focused: focusedFrontend() })
      } catch (error) {
        log('focus route error: ' + String(error && error.message))
        return json(res, 400, { error: 'bad request' })
      }
    },
  }), '@dsh-external/dsh-desktop-notify: focus route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-desktop-notify/status',
    handler(req, res) {
      const now = Date.now()
      purgeClients(now)
      return json(res, 200, {
        now,
        focused: focusedFrontend(),
        clients: Array.from(clients.entries()).map(([id, entry]) => ({
          id,
          focused: entry.focused,
          visible: entry.visible,
          title: entry.title || '',
          ageMs: now - entry.lastSeen,
        })),
        recent,
      })
    },
  }), '@dsh-external/dsh-desktop-notify: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-desktop-notify/test',
    async handler(req, res) {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        const kind = ['decision', 'approval', 'interruption', 'complete'].includes(body.kind)
          ? body.kind
          : 'complete'
        const result = notify(kind, body.sessionId || '', body.body || '这是一条测试通知', {
          force: Boolean(body.force),
          title: body.title,
          body: body.body || '这是一条测试通知',
        })
        return json(res, 200, result)
      } catch (error) {
        return json(res, 400, { error: String(error && error.message) })
      }
    },
  }), '@dsh-external/dsh-desktop-notify: test route')

  ctx.effect(() => {
    const timer = setInterval(() => purgeClients(Date.now()), HEARTBEAT_MS)
    return () => clearInterval(timer)
  }, '@dsh-external/dsh-desktop-notify: focus sweeper')

  // ① 需要你选择决策（含 plan review）
  ctx.on('user-questions/request', function (request, next) {
    try {
      const agentId = (request && request.agent && request.agent.id) || (this && this.id)
      const questions = request && Array.isArray(request.questions) ? request.questions : []
      const first = questions[0]
      let body
      if (first && first.intent && first.intent.kind === 'plan-review') {
        body = '需要你确认方案：' + (first.question || '计划已就绪')
      } else {
        const asked = questions
          .slice(0, 2)
          .map((question) => question && question.question)
          .filter(Boolean)
          .join('；')
        body = '需要你选择决策：' + (asked || '请回到 DSH 处理待回答的问题')
      }
      notify('decision', agentId, body)
    } catch (error) {
      log('decision notify error: ' + String(error && error.message))
    }
    return next()
  })

  // ② 需要你授权
  ctx.on('approval/request', function (request, next) {
    try {
      const agentId = (request && request.agent && request.agent.id) || (this && this.id)
      const tool = (request && request.toolName) || '工具操作'
      const display = request && request.displayReason
      const reason = (display && (display.zh || display['zh-CN'] || display.en)) || (request && request.reason)
      notify('approval', agentId, '需要你授权：' + tool + (reason ? ' — ' + truncate(reason, 160) : ''))
    } catch (error) {
      log('approval notify error: ' + String(error && error.message))
    }
    return next()
  })

  // ③/④ turn 结束：completed → 完成；error/interrupted/max-tokens → 意外中断
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      if (event.type === 'turn/start') {
        turnStarted.set(session.id, Date.now())
        return
      }
      if (event.type !== 'turn/end') return
      const reason = event.data && event.data.reason
      const kind = reason && reason.kind
      if (kind === 'completed') {
        const startedAt = turnStarted.get(session.id)
        turnStarted.delete(session.id)
        const duration = startedAt ? Date.now() - startedAt : 0
        if (duration < (cfg.minTurnDurationMs || 0)) return
        notify('complete', session.id, '任务已完成' + (duration ? '（用时 ' + formatDuration(duration) + '）' : ''))
        return
      }
      if (kind === 'error') {
        const detail = reason.error && reason.error.message ? reason.error.message : '未知错误'
        notify('interruption', session.id, '任务意外中断：' + truncate(detail, 180) + '，请重试')
        return
      }
      if (kind === 'interrupted') {
        notify('interruption', session.id, '任务意外中断，请重试')
        return
      }
      if (kind === 'max-tokens') {
        notify('interruption', session.id, '输出达到上限被截断，请重试或继续')
      }
    } catch (error) {
      log('turn event error: ' + String(error && error.message))
    }
  })

  // ③ 轮次之外的 agent 失败（兜底）
  ctx.on('api-session/error', (sessionId, message) => {
    try {
      notify('interruption', sessionId, '任务意外中断：' + truncate(message || '未知错误', 180) + '，请重试')
    } catch (error) {
      log('api-session error: ' + String(error && error.message))
    }
  })

  // 会话离开 live registry 时清理计时/去重状态
  ctx.on('session/disposed', (session) => {
    try {
      if (!session) return
      turnStarted.delete(session.id)
      for (const key of lastNotified.keys()) {
        if (key.endsWith(':' + session.id)) lastNotified.delete(key)
      }
    } catch { /* ignore */ }
  })

  log('installed; focus gating=' + cfg.onlyWhenUnfocused + ' appId=' + cfg.toastAppId)
}
