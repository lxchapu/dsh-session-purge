/**
 * dsh-session-purge —— 前端半。
 *
 * 补上官方侧边栏缺失的彻底删除入口：
 *
 *   - `sidebar.workspaces.session.menu.item` —— **每条**会话「…」菜单里的
 *     「彻底删除…」，复用官方那几行（pin / rename / fork / archive）所用的同一个
 *     `MenuItemButton` 渲染，所以除了 `danger` 破坏性配色之外视觉完全一致；
 *   - `sidebar.footer.action` —— 设置按钮旁边的批量「彻底删除全部已归档会话」按钮，
 *     **只在侧边栏筛选切到「仅显示已归档」时**出现。那一刻屏幕上列出的就是归档集合本身，
 *     所以按钮的范围与用户正看着的列表严丝合缝。
 *
 * 两者都先通过本插件自己的 store 和一个 `shell.overlay` 条目弹出二次确认框；在按下对话框
 * 里那个破坏性按钮之前，什么都不会被删。真正的删除由宿主半负责，经 `/session-purge/api`
 * 路由完成。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 宿主半注册的前缀路由。 */
    const API = '/session-purge/api'

    /**
     * 侧边栏浏览器的持久化视图 store，以及本插件只读其中一项：归档行筛选。该 store 归
     * ui-workspace 所有，每次变化都把整份状态写进 localStorage，所以这里通过那个键观察筛选
     * 状态——这是第三方插件能接触到「别人拥有的 store 实例」的唯一通道。
     */
    const VIEW_STORE_KEY = 'dsh.workspace.view.v5'
    const ARCHIVED_ONLY = 'only'

    /** 语言命名空间；`zh` 是键集的真源。 */
    const NS = 'sessionPurge'

    const zh = {
      'menu.delete': '彻底删除…',
      'menu.deleteTitle': '彻底删除「{title}」',
      'bulk.button': '彻底删除全部已归档会话',
      'dialog.delete.title': '彻底删除会话',
      'dialog.delete.desc':
        '「{title}」的对话记录将从磁盘上被永久删除。该会话未归档，删除后没有恢复入口，此操作不可撤销。',
      'dialog.delete.archived.desc':
        '「{title}」的对话记录将从磁盘上被永久删除，无法通过取消归档恢复。此操作不可撤销。',
      'dialog.deleteAll.title': '彻底删除全部已归档会话',
      'dialog.deleteAll.desc':
        '将永久删除当前归档的全部 {count} 条会话的对话记录，无法通过取消归档恢复。此操作不可撤销。',
      'dialog.pending': '正在删除…',
      'dialog.cancel': '取消',
      'dialog.confirm': '确认彻底删除',
      'toast.deleted': '已彻底删除 {count} 条会话',
      'toast.partial': '已删除 {deleted} 条，{failed} 条失败',
      'toast.failed': '彻底删除失败：{message}',
    }

    const en = {
      'menu.delete': 'Delete permanently…',
      'menu.deleteTitle': 'Permanently delete “{title}”',
      'bulk.button': 'Delete all archived sessions',
      'dialog.delete.title': 'Delete session permanently',
      'dialog.delete.desc':
        '“{title}” will be erased from disk. It was never archived, so there is no restore path — this cannot be undone.',
      'dialog.delete.archived.desc':
        '“{title}” will be erased from disk. Unarchiving cannot bring it back — this cannot be undone.',
      'dialog.deleteAll.title': 'Delete all archived sessions permanently',
      'dialog.deleteAll.desc':
        'All {count} archived sessions currently listed will be erased from disk. Unarchiving cannot bring them back — this cannot be undone.',
      'dialog.pending': 'Deleting…',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'toast.deleted': 'Permanently deleted {count} session(s)',
      'toast.partial': 'Deleted {deleted}, failed {failed}',
      'toast.failed': 'Permanent delete failed: {message}',
    }

    /** 用 `{name}` 占位符格式化一条语言条目。 */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (_match, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : `{${name}}`,
      )
    }

    /** 通过命名空间座位翻译一个键；拿不到座位时回退到 `zh` 模板。 */
    function translate(t, key, values) {
      if (typeof t === 'function') {
        return values === undefined ? t(key) : t(key, values)
      }
      const template = zh[key] ?? key
      return values === undefined ? template : format(template, values)
    }

    /** 读取侧边栏的归档筛选值；键缺失或损坏时按默认值处理。 */
    function readArchivedFilter() {
      try {
        const raw = window.localStorage?.getItem(VIEW_STORE_KEY)
        if (raw === null || raw === undefined) return 'default'
        const parsed = JSON.parse(raw)
        const filter = parsed?.archivedFilter
        return typeof filter === 'string' ? filter : 'default'
      } catch {
        return 'default'
      }
    }

    /**
     * 一个架在侧边栏归档筛选之上的 store。ui-workspace 没有为自己的视图 store 暴露任何
     * observable，所以这里以低频轮询读取：切换筛选是一个刻意且罕见的动作，以这个频率读一个
     * 很小的 localStorage 键，远比它所控制的那次渲染便宜。快照就是筛选字符串本身，所以订阅
     * 者只会在真正变化时被叫醒。
     */
    function createArchivedFilterStore() {
      let value = readArchivedFilter()
      const listeners = new Set()
      let timer
      const tick = () => {
        const next = readArchivedFilter()
        if (next === value) return
        value = next
        for (const listener of [...listeners]) listener()
      }
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          if (timer === undefined) timer = setInterval(tick, 600)
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && timer !== undefined) {
              clearInterval(timer)
              timer = undefined
            }
          }
        },
      }
    }

    /**
     * 一个最小快照 store：就是插槽渲染器绑成 `use<Name>(selector)` 钩子所需要的形状
     * （`getSnapshot` + `subscribe`，两次写入之间保持身份稳定，通知按微任务批处理）。
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      let scheduled = false
      const notify = () => {
        scheduled = false
        for (const listener of [...listeners]) listener()
      }
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (Object.is(next, value)) return
          value = next
          if (scheduled) return
          scheduled = true
          queueMicrotask(notify)
        },
      }
    }

    /** 调用宿主半并拆开它的 JSON 信封。 */
    async function callApi(method, body) {
      const response = await fetch(`${API}/${method}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`session-purge: ${String(response.status)} ${response.statusText}`)
      }
      if (payload?.ok !== true) {
        throw new Error(payload?.error ?? `session-purge: ${String(response.status)}`)
      }
      return payload
    }

    /** 本插件自己持有的内联样式；所有颜色都取自主题 token。 */
    const styles = {
      footerButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        height: '28px',
        maxWidth: '100%',
        padding: '0 8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        font: 'inherit',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      footerLabel: { overflow: 'hidden', textOverflow: 'ellipsis' },
      backdrop: {
        position: 'fixed',
        inset: '0',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.42)',
      },
      dialog: {
        boxSizing: 'border-box',
        width: 'min(440px, calc(100vw - 32px))',
        padding: '18px 20px 16px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
      },
      title: { margin: '0 0 8px', fontSize: '15px', fontWeight: 600 },
      desc: {
        margin: '0 0 14px',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'pre-wrap',
      },
      status: { margin: '0 0 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      error: { margin: '0 0 12px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
      button: {
        height: '30px',
        padding: '0 14px',
        borderRadius: '8px',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      cancel: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      confirm: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      toast: {
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 70,
        maxWidth: 'min(560px, calc(100vw - 32px))',
        padding: '10px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.24)',
      },
    }

    /**
     * 某条会话的菜单行，每一行都提供。它通过官方的 `MenuItemButton` 渲染，因而继承菜单
     * 自己的行样式，并直接申请那一行的破坏性配色，而不是去模仿。
     */
    function PurgeMenuItem({ sessionId, displayTitle, useArchived, useMenuOpenState, requestPurge, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const archived = useArchived((set) => set.has(sessionId))
      const label = translate(t, 'menu.delete')
      return jsx(primitives.MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          requestPurge({ kind: 'one', sessionId, displayTitle, archived })
        },
        children: label,
      })
    }

    /**
     * 设置按钮旁边那个批量操作。它只在侧边栏「仅显示已归档」时存在——也就是归档集合与可见
     * 列表完全同一的那一刻。不带数量角标：按钮已经说清它删什么，条数由确认框给出。
     */
    function PurgeBulkButton({ wide, useArchivedFilter, requestPurge, t }) {
      const filter = useArchivedFilter((value) => value)
      if (filter !== ARCHIVED_ONLY) return null
      const label = translate(t, 'bulk.button')
      return jsx('button', {
        type: 'button',
        style: styles.footerButton,
        'aria-label': label,
        title: label,
        onClick: () => requestPurge({ kind: 'all' }),
        children: jsxs(Fragment, {
          children: [
            jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
            wide === true ? jsx('span', { style: styles.footerLabel, children: label }) : null,
          ],
        }),
      })
    }

    /**
     * 确认对话框：东西被销毁之前的第二道闸门。一次只处理一个请求，并以请求自身身份作为
     * key，所以进行中的状态和错误状态永远不会泄漏到下一个请求里。
     */
    function PurgeConfirmDialog({ usePurgeRequest, settlePurge, runPurge, useArchivedCount, t }) {
      const request = usePurgeRequest((pending) => pending)
      const archivedCount = useArchivedCount((count) => count)
      if (request === null) return null
      return jsx(PurgeConfirmForm, {
        key: request.kind === 'one' ? request.sessionId : 'all',
        request,
        archivedCount,
        runPurge,
        onSettle: settlePurge,
        t,
      })
    }

    function PurgeConfirmForm({ request, archivedCount, runPurge, onSettle, t }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const close = () => {
        if (busy) return
        onSettle()
      }
      const confirm = () => {
        setBusy(true)
        setError(null)
        runPurge(request)
          .then(() => {
            setBusy(false)
            onSettle()
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          })
      }
      const isAll = request.kind === 'all'
      const description = isAll
        ? translate(t, 'dialog.deleteAll.desc', { count: archivedCount })
        : translate(t, request.archived ? 'dialog.delete.archived.desc' : 'dialog.delete.desc', {
            title: request.displayTitle ?? request.sessionId ?? '',
          })
      return jsx('div', {
        style: styles.backdrop,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close()
        },
        children: jsxs('div', {
          style: styles.dialog,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': translate(t, isAll ? 'dialog.deleteAll.title' : 'dialog.delete.title'),
          children: [
            jsx('h2', {
              style: styles.title,
              children: translate(t, isAll ? 'dialog.deleteAll.title' : 'dialog.delete.title'),
            }),
            jsx('p', { style: styles.desc, children: description }),
            busy
              ? jsx('div', { style: styles.status, role: 'status', children: translate(t, 'dialog.pending') })
              : null,
            error === null ? null : jsx('div', { style: styles.error, role: 'alert', children: error }),
            jsxs('div', {
              style: styles.footer,
              children: [
                jsx('button', {
                  type: 'button',
                  style: { ...styles.button, ...styles.cancel },
                  disabled: busy,
                  onClick: close,
                  children: translate(t, 'dialog.cancel'),
                }),
                jsx('button', {
                  type: 'button',
                  style: { ...styles.button, ...styles.confirm },
                  disabled: busy,
                  onClick: confirm,
                  children: translate(t, 'dialog.confirm'),
                }),
              ],
            }),
          ],
        }),
      })
    }

    /** 一次删除完成后弹出的临时提示。 */
    function PurgeToast({ usePurgeToast, dismissPurgeToast, t }) {
      const toast = usePurgeToast((current) => current)
      React.useEffect(() => {
        if (toast === null) return undefined
        const handle = setTimeout(dismissPurgeToast, 6000)
        return () => {
          clearTimeout(handle)
        }
      }, [toast, dismissPurgeToast])
      if (toast === null) return null
      const text =
        toast.kind === 'failed'
          ? translate(t, 'toast.failed', { message: toast.message })
          : toast.failed > 0
            ? translate(t, 'toast.partial', { deleted: toast.deleted, failed: toast.failed })
            : translate(t, 'toast.deleted', { count: toast.deleted })
      return jsx('div', { style: styles.toast, role: 'status', children: text })
    }

    /** 前端半需要的客户端服务。 */
    const inject = ['slots', 'locale', 'workspaces', 'sessions']

    /**
     * 把已删除的会话从客户端自己的列表里摘掉。
     *
     * 宿主清理客户端会话列表靠的是发 `api-session/removed`，而它只在 `session/disposed`
     * 时发出——在更早的进程里就已经停止的会话永远不会触发它。于是删掉一条会话之后，它的 id
     * 已经不在任何 Workspace 的 `sessionIds` 里，客户端列表却还留着它，侧边栏便会把它重新
     * 归到「未分组」，点开还会报 `session/not-found`。调用 Remote 事件本来会调用的同一个入口
     * 就能补上这个缺口。
     */
    function pruneDeletedSessions(sessions, results) {
      if (sessions === undefined || sessions === null) return
      const remove = sessions.handleSessionRemoved
      if (typeof remove !== 'function') return
      for (const row of results) {
        if (row?.deleted !== true) continue
        try {
          remove.call(sessions, row.sessionId)
        } catch (error) {
          // 列表清理失败不能让一次已经落盘的删除被掩盖过去；下一次列表基线拉取会重新推导。
          console.warn('session-purge: pruning a deleted session from the client list failed:', error)
        }
      }
    }

    /**
     * 装载插件：语言字典、确认框与提示条两个 store、两个入口，以及为它们把关的 overlay。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-purge: dictionaries')

      const purgeRequest = createStore(null)
      const purgeToast = createStore(null)
      const archivedFilter = createArchivedFilterStore()
      const workspaceList = ctx.workspaces.list

      /** 宿主确认过的归档集合，通过共享的工作区模型观察。 */
      const archivedSet = {
        getSnapshot() {
          const ids = workspaceList.getSnapshot().archivedSessionIds
          return new Set(Array.isArray(ids) ? ids.map(String) : [])
        },
        subscribe: (listener) => workspaceList.subscribe(listener),
      }

      // 从同一个模型派生，所以只有工作区快照真的换了身份时才重新算计数。
      let seenSnapshot
      let seenCount = 0
      const archivedCount = {
        getSnapshot() {
          const snapshot = workspaceList.getSnapshot()
          if (snapshot !== seenSnapshot) {
            seenSnapshot = snapshot
            seenCount = Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds.length : 0
          }
          return seenCount
        },
        subscribe: (listener) => workspaceList.subscribe(listener),
      }

      const requestPurge = (request) => {
        purgeRequest.set(request)
      }

      const settlePurge = () => {
        purgeRequest.set(null)
      }

      const dismissPurgeToast = () => {
        purgeToast.set(null)
      }

      /**
       * 执行一次已确认的删除。破坏性工作归宿主所有；这里负责把已删的行从客户端自己的列表
       * 里摘掉，然后报告结果。
       */
      const runPurge = async (request) => {
        const payload =
          request.kind === 'all'
            ? await callApi('delete-all', {})
            : await callApi('delete', { sessionId: request.sessionId })
        pruneDeletedSessions(ctx.sessions, Array.isArray(payload.results) ? payload.results : [])
        purgeToast.set({
          kind: payload.failed > 0 ? 'partial' : 'done',
          deleted: payload.deleted ?? 0,
          failed: payload.failed ?? 0,
          message: Array.isArray(payload.warnings) && payload.warnings.length > 0 ? payload.warnings[0] : '',
        })
      }

      // 行内操作：一个菜单条目，每条会话行都提供。
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-purge.delete',
            order: 500,
            locale: NS,
            inject: () => ({
              hooks: { archived: archivedSet },
              requestPurge,
            }),
          },
          PurgeMenuItem,
        ),
      )

      // 批量操作：侧边栏底部，以「仅显示已归档」筛选为开关。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'session-purge.delete-all',
            order: 100,
            locale: NS,
            inject: () => ({
              hooks: { archivedFilter },
              requestPurge,
            }),
          },
          PurgeBulkButton,
        ),
      )

      // 确认框，浮在所有列之上。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'session-purge.confirm',
            locale: NS,
            inject: () => ({
              hooks: { purgeRequest, archivedCount },
              settlePurge,
              runPurge,
            }),
          },
          PurgeConfirmDialog,
        ),
      )

      // 结果提示。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'session-purge.toast',
            locale: NS,
            inject: () => ({ hooks: { purgeToast }, dismissPurgeToast }),
          },
          PurgeToast,
        ),
      )
    }

    return { apply, inject, name: 'dsh-session-purge' }
  },
})
