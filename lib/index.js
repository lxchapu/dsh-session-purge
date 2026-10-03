/**
 * dsh-session-purge —— 宿主半。
 *
 * DSH 只能「归档」会话，永远删不掉它：持久化层没有删除接口，工作区注册表也只是把
 * 会话从分组界面隐藏起来。本插件补上这个缺失的能力。
 *
 * 一次彻底删除按下面的顺序做四件事：
 *
 *   1. 把该 id 从所属 Workspace 的记账（`sessionIds`）里摘掉，侧边栏不再为它保留位置；
 *   2. 把该 id 从注册表全局归档集合里移除（`unarchiveSession`）；
 *   3. 删除磁盘上的会话日志目录（`<持久化根>/<项目目录>/<id>`），全部保留的格式代际
 *      都在里面；
 *   4. 把该 id 从投影缓存以及 `<dsh home>/storages` 下其它任何提到它的持久化文件里清除。
 *
 * 第 1、2 步刻意排在最前：万一进程在中途退出，结果只会是「看不见但仍可删」，而不会
 * 留下一个指向已消失日志的工作区条目。
 *
 * 唯一会拒绝的情况是**活跃**会话：仍发布在 `ctx.sessions` 里的 agent 会被报成错误，
 * 而不是从它自己的轮次底下被抽走。归档会话按定义就是停止状态，所以这条只会对用户正在
 * 使用的未归档会话生效。
 *
 * 对外暴露的 HTTP 面是一条前缀路由 `/session-purge/api`：
 *
 *   GET  /session-purge/api/status          -> { archivedSessionIds }
 *   POST /session-purge/api/delete          -> { sessionId }   （任意会话）
 *   POST /session-purge/api/delete-all      -> 整个归档集合
 */
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 本插件占用的路由前缀。 */
export const ROUTE_PREFIX = '/session-purge/api'

/**
 * 构建标记，由 `status` 原样回显。DSH 会在进程存活期间缓存宿主模块，就地改动在应用
 * 重启前不可见；调用方靠这个字符串判断当前实际运行的到底是哪一版代码。
 */
export const BUILD = '2026-09-30.any-session'

/**
 * 挂载前必须就绪的宿主服务。`sessions` 是活跃 Agent 注册表：没有它，「这条会话是否仍在
 * 运行」这道闸门就会静默放行一切，所以它是硬依赖而不是可选探测。
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** DSH 主目录：profile 的持久化根，与运行时自身的解析保持一致。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** `<dsh home>/storages` 根，投影缓存与各类持久化 store 都在其下。 */
function storagesRoot() {
  return join(dshHome(), 'storages')
}

/**
 * 本插件关心的投影缓存：每条记录一个的 sidecar 目录、它的旧版单文件形态，以及两者共同
 * 所在的根。存储域后端按 `<unit>/<table>/<key>.json` 一条记录一个文件；更早的安装把整
 * 张表放在根目录下的一个 `.json` 里。两种都要清理。
 */
function projectionCacheDirs() {
  const root = storagesRoot()
  return {
    root,
    sidecar: join(root, 'session_projcache'),
    legacy: join(root, 'session_projcache.json'),
  }
}

/** 用一个 JSON 响应体回应请求。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读取并 JSON 解析一个请求体，空请求体按空对象处理。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** 判断一个值是否为普通对象（非数组、非 null）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析某条会话日志代际所在的磁盘目录。
 *
 * 首选来源是持久化层自身：`stat(id)` 报出存储的头记录，它的 `cwd` 能推导出后端实际使用
 * 的那个项目目录。注册表自己的会话路径索引和投影缓存作为回退，最后再退到一次浅层目录
 * 扫描——这样即便头记录已经读不出来，会话仍然可被删除。
 *
 * @returns 绝对目录路径；没有任何线索指向它时返回 undefined。
 */
async function resolveSessionDir(runtime, sessionId) {
  const candidates = []
  const push = (cwd) => {
    if (typeof cwd === 'string' && cwd !== '') candidates.push(cwd)
  }

  if (runtime.root !== undefined) {
    try {
      const snapshot = await runtime.persistence.stat(sessionId)
      push(snapshot?.header?.cwd)
    } catch {
      // 头记录读不出来或压根不存在，对一条已经损坏的会话来说很正常；交给其余来源决定。
    }
    try {
      push(runtime.registry.sessionPaths?.get?.(sessionId))
    } catch {
      // 注册表的索引属于内部细节；结构一变就静默跳过。
    }
    push(await runtime.cachedCwd(sessionId))

    for (const cwd of candidates) {
      const project = projectDirectory(runtime.root, cwd)
      const dir = join(project, encodeSegment(sessionId))
      if (await isDirectory(dir)) return dir
    }
  }

  return await scanForSessionDir(runtime.scanRoots, sessionId)
}

/**
 * 会话后端从 cwd 推导出来的、方便人读的项目目录名。路径分隔符与盘符冒号按「连续一段
 * 折成一个 `-`」处理，`~` 以及所有不属于 `[A-Za-z0-9._-]` 的码元变成 4 位大写
 * `~XXXX` 转义，开头的分隔符被去掉，主体长度按文件系统组件上限截断，最后整体用
 * `--…--` 包起来。
 *
 * 这里是重新实现而不是 import：后端没有导出任何路径辅助函数，而插件必须和它实际写出
 * 的那个目录名对齐。`cwd === undefined` 对应后端的 `_no-cwd` 桶。
 */
function projectDirectory(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

/** 为一个 cwd 构造可读的项目目录键（见 {@link projectDirectory}）。 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
      continue
    }
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
      continue
    }
    readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    separatorRun = false
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 把一个任意字符串编码成单个安全的路径片段，与会话后端的做法完全一致：安全码元原样保留，
 * 其余一切——包括 `~` 自己——都变成 4 位大写 `~XXXX` 转义。`.` 与 `..` 单独特判，
 * 免得一个本来安全的整段路径变成穿越。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** 路径是否存在且为目录。 */
async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 最后手段的定位方式：一条会话自己的目录就以其编码后的 id 命名，位于某个项目目录之下，
 * 所以即便再也没有任何元数据记得它的 cwd，一次浅层扫描也能把它找出来。
 */
async function scanForSessionDir(roots, sessionId) {
  const wanted = encodeSegment(sessionId)
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, wanted)
      if (await isDirectory(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 把某个会话 id 从每个 Workspace 的记账里摘掉。注册表实体确实会剔除「规范 cwd 已无法
 * 解析」的 id，但那要到*下一次*变更才发生；显式摘除能立刻让成员关系保持诚实，也不给一条
 * 即将消失的会话留下占位。
 * @returns 曾经记账该会话的 Workspace id 列表。
 */
async function detachFromWorkspaces(registry, sessionId) {
  const detached = []
  const entities = registry?.entities
  if (!(entities instanceof Map)) return detached
  for (const [workspaceId, entity] of entities) {
    let accounted = false
    try {
      accounted = entity?.record?.sessionIds?.includes?.(sessionId) === true
    } catch {
      accounted = false
    }
    if (!accounted) continue
    await entity.detachSession(sessionId)
    detached.push(String(workspaceId))
  }
  return detached
}

/**
 * 把某个会话 id 从 `<dsh home>/storages` 下的每个持久化文件里清除。
 *
 * 改动刻意收得很窄：只有当该 id 是**精确的数组元素或精确的对象键**时才移除。任意字符串
 * 值永远不会被改写，所以不可能因为一次部分匹配而损坏无关状态。解析失败的文件原样保留并
 * 上报，绝不重写。
 *
 * @returns 被改动的文件绝对路径，外加若干告警。
 */
async function scrubStores(sessionIds, warnings) {
  const { root, sidecar } = projectionCacheDirs()
  const changed = []
  const wanted = new Set(sessionIds)

  /** 重写一份 JSON 文档并剔除这些 id；有改动时返回 true。 */
  const purge = (value) => {
    let dirty = false
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) {
          const item = node[index]
          if (typeof item === 'string' && wanted.has(item)) {
            node.splice(index, 1)
            dirty = true
            continue
          }
          visit(item)
        }
        return
      }
      if (!isPlainObject(node)) return
      for (const key of Object.keys(node)) {
        if (wanted.has(key)) {
          delete node[key]
          dirty = true
          continue
        }
        visit(node[key])
      }
    }
    visit(value)
    return dirty
  }

  const editFile = async (absolute) => {
    let text
    try {
      text = await readFile(absolute, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      warnings.push(`left "${absolute}" untouched: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!purge(parsed)) return
    try {
      await writeFile(absolute, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      changed.push(absolute)
    } catch (error) {
      warnings.push(`could not rewrite "${absolute}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 一条记录一个文件，形如 `<unit>/<table>/<记录键>.json`。记录键就是被编码过的会话 id，
  // 所以两种写法都要匹配。
  for (const unit of await safeReadDir(sidecar)) {
    const tableDir = join(sidecar, unit)
    for (const file of await safeReadDir(tableDir)) {
      const recordKey = file.replace(/\.json$/, '')
      const isTarget = [...wanted].some((id) => recordKey === id || encodeSegment(id) === recordKey)
      if (!isTarget) continue
      const absolute = join(tableDir, file)
      try {
        await rm(absolute, { force: true })
        changed.push(absolute)
      } catch (error) {
        warnings.push(`could not remove "${absolute}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // 根目录下的持久化文件，其中包括旧版的单文件投影缓存。
  for (const entry of await safeReadDir(root)) {
    if (!entry.endsWith('.json')) continue
    const absolute = join(root, entry)
    let info
    try {
      info = await stat(absolute)
    } catch {
      continue
    }
    if (info.isFile()) await editFile(absolute)
  }

  return changed
}

/** 不会抛异常的 `readdir`：读不到就返回空列表。 */
async function safeReadDir(target) {
  try {
    return await readdir(target)
  } catch {
    return []
  }
}

/**
 * 读取投影缓存为某条会话记住的 cwd，每条记录一个的形态和旧版单文件形态都支持。
 */
async function readCachedCwd(sessionId) {
  const { sidecar, legacy } = projectionCacheDirs()
  try {
    const parsed = JSON.parse(await readFile(join(sidecar, 'sessions', `${sessionId}.json`), 'utf8'))
    const cwd = parsed?.record?.identity?.cwd
    if (typeof cwd === 'string') return cwd
  } catch {
    // 回退到旧版单文件形态。
  }
  try {
    const parsed = JSON.parse(await readFile(legacy, 'utf8'))
    const cwd = parsed?.tables?.sessions?.[sessionId]?.identity?.cwd
    if (typeof cwd === 'string') return cwd
  } catch {
    // 没有任何地方记得 cwd；调用方会退到扫描。
  }
  return undefined
}

/** 一次批量删除在多久之内拒绝第二次提交（防双击）。 */
const BULK_COOLDOWN_MS = 3000

/** 构建两个端点共用的删除运行时。 */
function createRuntime(ctx) {
  const persistence = ctx.sessionPersistence
  const registry = ctx.workspaceRegistry
  const root = typeof persistence?.root === 'string' ? persistence.root : undefined

  return {
    persistence,
    registry,
    root,
    scanRoots: root === undefined ? [] : [root],
    /** 最近一次被接受的批量删除时间，用于防重复提交。 */
    bulkStartedAt: 0,
    /** 从投影缓存里解析某个 id 的 cwd。 */
    cachedCwd: (sessionId) => readCachedCwd(sessionId),
    /** 注册表全局归档集合，转成普通字符串。 */
    archivedIds() {
      const ids = registry?.archivedSessionIds
      return Array.isArray(ids) ? ids.map(String) : []
    },
    /**
     * 某条会话是否仍有活跃 agent。查找失败时返回对象而不是布尔值，好让调用方把这份
     * 不确定性报出来：这道检查是「用户」与「把一条正在跑的对话从它自己脚下抽走」之间
     * 唯一的阻挡，所以它绝不允许静默失败。
     */
    isLive(sessionId) {
      try {
        return ctx.sessions.get(sessionId) !== undefined
      } catch (error) {
        return { unknown: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/**
 * 彻底删除一条会话。
 *
 * 任何会话都可以删——归档的也好，没归档的也好——唯独正在运行的会被拒绝，而不是在轮次
 * 中途被拆掉。
 *
 * @returns 一行结果：删掉了什么，哪些步骤失败了。
 */
async function purgeOne(runtime, sessionId, warnings) {
  const failures = []
  const guard = (step, error) => {
    failures.push(`${step}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const live = runtime.isLive(sessionId)
  if (live === true) {
    return {
      sessionId,
      deleted: false,
      removedDir: null,
      workspaces: [],
      changedStores: [],
      error: 'the session is still running; stop it before deleting it permanently',
    }
  }
  if (typeof live === 'object') {
    warnings.push(`session ${sessionId}: liveness could not be confirmed (${live.unknown}); deleting anyway`)
  }

  // 先解析目录再摘记账：注册表会剔除「规范 cwd 已无法解析」的 id，而摘记账本身就可能
  // 触发那次剔除。
  let sessionDir
  try {
    sessionDir = await resolveSessionDir(runtime, sessionId)
  } catch (error) {
    guard('resolve', error)
  }

  let workspaces = []
  try {
    workspaces = await detachFromWorkspaces(runtime.registry, sessionId)
  } catch (error) {
    guard('detach', error)
  }

  try {
    await runtime.registry.unarchiveSession(sessionId)
  } catch (error) {
    guard('unarchive', error)
  }

  let removedDir = null
  if (sessionDir !== undefined) {
    try {
      await rm(sessionDir, { recursive: true, force: true })
      // 若这本就是该项目目录下最后一条会话，就把它也删掉，别让一个已删除的项目在日志根
      // 里留成空文件夹。
      const project = dirname(sessionDir)
      if (dirname(project) === runtime.root && project !== runtime.root) {
        const remaining = await safeReadDir(project)
        if (remaining.length === 0) await rm(project, { recursive: true, force: true })
      }
      removedDir = sessionDir
    } catch (error) {
      guard('remove-log', error)
    }
  }

  let changedStores = []
  try {
    changedStores = await scrubStores([sessionId], warnings)
  } catch (error) {
    guard('scrub', error)
  }

  // 进程内的缓存仍然记着这条会话。把它们丢掉，注册表才不会为一条已不存在的日志再发布
  // 出一行。
  try {
    runtime.registry.sessionPaths?.delete?.(sessionId)
    runtime.registry.headers?.delete?.(sessionId)
    runtime.registry.invalidSessionPaths?.delete?.(sessionId)
  } catch {
    // 缓存字段属于内部细节；结构变化不该让一次删除失败。
  }

  const error = failures.length === 0 ? undefined : failures.join('; ')
  if (error !== undefined) warnings.push(`session ${sessionId}: ${error}`)

  return {
    sessionId,
    // 日志不存在不算失败：用户真正看得见的是归档集合和缓存，而那些两种情况下都已经
    // 干净了。
    deleted: error === undefined || removedDir !== null,
    removedDir,
    workspaces,
    changedStores,
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * 挂载删除引擎：一条前缀路由，提供状态查询、单条删除和全部删除。
 */
export function apply(ctx) {
  const runtime = createRuntime(ctx)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : ''

          if (method === 'status' && (req.method === 'GET' || req.method === 'POST')) {
            writeJson(res, 200, { ok: true, build: BUILD, archivedSessionIds: runtime.archivedIds() })
            return
          }

          if (req.method !== 'POST' || (method !== 'delete' && method !== 'delete-all')) {
            writeJson(res, 404, { ok: false, error: `unknown session-purge method "${method}"` })
            return
          }

          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            writeJson(res, 400, { ok: false, error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` })
            return
          }

          // `delete` 显式指名一条会话，任意会话都接受；`delete-all` 针对的是归档集合——
          // 也就是侧边栏「仅显示已归档」筛选所展示的同一范围，所以批量操作永远够不到用户
          // 视线之外的东西。
          let targets
          if (method === 'delete') {
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
            if (sessionId === '') {
              writeJson(res, 400, { ok: false, error: 'sessionId is required' })
              return
            }
            targets = [sessionId]
          } else {
            // 批量删除会一次抹掉全部已归档会话，所以若第二次提交在第一次还在跑时到达
            // （双击、重试的请求），就会和刚刚被它消费掉的归档集合抢跑。宁可拒绝，也不
            // 删两遍。
            const now = Date.now()
            if (now - runtime.bulkStartedAt < BULK_COOLDOWN_MS) {
              writeJson(res, 429, {
                ok: false,
                error: 'a bulk delete was just submitted; wait a moment before repeating it',
              })
              return
            }
            runtime.bulkStartedAt = now
            targets = runtime.archivedIds()
          }

          const warnings = []
          const results = []
          for (const sessionId of targets) {
            try {
              results.push(await purgeOne(runtime, sessionId, warnings))
            } catch (error) {
              results.push({
                sessionId,
                deleted: false,
                removedDir: null,
                workspaces: [],
                changedStores: [],
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }

          const deleted = results.filter((row) => row.deleted).length
          ctx.logger?.info?.(
            `session-purge: permanently deleted ${String(deleted)}/${String(results.length)} session(s)`,
          )

          writeJson(res, 200, {
            ok: true,
            deleted,
            requested: results.length,
            failed: results.length - deleted,
            results,
            warnings,
            archivedSessionIds: runtime.archivedIds(),
          })
        },
      }),
    'dsh-session-purge: /session-purge/api route',
  )
}
