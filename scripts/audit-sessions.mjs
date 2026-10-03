// DSH 会话状态只读对账：把任何持久化存储里出现过的会话身份全部收集起来，
// 与磁盘上真实存在的日志目录交叉核对。
//
// 用法：node scripts/audit-sessions.mjs [DSH 主目录]
// 主目录省略时按 DSH_HOME 环境变量取，再退到 ~/.dsh。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH = process.argv[2] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(DSH, 'sessions')
const STORAGES = join(DSH, 'storages')

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

console.log(`DSH 主目录: ${DSH}`)

// --- 1. 磁盘上每一个会话日志目录 -------------------------------------------
/** @type {Map<string, {project: string, dir: string, files: string[]}>} */
const logs = new Map()
for (const project of existsSync(SESSIONS) ? readdirSync(SESSIONS) : []) {
  const projectDir = join(SESSIONS, project)
  if (!statSync(projectDir).isDirectory()) continue
  for (const entry of readdirSync(projectDir)) {
    const dir = join(projectDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd') || f.endsWith('.lock'))
    logs.set(entry, { project, dir, files })
  }
}
console.log(`=== 1. 磁盘上的会话日志目录: ${logs.size} ===`)
for (const [id, info] of logs) console.log(`  ${id}  [${info.project}]  ${info.files.join(', ') || '(无日志文件)'}`)

// --- 2. 工作区注册表 -------------------------------------------------------
const workspace = readJson(join(STORAGES, 'workspace.json'))
const accounted = new Map() // sessionId -> workspaceId
for (const [wid, record] of Object.entries(workspace?.tables?.workspaces ?? {})) {
  for (const sid of record.sessionIds ?? []) accounted.set(sid, wid)
}
const archived = new Set(workspace?.global?.archivedSessionIds ?? [])
const pinned = new Set(workspace?.global?.pinnedSessionIds ?? [])
console.log(`\n=== 2. 工作区注册表 ===`)
console.log(`  工作区数量: ${(workspace?.global?.workspaceIds ?? []).length}`)
for (const [wid, record] of Object.entries(workspace?.tables?.workspaces ?? {})) {
  console.log(`  ${wid}  ${record.path}`)
  for (const sid of record.sessionIds ?? []) console.log(`      记账: ${sid}`)
}
console.log(`  归档: ${archived.size ? [...archived].join(', ') : '(无)'}`)
console.log(`  置顶: ${pinned.size ? [...pinned].join(', ') : '(无)'}`)

// --- 3. 投影缓存 -----------------------------------------------------------
/** @type {Map<string, {source: string, cwd?: string}>} */
const cached = new Map()
const addCache = (source, id, cwd) => {
  if (typeof id !== 'string' || id.length === 0) return
  const prev = cached.get(id)
  if (prev === undefined) cached.set(id, { source, cwd })
  else cached.set(id, { source: `${prev.source}, ${source}`, cwd: prev.cwd ?? cwd })
}

// 3a. 每条记录一个的 sidecar：<unit>/<table>/<key>.json
for (const unit of existsSync(STORAGES) ? readdirSync(STORAGES) : []) {
  const unitDir = join(STORAGES, unit)
  if (!statSync(unitDir).isDirectory()) continue
  for (const table of readdirSync(unitDir)) {
    const tableDir = join(unitDir, table)
    if (!statSync(tableDir).isDirectory()) continue
    for (const file of readdirSync(tableDir)) {
      if (!file.endsWith('.json')) continue
      const record = readJson(join(tableDir, file))
      const id = record?.record?.sessionId ?? file.replace(/\.json$/, '')
      addCache(`${unit}/${table}`, id, record?.record?.identity?.cwd)
    }
  }
}

// 3b. 根目录下以会话为键的表或数组。workspace.json 的表按 workspaceId 作键，第 2 节
// 已经单独读过，这里跳过以免把工作区 id 误报成会话身份。
for (const file of existsSync(STORAGES) ? readdirSync(STORAGES) : []) {
  if (!file.endsWith('.json') || file === 'workspace.json') continue
  const doc = readJson(join(STORAGES, file))
  if (doc === undefined) {
    console.log(`  [警告] 无法解析的存储文件: ${file}`)
    continue
  }
  for (const table of Object.values(doc.tables ?? {})) {
    for (const [key, value] of Object.entries(table ?? {})) {
      addCache(file, value?.sessionId ?? key, value?.identity?.cwd)
    }
  }
}
console.log(`\n=== 3. 持有会话身份的投影/持久化存储: ${cached.size} ===`)
for (const [id, info] of cached) console.log(`  ${id}  <- ${info.source}`)

// --- 4. 交叉核对 -----------------------------------------------------------
const all = new Set([...logs.keys(), ...accounted.keys(), ...archived, ...cached.keys()])
console.log(`\n=== 4. 对 ${all.size} 个不同身份做交叉核对 ===`)
const problems = []
for (const id of [...all].sort()) {
  const hasLog = logs.has(id)
  const inAccount = accounted.get(id)
  const isArchived = archived.has(id)
  const inCache = cached.get(id)
  const notes = []
  if (!hasLog) notes.push('磁盘上没有日志')
  if (inAccount === undefined && !isArchived) notes.push('既未记账也未归档')
  if (isArchived && !hasLog) notes.push('已归档但日志已消失')
  if (inAccount !== undefined && !hasLog) notes.push('已记账但日志已消失')
  if (inCache && !hasLog) notes.push(`有缓存条目但没有日志（${inCache.source}）`)
  if (notes.length > 0) problems.push({ id, notes })
  console.log(
    `  ${id}  日志=${hasLog ? '有' : '无'}  工作区=${inAccount ?? '-'}  归档=${isArchived ? '是' : '-'}${
      notes.length ? `   <-- ${notes.join('；')}` : ''
    }`,
  )
}

// --- 5. 旧版单文件投影缓存的内容 -------------------------------------------
const legacy = readJson(join(STORAGES, 'session_projcache.json'))
const legacyIds = Object.keys(legacy?.tables?.sessions ?? {})
console.log(`\n=== 5. 旧版单文件投影缓存: ${legacyIds.length} 条 ===`)
for (const id of legacyIds) {
  const hasLog = logs.has(id)
  console.log(`  ${id}  日志=${hasLog ? '有' : '无'}${hasLog ? '' : '   <-- 陈旧条目'}`)
}

console.log(`\n=== 汇总 ===`)
console.log(`  磁盘上存活的会话 : ${logs.size}`)
console.log(`  工作区已记账     : ${accounted.size}`)
console.log(`  已归档           : ${archived.size}`)
console.log(`  缓存身份         : ${cached.size}`)
console.log(`  问题项           : ${problems.length}`)
for (const p of problems) console.log(`    - ${p.id}: ${p.notes.join('；')}`)
