# dsh-cache-workspace

DeepSeek Harness 桌面客户端的本地插件：在输入框工具栏「电脑操作」右边加一个**缓存工作区**控件，
并给每个 agent 注入一段缓存目录使用规则。

## 功能

- 显示当前缓存文件夹名，点击用 Windows 资源管理器选择目录。
- 右侧箭头下拉：工作区一级目录 / 当前项 / 新建文件夹。
- 清理按钮：删除在 detached `cmd.exe` 进程里进行，即使对话被归档也会完成。
- 系统提示注入五条规则（禁止在根目录堆文件、缓存可能被清理、用完提醒用户清理等）。

## 安装

```powershell
# 在 DSH 里执行
plugin_manager action=install_bundle target=<本目录绝对路径>
```

缓存目录可以选在工作区外（例如 D 盘）。插件会给该目录加上 DSH 沙箱的「工作区写权限标识」（`S-1-4-…`）的修改权限，
受限的 shell 与文件工具就能读写它——**不需要**改 profile 的沙箱配置。

**不要试图用 `additionalWritableRoots` 开放工作区外目录**：Windows ACL 沙箱后端不支持它，声明后该会话所有 shell 会直接报
`Windows ACL confinement does not support additional writable directories`。详见 `HANDOFF.md` 第 5 节。

## 状态与日志

- `~/.dsh/dsh-cache-workspace/state.json` — 每个工作区选中的缓存目录与已授权目录。
- `~/.dsh/dsh-cache-workspace/log.txt` — UTF-8 日志。
- `~/.dsh/dsh-cache-workspace/grant.ps1` — 给工作区外目录加 ACL 权限时生成的脚本。

## 安全说明（重要）

- 选择**工作区外**目录时，插件会修改该目录的 Windows ACL：给 DSH 沙箱的「工作区写权限标识」（`S-1-4-…`）添加 **Modify** 权限。
  只改动你主动选中的那一个目录；不选就不会改任何东西。
- 只选**属于你自己的**目录。管理员所有、或其他用户所有的目录会授权失败（`Set-Acl` 无权限），chip 上会显示错误原因。
- 插件不联网、不上传任何数据。选中的目录路径与 SID 只写在本地 `state.json`。
- 清理按钮会用 detached `cmd.exe /c rd /s /q` **递归删除**所选缓存目录。执行前有 `confirm` 确认框，删除不可恢复。

## 免责声明

本项目按 **MIT** 许可发布，不提供任何明示或暗示的担保，包括但不限于适销性、特定用途适用性。
使用本插件造成的任何数据丢失、权限变更、系统异常或其他损害，由使用者自行承担。
装之前请确认你理解它会做什么；不要在包含重要数据的目录上使用清理功能。

## 许可

MIT，见 [LICENSE](LICENSE)。
