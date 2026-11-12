# dsh-turn-notify

> A system notification the moment a task finishes, with its outcome, duration, and last reply. Failures notify too, so you can look away.

English | [简体中文](README.md)

A DeepSeek Harness plugin. It watches the Session log for `turn/end` and turns "a task just finished" into a real desktop notification.

## Why a system notification

Most "task finished" alerts live inside the web page as a toast. That toast is exactly what you miss when a task ends while you switched away, minimised the window, or closed it — which is precisely when you needed to know.

This plugin notifies from the **Host** side, through the operating system's own notification centre:

- the notification appears while the window is in the background, minimised, or the Web GUI is closed;
- it stays in the notification centre, so you can still see it when you come back;
- no browser permission, no requirement that the page be open.

## What a notification says

```
┌─────────────────────────────────────────┐
│ 🔔 Refactor the loader                   │  ← Session title
│    dsh-turn-notify                       │  ← working directory
│    Task completed · 42.6s · all 39 tests │  ← outcome · duration · last reply
└─────────────────────────────────────────┘
```

- **Outcome**: completed / error / cancelled / blocked / max tokens / interrupted / forked
- **Duration**: how long that turn actually took
- **Snippet**: the last assistant text of that turn, flattened to one line and clipped

## Install

```bash
# In DSH, ask the agent to install the bundle at /path/to/dsh-turn-notify
```

Or by hand:

```bash
cd ~/.dsh/profiles/<your profile>
pnpm add link:/path/to/dsh-turn-notify
```

Then add it to the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-turn-notify"]
    }
  }
}
```

After a restart the plugin inserts its own Host row.

## Backends

The plugin picks one automatically, and `backend` can force a specific one:

| Platform | Automatic order | Notes |
| --- | --- | --- |
| macOS | `terminal-notifier` → `osascript` | `osascript` ships with the OS, so this works out of the box; [terminal-notifier](https://github.com/julienXX/terminal-notifier) adds better grouping and click behaviour |
| Linux | `notify-send` | needs `libnotify` (`apt install libnotify-bin`) |
| Windows | `powershell` | native Windows toast notifications |

Every backend receives its arguments as **argv, never through a shell**: a Session title containing a quote, a semicolon, or `$(...)` stays data.

## Configuration

Edit the profile's `cordis.patch.yml`, or use **Settings → Plugins → Turn notifications**. Every field is `volatile()`, so a change applies to the next turn without reloading the row.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `notifyOn` | `[completed, error]` | Which turn outcomes notify |
| `backend` | `auto` | Notification backend |
| `settleMs` | `800` | Quiet period after a turn ends; a turn that resumes within it sends nothing |
| `minTurnMs` | `1500` | Turns shorter than this are quick replies and never notify |
| `cooldownMs` | `2000` | Minimum gap between two notifications for one Session |
| `maxBodyChars` | `180` | Maximum snippet length |
| `includeSubagents` | `false` | Also notify for subagent Sessions |
| `sound` | `true` | Play the system notification sound |
| `showCwd` | `true` | Show the working directory |
| `appName` | `DeepSeek Harness` | App name for backends without a title field |
| `soundName` | `Glass` | macOS sound name |
| `language` | `auto` | `auto` / `en` / `zh` |

### Why the quiet period exists

A task often takes more than one turn: the agent may run several rounds, or an automatic goal may advance round after round. Notifying once per round would bury you.

So the plugin does three things:

1. **Quiet period** (`settleMs`): after a turn ends it waits; if a new turn starts within that window, nothing is sent.
2. **Minimum duration** (`minTurnMs`): a conversation that ends too quickly does not interrupt you.
3. **Cooldown** (`cooldownMs`): one Session is reminded at most once in a short window.

The result is **one notification per task**, not one per round.

## Testing

```bash
npm install
npm test
```

55 tests cover configuration parsing and fallbacks, message rendering, argument construction for all three backends, AppleScript and XML escaping, and the timing rules — quiet period, minimum duration, cooldown, Session isolation, and unload cleanup.

`notify.js` is pure logic with injected clock and timers, so the timing tests never sleep.

## Try it now

In DSH, run the slash command:

```
/notify-test
```

A test notification appears immediately. If nothing shows up:

1. Check that the system allows this terminal/app to post notifications (macOS: System Settings → Notifications).
2. Check that the backend program exists: `which osascript` / `which terminal-notifier`.
3. Look for a warning starting with `turn-notify:` in the DSH log.

## Design notes

- **Why `turn/end` and not `agent/status`**: an idle status only means "not running right now", which may just be a pending tool result. `turn/end` is a durable fact in the log, it carries the reason it ended, and it means the same thing in Web, Desktop, the SDK, and a scheduled task.
- **Why it writes no Session events**: the plugin appends nothing to the log, registers no Tool, and injects no prompt text. The model cannot tell it exists, and uninstalling it leaves no trace in history.
- **Why not the browser `Notification` API**: see "Why a system notification" above.
- **Why `execFile` rather than `ctx.subprocess` to deliver**: a notification is a fire-and-forget side effect that must never affect the Agent. Its failure is fully contained and logged as one warning. Executable resolution still goes through `ctx.subprocess.resolveExecutable`, so path rules match the host's.

## Compatibility

- Node.js >= 20
- DSH >= 0.2.0-rc.2
- Host-only; no Client half

## License

[MIT](LICENSE)
