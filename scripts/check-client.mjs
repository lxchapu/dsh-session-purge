// 快速校验：前端 bundle 仍然注册成功，且 factory 能在桩依赖下执行。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'

const root = dirname(import.meta.dirname)
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

let registered = null
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { registered = entry } }, localStorage: { getItem: () => null } },
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
}
createContext(sandbox)
runInContext(source, sandbox)

assert.ok(registered !== null, '客户端 bundle 没有调用 __ModuleLoader__.load')
// 必须等于包名：DSH 的 loader row id 就是包 specifier（带 scope）。
assert.equal(registered.id, '@lxchapu/dsh-session-purge')

const element = (type, props) => ({ type, props })
const exports_ = registered.factory((name) => {
  if (name === 'react') return { useState: (v) => [v, () => {}], useEffect: () => undefined }
  if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: function Fragment() {} }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return { MenuItemButton: function MenuItemButton() {}, IconTrashOutlineRegular: function Trash() {} }
  }
  throw new Error(`意外的依赖请求: ${name}`)
})

assert.equal(typeof exports_.apply, 'function')
assert.deepEqual([...exports_.inject].sort(), ['locale', 'sessions', 'slots', 'workspaces'])

const slots = []
const ctx = {
  effect: (factory) => {
    factory()
  },
  locale: { register: () => () => {} },
  workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }), subscribe: () => () => {} } },
  sessions: { handleSessionRemoved: () => {} },
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      slots.push({ key: options.name, id: options.id, options, component })
      return () => {}
    },
  },
}
exports_.apply(ctx)

const ids = slots.map((s) => s.id).sort()
assert.deepEqual(ids, [
  'session-purge.confirm',
  'session-purge.delete',
  'session-purge.delete-all',
  'session-purge.toast',
])
assert.equal(slots.length, 4)

// 菜单项要在普通行与归档行上都渲染，并且用官方 MenuItemButton。
const menu = slots.find((s) => s.id === 'session-purge.delete')
const props = {
  sessionId: 'session-x',
  displayTitle: 'X',
  useMenuOpenState: () => [false, () => {}],
  requestPurge: () => {},
  t: undefined,
}
const rendered = menu.component({ ...props, useArchived: (sel) => sel(new Set()) })
assert.ok(rendered !== null, '菜单项必须在普通会话行上渲染')
assert.equal(rendered.type.name, 'MenuItemButton')
assert.equal(rendered.props.danger, true)

// 批量按钮：仅 “only” 时出现，且不含角标。
const bulk = slots.find((s) => s.id === 'session-purge.delete-all')
const bulkProps = { wide: true, requestPurge: () => {}, t: undefined }
assert.equal(bulk.component({ ...bulkProps, useArchivedFilter: (sel) => sel('default') }), null)
assert.equal(bulk.component({ ...bulkProps, useArchivedFilter: (sel) => sel('show') }), null)
const shown = bulk.component({ ...bulkProps, useArchivedFilter: (sel) => sel('only') })
assert.ok(shown !== null, '批量按钮必须在“仅显示已归档”时出现')
assert.ok(!JSON.stringify(shown).toLowerCase().includes('badge'), '批量按钮不应再有角标')

// 失败提示必须把原因说出来（0.1.1 之前原因被存进 toast.message 却从未渲染）。
const toastSlot = slots.find((s) => s.id === 'session-purge.toast')
assert.ok(toastSlot !== undefined, '提示条插槽必须注册')
const toastText = (state) => {
  const node = toastSlot.component({
    usePurgeToast: (selector) => selector(state),
    dismissPurgeToast: () => {},
    t: undefined,
  })
  return node === null ? '' : String(node.props.children)
}

// 活跃会话被拒：按错误码本地化，用户能看到该怎么做。
const refused = toastText({
  kind: 'failed',
  deleted: 0,
  failed: 1,
  code: 'session-still-running',
  message: 'the session is busy running a turn; stop it before deleting it permanently',
})
assert.ok(refused.includes('正在跑'), `正在跑的会话被拒时要显示可读原因，实际：${refused}`)
assert.ok(!refused.includes('still running'), `本地化之后不应再露出宿主英文原文，实际：${refused}`)
assert.ok(!refused.includes('归档'), `拒绝原因不应再让用户去归档（归档并不释放驻留），实际：${refused}`)

// 未登记的码退回宿主原文，原因不能被吞掉。
const unknown = toastText({ kind: 'failed', deleted: 0, failed: 1, message: 'remove-log: EPERM' })
assert.ok(unknown.includes('EPERM'), `未登记的错误码要露出宿主原文，实际：${unknown}`)

// 部分成功：数量和原因都要报。
const partial = toastText({ kind: 'partial', deleted: 2, failed: 1, message: 'remove-log: EBUSY' })
assert.ok(
  partial.includes('2') && partial.includes('EBUSY'),
  `部分成功要同时报数量和原因，实际：${partial}`,
)

console.log('client.js 校验通过：注册正常，4 个插槽齐全，两个入口显隐正确，失败提示会说出原因')
