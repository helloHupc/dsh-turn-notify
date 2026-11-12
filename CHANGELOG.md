# Changelog

## 0.1.0

首次发布。

- 监听 Session 日志里的 `turn/end`，任务结束时发出系统通知。
- 通知包含结果、耗时、最后一段助手正文，以及 Session 标题和工作目录。
- 支持 macOS（`terminal-notifier` / `osascript`）、Linux（`notify-send`）、Windows（PowerShell Toast）三种后端，按平台自动选择。
- 静默期 + 最短时长 + 冷却三重去噪，保证「一个任务一条通知」。
- 13 个配置项，全部 `volatile()`，改完对下一个任务立即生效。
- `/notify-test` 斜杠命令用于即时验证。
- 默认忽略子 Agent 会话。
