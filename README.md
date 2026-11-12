# dsh-turn-notify

> 任务一结束，系统通知就告诉你结果、耗时和最后一段回复。失败也会通知，可以放心离开窗口。

[English](README.en.md) | 简体中文

DeepSeek Harness 插件。监听 Session 日志里的 `turn/end`，把「一个任务结束了」这件事变成一条真正的系统通知。

## 为什么是系统通知

很多「任务完成提醒」做在网页里：页面弹一个 toast。问题是任务刚好在你切走、最小化、或者关掉窗口的时候结束时，那条 toast 你永远看不到——而这正是你最需要被提醒的时刻。

这个插件在 **Host 侧**发通知，走操作系统自己的通知中心：

- 窗口在后台、被最小化、甚至 Web GUI 已经关掉，通知照样弹出；
- 通知留在系统的通知中心里，回来还能看到；
- 不依赖浏览器权限，不需要页面处于打开状态。

## 通知里有什么

```
┌─────────────────────────────────────────┐
│ 🔔 重构加载器                            │  ← Session 标题
│    dsh-turn-notify                       │  ← 工作目录
│    任务完成 · 42.6 秒 · 39 项测试全部通过 │  ← 结果 · 耗时 · 最后一段回复
└─────────────────────────────────────────┘
```

- **结果**：完成 / 出错 / 已取消 / 被阻止 / 输出超限 / 被中断 / 已分叉
- **耗时**：这个 turn 实际花了多久
- **摘要**：该 turn 最后一段助手正文（自动压成一行、按字数截断）

## 安装

```bash
# 在 DSH 里安装（推荐）
# 让 Agent 执行：安装 /path/to/dsh-turn-notify 这个 bundle
```

或者手动：

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add link:/path/to/dsh-turn-notify
```

然后把它加进 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-turn-notify"]
    }
  }
}
```

重启 DSH 后，插件会自动插入自己的 Host 行。

## 通知后端

插件按平台自动挑选，也可以用 `backend` 强制指定：

| 平台 | 自动顺序 | 说明 |
| --- | --- | --- |
| macOS | `osascript` → `terminal-notifier` | `osascript` 系统自带，通过「脚本编辑器」发通知，默认就是横幅；装了 [terminal-notifier](https://github.com/julienXX/terminal-notifier) 也可以切换 |
| Linux | `notify-send` | 需要 `libnotify`（`apt install libnotify-bin`） |
| Windows | `powershell` | 走 Windows 原生 Toast 通知 |

所有后端都用 **argv 传参**，不经过 shell：Session 标题里带引号、分号、`$(...)` 都只是数据。

## ⚠️ 只进通知中心、不弹出横幅？

这是 macOS 最常见的坑，值得单独说清楚。

**通知的权限属于「发通知的那个 App」，不属于 DSH。** macOS 不允许命令行工具直接发通知，它必须借某个已注册的应用来发，而横幅还是静默只进通知中心，由**那个应用**的提醒样式决定。所以：

- 在「系统设置 → 通知」里**找不到 DeepSeek Harness**，是因为它从来没发过通知——发通知的是别的 App；
- 本插件默认用 `osascript`，通知归属到 **「脚本编辑器」（Script Editor）**；
- 如果改用 `terminal-notifier`，归属到 **terminal-notifier** 自己的 bundle，而它的默认样式恰好是「仅在通知中心」。

### 怎么让它弹出来

在 DSH 里执行：

```
/notify-test
```

它会直接告诉你**这条通知是通过哪个 App 发的**（含 bundle id）。然后二选一：

**方案 A（推荐，什么都不用改）**：用默认的 `osascript`。它归属「脚本编辑器」，默认就是横幅，通常已经能直接弹出。

**方案 B**：如果「脚本编辑器」也被设成了只进通知中心，打开对应设置页改成「横幅」：

```
open "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.apple.ScriptEditor2"
```

用 `terminal-notifier` 的话换成：

```
open "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=fr.julienxx.oss.terminal-notifier"
```

在该页把提醒样式从「仅在通知中心」改成「横幅」或「提醒」，并确认没开「专注模式」。

> 顺带一提：`senderBundleId`（默认 `com.deepseek.dsh`）只影响 terminal-notifier 通知上显示的**名字和图标**，让它看起来像 DeepSeek Harness，**不会**把权限迁移过去——权限始终跟着真正发通知的 App。

## 配置

配置文件在 profile 的 `cordis.patch.yml` 里，或者直接在 **设置 → 插件 → 任务通知** 里改。所有字段都是 `volatile()`，改完对下一个任务立即生效，不用重载。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `notifyOn` | `[completed, error]` | 哪些结束原因要通知 |
| `backend` | `auto` | 通知后端 |
| `settleMs` | `800` | 结束后的静默期。期间又开始了新 turn，就不发通知 |
| `minTurnMs` | `1500` | 短于这个时长的 turn 视为「随口一问」，不通知 |
| `cooldownMs` | `2000` | 同一个 Session 两次通知的最小间隔 |
| `maxBodyChars` | `180` | 摘要最大字数 |
| `includeSubagents` | `false` | 是否也为子 Agent 通知 |
| `sound` | `true` | 播放系统提示音 |
| `showCwd` | `true` | 显示工作目录 |
| `appName` | `DeepSeek Harness` | 没有标题字段的后端用的应用名 |
| `soundName` | `Glass` | macOS 提示音名 |
| `senderBundleId` | `com.deepseek.dsh` | macOS：terminal-notifier 显示为哪个 App（仅名字与图标，不改权限） |
| `language` | `auto` | `auto` / `en` / `zh` |

### 为什么有「静默期」

一个任务经常不是一个 turn 就结束：Agent 可能连续跑好几轮，或者一个自动 goal 连续推进多轮。如果每轮都通知，你会被淹掉。

所以插件做三件事：

1. **静默期**（`settleMs`）：turn 结束后先等一会儿，期间如果又开始了新 turn，就不通知；
2. **最短时长**（`minTurnMs`）：太快结束的对话不打扰你；
3. **冷却**（`cooldownMs`）：同一个 Session 短时间内只提醒一次。

结果是：**一个任务一条通知**，而不是一轮一条。

## 测试

```bash
npm install
npm test
```

55 个测试覆盖：配置解析与兜底、文案生成、三种后端的参数拼装、AppleScript / XML 转义，以及静默期、最短时长、冷却、会话隔离、卸载清理这些时序规则。

`notify.js` 是纯逻辑，时钟和定时器都是注入的，所以时序测试不需要真的 sleep。

## 立即验证

在 DSH 里输入斜杠命令：

```
/notify-test
```

会立刻发一条测试通知。如果没弹出来，检查：

1. 系统是否允许该终端/应用发通知（macOS：系统设置 → 通知）；
2. `backend` 指向的程序是否存在：`which osascript` / `which terminal-notifier`；
3. DSH 日志里有没有 `turn-notify:` 开头的警告。

## 设计取舍

- **为什么监听 `turn/end` 而不是 `agent/status`**：`agent/status` 的 idle 只表示「这一刻没在跑」，它可能只是等下一个工具结果；而 `turn/end` 是日志里的持久事实，带结束原因，在 Web、Desktop、SDK、定时任务里含义完全一致。
- **为什么不写 Session 事件**：插件不往日志里追加任何东西，不注册 Tool，不注入 prompt 文本。模型完全感知不到它的存在，卸载它也不会在历史里留下痕迹。
- **为什么不用浏览器的 `Notification` API**：见上文「为什么是系统通知」。
- **为什么用 `execFile` 而不是 `ctx.subprocess` 发通知**：通知是「发了就走」的旁路动作，失败也不能影响 Agent。`execFile` 的失败被完整吞掉并记一条 warn；`resolveExecutable` 仍然走 `ctx.subprocess`，所以路径解析规则和宿主一致。

## 兼容性

- Node.js >= 20
- DSH >= 0.2.0-rc.2
- 无 Client 半侧，纯 Host 插件

## License

[MIT](LICENSE)
