/* @carbonzhao/dsh-desktop-notify — client 半侧。
 *
 * 职责一：把当前 DSH 页面的“是否有焦点/是否可见”上报给 host。
 *   host 汇总所有页面：任意一个页面 focused && visible 就静默；全部失焦才发
 *   Windows 通知。心跳 3s，host 12s 内收不到就视为该页面已关闭。
 * 职责二：设置 → 通用 里的“桌面通知”一行：显示前端焦点状态，并提供测试按钮。
 */
window.__ModuleLoader__.load({
  id: '@carbonzhao/dsh-desktop-notify',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var inject = ['slots']

    function NotifySettingsRow() {
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var messageState = React.useState('')
      var message = messageState[0]
      var setMessage = messageState[1]

      React.useEffect(function () {
        var alive = true
        function load() {
          fetch('/dsh-desktop-notify/status', { cache: 'no-store' })
            .then(function (response) { return response.json() })
            .then(function (value) { if (alive) setStatus(value) })
            .catch(function () {})
        }
        load()
        var timer = window.setInterval(load, 5000)
        return function () {
          alive = false
          window.clearInterval(timer)
        }
      }, [])

      function sendTest() {
        setMessage('发送中…')
        fetch('/dsh-desktop-notify/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'complete',
            force: true,
            title: 'DSH 通知测试',
            body: '如果你看到这条，说明 Windows 通知已可用',
          }),
        })
          .then(function (response) { return response.json() })
          .then(function (value) {
            setMessage(value && value.sent ? '已发送测试通知' : '未发送：' + String((value && value.reason) || 'unknown'))
          })
          .catch(function (error) { setMessage('发送失败：' + String(error)) })
      }

      var clients = status && Array.isArray(status.clients) ? status.clients.length : 0
      var focused = Boolean(status && status.focused)
      var detail = '所有 DSH 网页前端失焦时，决策 / 授权 / 中断 / 完成会发 Windows 通知。'
        + '当前页面：' + clients + '，'
        + (focused ? '有前端聚焦（静默中）' : '全部失焦（会通知）')
        + (message ? '；' + message : '')

      return React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0' } },
        React.createElement(
          'div',
          { style: { minWidth: 0 } },
          React.createElement('div', { style: { fontWeight: 600 } }, '桌面通知'),
          React.createElement('div', { style: { fontSize: 12, opacity: 0.72, lineHeight: 1.5 } }, detail),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: sendTest,
            style: { flex: '0 0 auto', padding: '6px 12px', borderRadius: 6, cursor: 'pointer' },
          },
          '发送测试通知',
        ),
      )
    }

    function apply(ctx) {
      var STORAGE_KEY = 'dsh-desktop-notify:client-id'
      var clientId
      try {
        clientId = window.sessionStorage.getItem(STORAGE_KEY)
        if (!clientId) {
          clientId = 'dsh-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
          window.sessionStorage.setItem(STORAGE_KEY, clientId)
        }
      } catch (error) {
        clientId = 'dsh-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
      }

      var disposed = false

      function snapshot() {
        var visible = document.visibilityState === 'visible'
        var focused = visible && document.hasFocus()
        return { id: clientId, focused: focused, visible: visible, title: document.title || '', at: Date.now() }
      }

      function post(path, payload, beacon) {
        if (disposed) return
        var body = JSON.stringify(payload)
        try {
          if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon(path, new Blob([body], { type: 'application/json' }))
            return
          }
          fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: body,
            keepalive: true,
            cache: 'no-store',
          }).catch(function () {})
        } catch (error) {
          /* a focus reporter must never break the page */
        }
      }

      function report() {
        post('/dsh-desktop-notify/focus', snapshot(), false)
      }

      function reportNow() {
        post('/dsh-desktop-notify/focus', snapshot(), true)
      }

      function onPageHide() {
        var state = snapshot()
        state.focused = false
        state.visible = false
        state.closed = true
        post('/dsh-desktop-notify/focus', state, true)
      }

      function onVisibility() {
        reportNow()
      }

      function onFocus() {
        reportNow()
      }

      function onBlur() {
        reportNow()
      }

      // Toast click runs the custom-protocol helper, which POSTs the session id
      // to the host. This already-open page polls for it and switches; no new
      // browser tab is created. Resolve `uiWorkspace` lazily: the service may
      // activate after this entry applies.
      function openSession(sessionId, attempt) {
        var tries = attempt || 0
        try {
          var workspace = ctx.get && ctx.get('uiWorkspace')
          if (workspace && typeof workspace.openSession === 'function') {
            workspace.openSession(sessionId)
            return true
          }
          var sessions = ctx.get && ctx.get('sessions')
          if (sessions && typeof sessions.open === 'function') {
            sessions.open(sessionId)
            return true
          }
        } catch (error) { /* keep retrying */ }
        if (tries < 40) {
          window.setTimeout(function () { openSession(sessionId, tries + 1) }, 250)
        }
        return false
      }

      var activationBusy = false
      var OPEN_KEY = 'dsh-desktop-notify:open'

      // 兜底新页的引导脚本会把会话 id 写入 localStorage，然后跳回 DSH；
      // 新页面加载到这里时读取并打开对应对话。
      function openPendingFromStorage() {
        try {
          var raw = window.localStorage.getItem(OPEN_KEY)
          if (!raw) return
          window.localStorage.removeItem(OPEN_KEY)
          var data = JSON.parse(raw)
          if (data && data.sessionId) {
            window.setTimeout(function () {
              openSession(data.sessionId, 0)
              try { window.focus() } catch (error) { /* ignore */ }
            }, 0)
          }
        } catch (error) { /* a malformed hint must not break the page */ }
      }

      function pollActivation() {
        if (disposed || activationBusy) return
        activationBusy = true
        fetch('/dsh-desktop-notify/activation?id=' + encodeURIComponent(clientId), { cache: 'no-store' })
          .then(function (response) { return response.json() })
          .then(function (value) {
            if (value && value.sessionId) {
              openSession(value.sessionId, 0)
              try { window.focus() } catch (error) { /* ignore */ }
            }
          })
          .catch(function () {})
          .then(function () { activationBusy = false })
      }

      var timer = window.setInterval(report, 3000)
      var activationTimer = window.setInterval(pollActivation, 1000)

      window.addEventListener('focus', onFocus, true)
      window.addEventListener('blur', onBlur, true)
      window.addEventListener('pagehide', onPageHide, true)
      window.addEventListener('beforeunload', onPageHide, true)
      document.addEventListener('visibilitychange', onVisibility, true)

      // 首次上报：让 host 立刻知道这个页面的焦点状态
      reportNow()
      pollActivation()
      openPendingFromStorage()
      try {
        window.__dshDesktopNotify = { openSession: openSession, snapshot: snapshot }
      } catch (error) { /* ignore */ }

      ctx.effect(function () {
        return function () {
          disposed = true
          window.clearInterval(timer)
          window.clearInterval(activationTimer)
          window.removeEventListener('focus', onFocus, true)
          window.removeEventListener('blur', onBlur, true)
          window.removeEventListener('pagehide', onPageHide, true)
          window.removeEventListener('beforeunload', onPageHide, true)
          document.removeEventListener('visibilitychange', onVisibility, true)
          var state = snapshot()
          state.focused = false
          state.visible = false
          state.closed = true
          try {
            if (navigator.sendBeacon) {
              navigator.sendBeacon('/dsh-desktop-notify/focus', new Blob([JSON.stringify(state)], { type: 'application/json' }))
            }
          } catch (error) { /* ignore */ }
        }
      }, 'dsh-desktop-notify: focus reporter')

      ctx.effect(function () {
        return ctx.slots.inject('settings.general.item', function () {
          return ctx.slots.register({
            name: 'settings.general.item',
            id: 'dsh-desktop-notify',
            order: 95,
          }, NotifySettingsRow)
        })
      }, 'dsh-desktop-notify: settings row')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
