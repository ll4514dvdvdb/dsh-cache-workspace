# 缓存工作区（dsh-cache-workspace）— 交接文档

最后更新：2026-11-07 21:55（第五轮：改用 ACL 写权限标识授权工作区外目录）。此文档是恢复工作的入口。

---

## 1. 这是什么

DSH 桌面客户端（Web GUI）的本地插件，在输入框工具栏「电脑操作」chip 右边加一个**缓存工作区**控件，
并给每个 agent 的系统提示注入一段「## 缓存工作区」规则。

用途：让 agent 有一个专门放中间产物的地方，避免把临时文件堆进项目里；并且工作结束后能一键清理。

用户最初的三条要求（原话要点）：

1. agent 可以在缓存文件夹里任意创建并执行文件，但要提醒它**不要在缓存根目录乱堆文件**，要按本次工作名建子文件夹；
2. 要提醒 agent **工作结束后缓存可能被清理**，不是长期存储；
3. 如果用过缓存，agent 任务结束时要**提醒用户现在可以清理**；清理必须**另起进程**做（对话里跑有对话被归档而中断的风险）。

后续追加：选择目录直接调 Windows 资源管理器；UI 对齐「电脑操作」chip 的胶囊风格（**用户已确认满意，不要再改样式**）；
**缓存目录要能选到工作区外（例如 D 盘），因为用户做这个插件的初衷就是跳出沙箱限制**。

---

## 2. 当前状态

已完成并在本机 `desktop` profile 运行中：

- chip 注册在 `conversation.input.left`，order 41（computer-use 是 40，所以紧贴其右）。
- 显示当前缓存文件夹名；点击名字 → 调 `uiWorkspace.pickDirectory()` 弹 Windows 资源管理器 → 选中后写回。
- 名字右侧小箭头内嵌透明 `<select>`：列出工作区一级目录 + 当前项 + 「＋ 新建文件夹…」。
- 最右独立清理按钮：`window.confirm` 后 POST `/clear`，host 用 **detached `cmd.exe /c rd /s /q`** 删除，对话被归档也会完成。
- 规则注入：`ctx.on('agent/created')` → `agent.ctx.effect(() => systemPrompt.section({ name:'dsh-cache-workspace', order:90, text: () => buildSection(cwd) }))`。**已实测**：新开的 subagent 能原样背出这段文字（含外部目录分支）。
- 状态持久化：`~/.dsh/dsh-cache-workspace/state.json`，按工作区路径（Windows 下小写）存
  `{ version:1, selections:{ [workspaceKey]: { name, updatedAt } }, grants:{ [dirKey]: { path, sid, updatedAt } } }`。
- 日志：`~/.dsh/dsh-cache-workspace/log.txt`（UTF-8；PowerShell 5.1 要用 `Get-Content -Encoding utf8` 读，否则中文乱码）。
- 路由：`GET /dsh-cache-workspace/state?sessionId=`、`POST /select`、`POST /create`、`POST /clear`。`GET /state` 返回
  `{ cwd, name, displayName, cacheDir, isDefault, external, exists, defaultName, mode, writableRoots, options }`，
  `mode` 是 `ctx.get('sandboxPolicy').defaultMode`，`writableRoots` = 工作区 + 已授权的外部目录。

### 工作区外目录：已实测通过（ACL 写权限标识方案）

1. `POST /select {sessionId, path:"D:\\dsh-cache\\cw_ext"}` → 200，`external:true`、`displayName:"cw_ext"`、
   `writableRoots` 变成 `["<workspace>","D:\\dsh-cache\\cw_ext"]`，选项里出现 `cw_ext（工作区外）`。
2. `icacls D:\dsh-cache\cw_ext` 出现 `S-1-4-234748049-828327913:(OI)(CI)(M)`（即工作区的沙箱写 SID）。
3. `state.json` 的 `grants` 记录了该目录与 SID；系统提示的「## 缓存工作区」切到外部文案。
4. **仍待用户在「标准模式」新会话里实测**：受限 shell 实际写入 `D:\dsh-cache\<dir>` 是否成功
   （当前主会话是 danger-full-access，继承 override 测不出边界）。

### 已确认不可用的老方案（别再试）

`additionalWritableRoots`：声明非空额外根后，无 mode override 的普通会话里**所有 pwsh 命令**直接报
`Error: Windows ACL confinement does not support additional writable directories; remove the extra grants or use a supported host`，
`write` 工具能写但 shell 全废。profile patch 已回滚成只保留 `mode: workspace-write`（见第 5 节）。

---

## 3. 文件清单

```
dsh-cache-workspace/
  package.json        # name @local/dsh-cache-workspace, type module, dsh.bundle.patch + dsh.client
  cordis.patch.yml    # - insert: - id: dsh-cache-workspace / name: '@local/dsh-cache-workspace'
  index.js            # Host 半边：路由、状态、prompt 注入、ACL 授权、detached 清理（约 740 行）
  client.js           # Client 半边：chip 组件 + CSS（约 400 行）
  locale/zh.json      # meta.title / meta.description
  locale/en.json
  icon.svg            # 自绘蓝色圆角方块 + 文件夹
  README.md
  HANDOFF.md          # 本文件
```

包外还有两份：

- `sandbox-patch.snippet.yml` — 只含 `mode: workspace-write` 的沙箱段；**不要往里加 `additionalWritableRoots`**（ACL 后端会废掉 shell，见第 5 节）。
- `runtime-state/` — 打包时的 `state.json` 与 `log.txt` 副本，仅供排查，**不要直接覆盖回去**。

运行期还会在 `~/.dsh/dsh-cache-workspace/` 生成 `grant.ps1`（给外部目录加 ACE 的脚本，每次覆盖写）。

---

## 4. 关键 API 事实（都实测过，别再猜）

### Slot

- 位置：`conversation.input.left`，**list** slot，scope=session。
- 现占用：`computer-use` order=40；本插件 order=41。
- 注册：`ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name:'conversation.input.left', id:'dsh-cache-workspace', order:41, label:'缓存工作区' }, CacheChip))`。
- **不要**用 `ctx.effect` 包 `slots.inject`。
- 浮层必须 portal 到 `document.body`（docked composer 会裁剪）——本插件因此改用原生 `<select>`，弹层由浏览器渲染，绕过该限制。
- 组件的 props 里有 `sessionId`。

### Client

- 文件形态：`window.__ModuleLoader__.load({ id: '<包名>', factory(require) { const React = require('react'); ... return { inject:['slots'], apply(ctx){} } } })`。
- 样式：apply 里把 `<style id="dsh-cache-workspace-style">` 插进 `document.head`（幂等检查）。
- 只许用 `--dsw-*` 主题变量，不要 require Harness Client 包。
- 目录选择器：`const uiWorkspace = ctx.get('uiWorkspace')`；`pickDirectory(): Promise<string|null>`。

### Host

- `export const inject = ['webServer','sessions']`；`export function apply(ctx)`。
- `ctx.inject(['webServer'], (scoped) => scoped.effect(() => scoped.webServer.register({ kind:'exact', path, handler }), 'label'))`。
- handler 拿的是 Node 原生 `IncomingMessage` / `ServerResponse`，不是 fetch Request。
- 取 cwd：`ctx.get('sessions').get(sessionId)` → `ctx.get('workingDirectory').get(session)`，失败回退 `session.header.cwd`。
- `agent.id` 就是 sessionId。

### 沙箱（最重要）

- `ctx.get('sandboxPolicy')` 是**只读**服务：`defaultMode`、`workspaceRoot`、`additionalWritableRoots`（frozen 数组）。
- **没有** per-session 加可写根的 API。
- Windows 上的 workspace-write 走 **ACL restricted-token runner**（`@deepseek-ai/dsh-sandbox-local` + `@deepseek-ai/dsh-sandbox-windows-acl`）：
  - 受限 token 的 restricting SIDs = 工作区写 SID + temp 写 SID + logon SID + Everyone；
  - 写 SID 是 **per-workspace 的确定性身份**（`workspaceWriteSid`，由规范化的工作区路径派生），所以一个目录的 ACE 加一次就长期有效；
  - 工作区的 ACE 形如 `S-1-4-234748049-828327913:(OI)(CI)(W,D,DC)`。
- **结论**：给目标目录加这个写 SID 的 Modify ACE，受限进程就能写，完全不需要 `additionalWritableRoots`。

---

## 5. 工作区外缓存目录：ACL 写权限标识方案

**profile patch 现状**（`C:\Users\ASUS\.dsh\profiles\desktop\cordis.patch.yml`，在 sandbox-policy 段）：

```yaml
- id: sandbox-policy
  name: "@deepseek-ai/dsh-sandbox-policy"
  config:
    mode: workspace-write
```

不要加 `additionalWritableRoots`。显式写 `mode` 是为了防止 loader patch 整对象替换、落回 schema 默认的 `read-only`。

**插件侧怎么给外部目录授权**（`index.js`）：

1. `workspaceWriteSidFor(cwd)`：跑 `icacls.exe <cwd>`，正则 `/S-1-4-\d+-\d+/` 取写 SID（按 cwd 缓存）。
2. `ensureExternalGrant(cwd, dir)`：把 `GRANT_SCRIPT` 写到 `~/.dsh/dsh-cache-workspace/grant.ps1`，
   用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <脚本> <dir> <sid>` 执行。
   脚本内容：`Get-Acl` → `New-Object SecurityIdentifier` → `FileSystemAccessRule($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')` → `AddAccessRule` → `Set-Acl`。
3. 成功写 `state.grants[dir] = { path, sid, updatedAt }`，日志 `granted dir=… sid=…`；失败抛含 stderr 的中文错误。

**限制**：

- 目录必须 **owner 是当前用户**（否则 Set-Acl 没权限改 DACL）。管理员建的目录会失败，错误会回显到 chip。
- `icacls /grant *S-1-4-…` **不能用**：会报 `No mapping between account names and security IDs was done`，必须走 .NET `SecurityIdentifier` + `Set-Acl`。
- 写 SID 由工作区路径派生 → **换工作区后旧的外部目录授权对新会话无效**，重新选一次即可（插件会用新 cwd 的 SID 重加 ACE）。

---

## 6. 重装 / 恢复步骤

1. 把 `dsh-cache-workspace` 目录放到任意 workspace（例如 `C:\Users\ASUS\Documents\deepseek-harness\default-workspace\`）。
2. `plugin_manager action=install_bundle target=<该目录绝对路径>`。
3. 确认返回 `application: applied`；唯一可接受的 warning 是既有的 `virtual-desktop-manager ... Cannot find package`。
4. 把 `sandbox-patch.snippet.yml` 的内容并进 `C:\Users\ASUS\.dsh\profiles\desktop\cordis.patch.yml` 的 sandbox-policy 段（只留 mode）。
5. 改 host 代码：`set_plugin enabled=false` 再 `true` 即可重载；改 client 代码：刷新页面。patch 改动需要重启 DSH。

---

## 7. 给未来的 AI：踩坑清单

- **不要重启用户的客户端**，除非用户明确说可以。host 半边改完用 `plugin_manager set_plugin target=include:dsh-cache-workspace enabled=false` 再 `true` 重载；**禁用后系统提示里的「## 缓存工作区」会消失，记得立刻启用回来**。
- `set_plugin` 的 target 要带 `include:` 前缀，否则 `unknown-plugin`。
- 不要用 `list_plugins` 找本插件（222 条、分页、默认页没有），直接 `target=include:dsh-cache-workspace`。
- `app.asar` 里的文件（包括 skill 文档、sandbox-policy / windows-acl 源码）**只有 read 工具能读**，shell / glob / grep / node 都读不了。
- 打开 `http://127.0.0.1:<port>/` 会被要求 `dsh web authentication required`，无法用浏览器验证 UI；但插件自注册的 `/dsh-cache-workspace/*` 路由免认证，可直接 curl 测。
- 日志是 UTF-8。PowerShell 5.1 默认 GBK，必须 `-Encoding utf8`。
- **别用 `additionalWritableRoots`**：Windows ACL 后端声明非空额外根后，无 override 的普通会话所有 pwsh 直接报 `Windows ACL confinement does not support additional writable directories`。工作区外目录改走 ACE 方案（第 5 节）。
- **icacls 不能给未映射的 SID 授权**：`icacls dir /grant *S-1-4-…:(OI)(CI)(M)` 报 `No mapping between account names and security IDs was done`。用 `System.Security.Principal.SecurityIdentifier` + `FileSystemAccessRule` + `Set-Acl`。
- **前端请求路径别再套一层 `ROUTE`**：`request()` 内部已经是 `fetch(ROUTE + pathName)`，调用方只传 `/state?...`。曾经写成 `` request(`${ROUTE}/state?...`) ``，实际请求变成 `/dsh-cache-workspace/dsh-cache-workspace/state` → 被 framework 直接 404，**连 host 日志都不会留**（handler 根本没进），表现就是 chip 永远显示「缓存不可用」。排查此类问题时先看浏览器 Network 里的真实 URL。
- **新会话刚创建时插件路由可能 404**：`sessions.get(sessionId)` 这时还没有记录，前端要重试（已实现 3 次退避 `[0,1200,3000]`）。
- **清理动作一定放 detached 进程**，不要在 agent 的 shell 里递归删。
- **别用 detached PowerShell 做删除**：本 host 里 `spawn('powershell.exe', [...], { detached:true, stdio:['ignore','pipe','pipe'] })` 会以 `exit code=0` 静默退出，脚本一行都没执行（试过 `-Command` + `-WindowStyle Hidden`、去掉 Hidden、stdio ignore / pipe，全部无效；同样参数改成 `detached:false` 或换成 `cmd.exe` 就正常）。当前实现用 `cmd.exe /c rd /s /q <path>`，稳定。cmd 的 stderr 是 OEM 代码页，日志里可能乱码。
- 用 `curl.exe` 在 pwsh 里 POST 中文/JSON 遇到过「请求体不是合法 JSON」，改用 node fetch 脚本。
- **pwsh 的 `node -e '...'` 会把单引号里的双引号吃掉**，JS 字符串引号全丢 → 语法错误。测试脚本一律写成 `.mjs` 文件再 `node 文件` 执行。
- 目录名校验：拒绝空 / `.` / `..` / `[\\/:*?"<>|]` / 控制字符 / 点或空格结尾 / `CON|PRN|AUX|NUL|COM1-9|LPT1-9` / 超 64 字。
- 绝对路径选择必须 `realpath` 后做 `path.relative` 边界判断，防符号链接逃逸。

---

## 8. 下一步可以做什么（如果继续）

- **等用户在新会话（标准模式）实测外部目录写入**；若失败，检查 `icacls <dir>` 里 SID 是否与 `icacls <workspace>` 一致。
- 清理进度反馈：现在是 fire-and-forget，只能靠轮询 `exists:false` 判断；可加一个 `GET /clear/:job`。
- 把 chip 的 chevron 下拉改造成「最近使用」列表（现在只列工作区一级目录）。
- 多工作区记忆：state.json 目前按 cwd 存，同一个缓存目录在不同工作区要选两次。
- 换工作区后旧 grant 失效的问题：可以在 `currentSelection` 里比对 `state.grants[dir].sid` 与当前 cwd 的 SID，不一致就提示重新授权。
- 发布：README 补安装说明、许可证（MIT），推 GitHub 前按用户习惯写完整免责声明。
