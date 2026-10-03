// 宿主半判活的离线回归：一个 id 只因为「进程里驻留着它」而被判成不可删，正是 0.1.1 的
// 那次故障（已归档、已关闭的会话都被挡住）。这里把闸门的三种输入形态固定下来。
//
// 用法：node scripts/check-host.mjs
import assert from 'node:assert/strict'

const { isSessionRunning } = await import('../lib/index.js')

const agentsWith = (entries) => ({ get: (id) => entries[id] })
const sessionsWith = (ids) => ({ get: (id) => (ids.includes(id) ? { id } : undefined) })

// 1. 驻留但不跑：这是故障的核心——打开过、归档过的会话都长这样，必须放行。
assert.equal(
  isSessionRunning(agentsWith({ a: { status: 'idle' } }), sessionsWith(['a']), 'a'),
  false,
  '驻留且 idle 的 Agent 不是「在跑」，必须允许删除',
)

// 2. 正在跑一轮（含等待审批 / 卡在工具里，宿主都用 running 表示）：必须拦住。
assert.equal(
  isSessionRunning(agentsWith({ b: { status: 'running' } }), sessionsWith(['b']), 'b'),
  true,
  'Agent 在跑时必须拒绝删除',
)

// 3. 进程里没有任何驻留（冷会话、或日志已消失的陈旧 id）：放行。
assert.equal(isSessionRunning(agentsWith({}), sessionsWith([]), 'c'), false, '未知会话必须放行')
assert.equal(isSessionRunning(agentsWith({}), sessionsWith(['c']), 'c'), false, '没有 Agent 就不算在跑')

// 4. 没有 Agent 注册表时退回驻留判定：过于保守，但方向安全（不会放走正在跑的）。
assert.equal(
  isSessionRunning(undefined, sessionsWith(['d']), 'd'),
  true,
  '缺少 agents 服务时应保守地拦住驻留会话',
)
assert.equal(isSessionRunning({}, sessionsWith(['e']), 'e'), true, 'agents 没有 get() 时同样退回驻留判定')
assert.equal(isSessionRunning(undefined, sessionsWith([]), 'f'), false, '没有驻留就放行')

// 5. get() 抛错时由调用方包成 { unknown }（这里只确认异常会冒出来，不被吞掉）。
const throwing = {
  get: () => {
    throw new Error('registry exploded')
  },
}
assert.throws(() => isSessionRunning(throwing, sessionsWith(['g']), 'g'), /registry exploded/)

console.log('index.js 判活校验通过：驻留 ≠ 在跑，只有 status === "running" 才拒绝')
