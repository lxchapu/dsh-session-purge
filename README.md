# dsh-session-purge

彻底删除 DSH 会话的插件：每条会话的「…」菜单里可以删单独一条，侧边栏切到
**仅显示已归档** 时还可以一键删除全部已归档会话。

DSH 本身只能「归档」会话——归档只是把会话从分组界面隐藏起来，磁盘上的会话日志
（`session.vN.jsonl.zstd`）和投影缓存都还在。官方也明确没有会话删除能力
（`dsh-client-ui-workspace` 的已知限制写着 *No Session deletion*，会话持久化层也
写着 *No deletion or retention API*）。本插件补上这个缺口。

## 功能

| 入口 | 位置 | 出现条件 |
|---|---|---|
| 彻底删除单条 | 每条会话行「…」菜单里的「彻底删除…」 | **所有**会话都出现（已归档与未归档均可），样式与菜单里其它选项完全一致，只是采用破坏性配色与垃圾桶图标 |
| 一键删除全部已归档会话 | 侧边栏底部操作区（设置按钮左侧）的按钮 | **只在顶部菜单把会话筛选为「仅显示已归档」时出现**，没有数量角标 |

「仅显示已归档」这个条件是有意选的：那一刻屏幕上列出的就是归档集合本身，所以批量删除
的范围和用户正在看的列表完全一致，不会伸到视线之外。

两个入口都会先弹出二次确认对话框，写明「将从磁盘上永久删除、此操作不可撤销」，并给出
确切条数；只有点下确认按钮才会真正执行。未归档会话的确认文案会额外说明它没有取消归档
这条恢复路径。

## 「彻底删除」到底清了什么

一条会话的删除按下面的顺序执行（顺序是刻意的）：

1. **工作区记账**：把该会话从所属 Workspace 的 `sessionIds` 里摘掉，侧边栏不再为它
   保留位置；
2. **归档标记**：从注册表全局归档集合 `archivedSessionIds` 中移除；
3. **磁盘日志**：删除会话日志目录（`<会话根>/<项目目录>/<会话 id>/`），里面是全部
   保留的格式代际（`session.vN.jsonl.zstd`）。如果这是该项目目录下最后一条会话，
   空的项目目录也一并删掉；
4. **投影缓存与其它持久化状态**：删除 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`，
   并把该会话 id 从 `storages` 下其它 JSON 持久化文件里清除。

第 4 步的改动刻意收得很窄：**只有**该 id 作为数组元素或对象键精确匹配时才会被移除，
任意字符串值都不会被改写，解析失败的文件原样保留并记入 `warnings`，所以不会误伤
别的会话状态。

第 1、2 步先于第 3 步，是因为进程若在中途退出，结果只会是「看不见但仍可删」，而不会
留下一个指向已消失日志的工作区条目。

## 安全边界

- **正在运行的会话会被拒绝**：仍发布在 `ctx.sessions` 里的会话不会被拔掉，接口返回
  `the session is still running; stop it before deleting it permanently`，前端把这条
  理由原样显示在对话框里。已归档会话按定义就是停止状态，所以这条只会对用户正在使用的
  未归档会话生效。
- 删除是不可逆的，没有回收站；确认对话框是最后一道闸门。

## 为什么删完还要「清列表」

宿主把一条会话从客户端列表里摘掉，靠的是 `api-session/removed`——而它只在
`session/disposed` 时发出。**在更早的进程里就已经停止的会话永远不会触发这个事件**，
所以删掉它之后，它的 id 已经不在任何 Workspace 的 `sessionIds` 里，客户端本地列表却还
留着它。而侧边栏的分组逻辑正是「不在任何 Workspace 记账里的会话归入未分组」，于是这条
幽灵行会从「已归档」跳到「未分组」，点开还会报
`历史加载失败：session "…" not found（session/not-found）`。

修法是在前端删除成功后调用会话服务自己的
`ctx.sessions.handleSessionRemoved(sessionId)`——这正是 Remote 事件本来会调用的那个
入口，它会把该 id 从客户端列表、投影缓存、子代理地址表和已交互集合里一并摘掉。批量删除
按 `results` 里每条 `deleted === true` 的记录逐条清理；这一步失败不会影响已经落盘的删除
结果（下一次列表基线拉取会重新推导）。

## HTTP 接口

宿主前半部分注册一条前缀路由 `/session-purge/api`，前端后半部分通过它执行删除：

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET | `/session-purge/api/status` | — | `{ ok, build, archivedSessionIds }` |
| POST | `/session-purge/api/delete` | `{ sessionId }` | 删除一条（任意会话） |
| POST | `/session-purge/api/delete-all` | — | 删除归档集合里的全部会话 |

`delete-all` 只认归档集合，请求体里传什么都不会扩大范围；重复提交在 3 秒冷却内返回 429。

`status` 里的 `build` 是构建标记，用来判断当前进程实际加载的是哪一版宿主代码——DSH
按进程缓存宿主模块，就地改动在应用重启前不可见。

成功响应形如：

```json
{
  "ok": true,
  "deleted": 1,
  "requested": 1,
  "failed": 0,
  "results": [{ "sessionId": "session-…", "deleted": true, "removedDir": "…", "workspaces": ["…"], "changedStores": ["…"] }],
  "warnings": [],
  "archivedSessionIds": []
}
```

## 前端如何知道当前筛选状态

批量按钮的显示条件依赖侧边栏浏览器自己的视图状态（`archivedFilter`）。该 store 属于
`dsh-client-ui-workspace`，第三方插件拿不到它的实例，因此本插件读取它持久化到
`localStorage` 的 `dsh.workspace.view.v5` 键，并以 600ms 一次的极低频率轮询——切换筛选
是低频且刻意的操作，读一个小键的成本远低于它所控制的这次渲染。若该键缺失或损坏，一律
按默认筛选处理，也就是不显示批量按钮。

## 安装

从 npm 装：

```
dsh plugin --profile desktop add @lxchapu/dsh-session-purge
```

也可以从 GitHub 装：

```
dsh plugin --profile desktop add github:lxchapu/dsh-session-purge
```

在本机开发这个插件本身时，装本地目录并把改动即时接进去：

```
dsh plugin --profile desktop add link:<本目录绝对路径>
```

> 包名是 `@lxchapu/dsh-session-purge` 而不是 `dsh-session-purge`：后者在 npm 上已被
> 另一位作者占用。

安装命令会把本包追加进 profile 的 bundle 栈。前端 bundle 随 `dsh.client` 声明被
`dsh-client-modules` 扫描并按需加载；`dsh.client.external` 里声明了
`@deepseek-ai/dsh-client-ui-primitives`，以便菜单项复用官方那套行组件。

`cordis.patch.yml` 里 `insert` 的 `name` 必须与 npm 包名逐字一致，否则宿主半解析不到
模块，插件不会挂载。

改前端（`lib/client.js`）只需硬刷新页面；改宿主（`lib/index.js`）需要重启应用。

`dsh.client.inject` 必须包含 `@deepseek-ai/dsh-api-session-controller`，否则新的
`ctx.sessions` 不可用，插件会因依赖不满足而不挂载（`dsh.client.inject` 的包名与
`apply` 里 `inject` 数组的服务名是两套东西，两者都要写对）。

## 脚本

`scripts/audit-sessions.mjs` 是一个只读审计：它把磁盘上的会话日志目录、工作区记账、
归档/置顶集合、各投影缓存（含旧版单文件缓存与第三方插件的存储）里的全部会话身份列出来，
互相交叉核对并标出问题项：

```
node scripts/audit-sessions.mjs            # 默认取 DSH_HOME，再退到 ~/.dsh
node scripts/audit-sessions.mjs <DSH 主目录>  # 也可显式指定
```

输出里会区分「有日志但无人引用」「被引用但日志已消失」「缓存里有条目但日志不存在」
这几类，并给出总数汇总。

`scripts/check-client.mjs` 是前端半的离线回归校验：它在 `node:vm` 里执行 bundle，确认
注册成功、4 个插槽齐全、以及两个入口的显隐逻辑（菜单项在普通行也渲染、批量按钮只在
「仅显示已归档」时出现且不带角标）。改动 `lib/client.js` 后跑一次即可：

```
node scripts/check-client.mjs
```

## 结构

```
dsh-session-purge/
  package.json        # dsh.bundle.patch + dsh.client 双半声明
  cordis.patch.yml    # 宿主行的挂载声明
  scripts/audit-sessions.mjs  # 只读会话状态对账
  scripts/check-client.mjs    # 前端半离线回归校验
  lib/index.js        # 宿主半：删除引擎 + /session-purge/api 路由
  lib/client.js       # 前端半：菜单项、底部批量按钮、确认框、提示条
```
