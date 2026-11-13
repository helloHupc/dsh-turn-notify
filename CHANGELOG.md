# Changelog

## 0.1.2

修复重启 DSH 后 `/notify-test` 斜杠命令消失、必须把插件关闭再开启才恢复的问题。

根因：`apply()` 里用 `ctx.get('commands')` 读取命令注册表。冷启动时 Loader 按行顺序挂载，本插件的 `apply` 可能先于提供 `commands` 的那一行执行，此时 `ctx.get` 返回 `undefined`，命令注册分支整段被跳过——命令从未注册。手动关闭再开启时 `commands` 早已就绪，所以又能注册上。该行为已在真实 Cordis 环境复现。

变更：

- 改用 `ctx.inject(['commands'], scope => …)`，由 Cordis 等服务就绪后再执行，服务消失时自动移除。
- `sessionTitle` / `subprocess` 仍在运行期用 `ctx.get` 惰性读取：它们只在通知触发时访问，那时服务必然已就绪。
- 新增 3 项冷启动时序测试：服务晚到时命令仍被注册、没有 `commands` 服务时插件照常激活、延迟注册不重复。

## 0.1.1

修复 macOS 上「通知只进通知中心、不弹出横幅」，以及「系统设置 → 通知」里找不到 DeepSeek Harness 的问题。

根因：macOS 的通知权限属于**发通知的那个 App**，不属于发起进程。命令行工具不能直接发通知，必须借一个已注册应用，横幅还是静默由那个应用的提醒样式决定。

- 原 `auto` 优先 `terminal-notifier`，而它的提醒样式是「仅在通知中心」（flags 低字节 `0x8`）
- `osascript` 借「脚本编辑器」，提醒样式是横幅（低字节 `0xE`）

变更：

- macOS 的 `auto` 顺序改为 `osascript` → `terminal-notifier`，开箱即弹出横幅。
- 新增 `senderBundleId`：让 terminal-notifier 的通知显示为 DeepSeek Harness（仅名字与图标，**不**迁移权限）。
- 新增 `notificationOwner()` 与 `notificationSettingsUrl()`；`/notify-test` 现在会报出这条通知归属哪个 App 及其 bundle id，并给出直达设置页的链接。
- README 增加「只进通知中心、不弹出横幅」专章，含两种修复方案。

## 0.1.0

首次发布。

- 监听 Session 日志里的 `turn/end`，任务结束时发出系统通知。
- 通知包含结果、耗时、最后一段助手正文，以及 Session 标题和工作目录。
- 支持 macOS（`terminal-notifier` / `osascript`）、Linux（`notify-send`）、Windows（PowerShell Toast）三种后端，按平台自动选择。
- 静默期 + 最短时长 + 冷却三重去噪，保证「一个任务一条通知」。
- 13 个配置项，全部 `volatile()`，改完对下一个任务立即生效。
- `/notify-test` 斜杠命令用于即时验证。
- 默认忽略子 Agent 会话。
