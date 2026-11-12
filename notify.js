/**
 * `dsh-turn-notify` — pure notification logic.
 *
 * Everything in this module is side-effect free except the two tiny classes at
 * the bottom, which take their clock and timers by injection. `index.js` wires
 * these helpers to Cordis; `test/*.test.mjs` exercises them without a Host.
 *
 * Keeping the decision logic here is deliberate: what counts as "a task
 * finished", how a notification reads, and which OS command carries it are the
 * parts worth testing, and none of them needs an Agent, a Session, or a
 * subprocess to answer.
 *
 * @module dsh-turn-notify/notify
 */

/**
 * Every `turn/end` reason the Session log can carry. A configuration that
 * names an unknown kind is rejected here rather than silently never firing.
 */
export const TURN_END_KINDS = [
  'completed',
  'error',
  'aborted',
  'blocked',
  'max-tokens',
  'interrupted',
  'forked',
]

/** Notification backends this plugin can drive, in the order `auto` prefers them. */
export const BACKENDS = [
  'terminal-notifier',
  'osascript',
  'notify-send',
  'powershell',
]

/**
 * Defaults for every Config field.
 *
 * They are also the fallback when a field is missing, so a profile that
 * installed an older row without the field keeps working instead of throwing.
 */
export const DEFAULT_OPTIONS = {
  enabled: true,
  notifyOn: ['completed', 'error'],
  backend: 'auto',
  settleMs: 800,
  minTurnMs: 1500,
  cooldownMs: 2000,
  maxBodyChars: 180,
  includeSubagents: false,
  sound: true,
  showCwd: true,
  appName: 'DeepSeek Harness',
  soundName: 'Glass',
  language: 'auto',
}

/** Visible text owned by this plugin, keyed by the resolved language. */
export const MESSAGES = {
  en: {
    completed: 'Task completed',
    error: 'Task failed',
    aborted: 'Task cancelled',
    blocked: 'Task blocked',
    'max-tokens': 'Output limit reached',
    interrupted: 'Task interrupted',
    forked: 'Task forked',
    seconds: (value) => `${value.toFixed(1)}s`,
    testTitle: 'Test notification',
    testBody: 'Notifications work. You will hear from this plugin when a task finishes.',
    testCommand: 'Test notification sent.',
    disabled: 'Turn notifications are disabled in this plugin configuration.',
    noBackend: 'No notification backend is available on this system.',
  },
  zh: {
    completed: '任务完成',
    error: '任务出错',
    aborted: '任务已取消',
    blocked: '任务被阻止',
    'max-tokens': '输出达到上限',
    interrupted: '任务被中断',
    forked: '任务已分叉',
    seconds: (value) => `${value.toFixed(1)} 秒`,
    testTitle: '测试通知',
    testBody: '通知可用。之后每个任务结束时都会收到一条通知。',
    testCommand: '测试通知已发送。',
    disabled: '该插件配置已关闭任务通知。',
    noBackend: '当前系统没有可用的通知后端。',
  },
}

/**
 * Pick the message table for one language setting.
 *
 * `auto` reads the ambient locale the Host was started with. There is no Host
 * locale service to ask — locale is a browser concern — so the environment is
 * the only honest signal, and an unrecognized value simply means English.
 *
 * @param {string | undefined} language - `auto`, `en`, or `zh`.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {{ id: 'en' | 'zh', table: typeof MESSAGES.en }} the resolved language.
 */
export function resolveLanguage(language, env = process.env) {
  const wanted = typeof language === 'string' ? language.trim().toLowerCase() : 'auto'
  if (wanted === 'zh' || wanted === 'en') return { id: wanted, table: MESSAGES[wanted] }
  const hint = [env.DSH_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return hint.includes('zh') ? { id: 'zh', table: MESSAGES.zh } : { id: 'en', table: MESSAGES.en }
}

/**
 * Clamp one numeric Config field.
 *
 * A schema violation is normally caught by the Loader, but a hand-edited row
 * can still carry a negative or absurd value, and a negative timeout would
 * make every notification fire immediately.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value to use when the candidate is not a number.
 * @param {{ min?: number, max?: number }} [range] - inclusive bounds.
 * @returns {number} the clamped number.
 */
function clampNumber(value, fallback, range = {}) {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const min = range.min ?? 0
  const max = range.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(min, Math.round(candidate)))
}

/**
 * Normalize one Config object into the shape the rest of the plugin reads.
 *
 * Unknown `notifyOn` kinds are dropped rather than throwing: a typo should cost
 * one notification kind, not the whole plugin.
 *
 * @param {Record<string, unknown> | undefined} config - raw row config.
 * @param {Record<string, string | undefined>} [env] - environment for `auto`.
 * @returns {typeof DEFAULT_OPTIONS & { languageId: 'en' | 'zh', messages: typeof MESSAGES.en }} resolved options.
 */
export function resolveOptions(config, env = process.env) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const kinds = Array.isArray(source.notifyOn)
    ? source.notifyOn.filter((kind) => TURN_END_KINDS.includes(kind))
    : DEFAULT_OPTIONS.notifyOn
  const backend = typeof source.backend === 'string' && (source.backend === 'auto' || BACKENDS.includes(source.backend))
    ? source.backend
    : DEFAULT_OPTIONS.backend
  const { id, table } = resolveLanguage(source.language, env)
  return {
    enabled: source.enabled === undefined ? DEFAULT_OPTIONS.enabled : source.enabled === true,
    notifyOn: kinds.length > 0 ? [...new Set(kinds)] : DEFAULT_OPTIONS.notifyOn,
    backend,
    settleMs: clampNumber(source.settleMs, DEFAULT_OPTIONS.settleMs, { min: 0, max: 60_000 }),
    minTurnMs: clampNumber(source.minTurnMs, DEFAULT_OPTIONS.minTurnMs, { min: 0, max: 3_600_000 }),
    cooldownMs: clampNumber(source.cooldownMs, DEFAULT_OPTIONS.cooldownMs, { min: 0, max: 600_000 }),
    maxBodyChars: clampNumber(source.maxBodyChars, DEFAULT_OPTIONS.maxBodyChars, { min: 20, max: 1_000 }),
    includeSubagents: source.includeSubagents === true,
    sound: source.sound === undefined ? DEFAULT_OPTIONS.sound : source.sound === true,
    showCwd: source.showCwd === undefined ? DEFAULT_OPTIONS.showCwd : source.showCwd === true,
    appName: typeof source.appName === 'string' && source.appName.trim() !== '' ? source.appName.trim() : DEFAULT_OPTIONS.appName,
    soundName: typeof source.soundName === 'string' && source.soundName.trim() !== '' ? source.soundName.trim() : DEFAULT_OPTIONS.soundName,
    language: typeof source.language === 'string' ? source.language : DEFAULT_OPTIONS.language,
    languageId: id,
    messages: table,
  }
}

/**
 * Collapse one string to a single line of visible text.
 *
 * Notification titles and bodies are one line each on every platform; a
 * Markdown heading or a code fence would otherwise survive into the banner.
 *
 * @param {unknown} value - candidate text.
 * @returns {string} the normalized text, empty when there is nothing to show.
 */
export function normalizeWhitespace(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Clip text to a display budget on a word boundary when possible.
 *
 * @param {unknown} value - candidate text.
 * @param {number} max - maximum number of characters.
 * @returns {string} the clipped text, with an ellipsis when it was shortened.
 */
export function clipText(value, max) {
  const text = normalizeWhitespace(value)
  const limit = Math.max(1, Math.floor(max))
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const boundary = cut.lastIndexOf(' ')
  const head = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut
  return `${head.trimEnd()}…`
}

/**
 * Escape one string for an AppleScript double-quoted literal.
 *
 * Backslash first, then the quote: reversing the order would double-escape the
 * backslashes this function just introduced.
 *
 * @param {unknown} value - raw text.
 * @returns {string} text safe to place between two `"` characters.
 */
export function escapeAppleScript(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

/**
 * Escape one string for XML text or attribute content.
 *
 * @param {unknown} value - raw text.
 * @returns {string} escaped text.
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Render the status line for one finished turn.
 *
 * @param {string} kind - `turn/end` reason kind.
 * @param {number | undefined} durationMs - measured turn length, when known.
 * @param {typeof MESSAGES.en} messages - message table for the active language.
 * @returns {string} the status line.
 */
export function statusLine(kind, durationMs, messages) {
  const label = messages[kind] ?? messages.completed
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return label
  return `${label} · ${messages.seconds(durationMs / 1000)}`
}

/**
 * Build the platform-neutral notification a backend will render.
 *
 * @param {object} input - one finished turn.
 * @param {string} input.kind - `turn/end` reason kind.
 * @param {number} [input.durationMs] - measured turn length.
 * @param {string} [input.snippet] - last assistant text of that turn.
 * @param {string} [input.sessionTitle] - durable Session title.
 * @param {string} [input.cwd] - Session working directory.
 * @param {typeof DEFAULT_OPTIONS & { messages: typeof MESSAGES.en }} input.options - resolved options.
 * @returns {{ title: string, subtitle: string, body: string, group: string }} the notification.
 */
export function buildNotification({ kind, durationMs, snippet, sessionTitle, cwd, options }) {
  const messages = options.messages
  const folder = typeof cwd === 'string' && cwd !== '' ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '' : ''
  const title = normalizeWhitespace(sessionTitle) || (options.showCwd && folder !== '' ? folder : options.appName)
  const subtitle = options.showCwd && folder !== '' && title !== folder ? folder : options.appName
  const head = statusLine(kind, durationMs, messages)
  const tail = clipText(snippet, options.maxBodyChars)
  return {
    title,
    subtitle,
    body: tail === '' ? head : `${head} · ${tail}`,
    group: normalizeWhitespace(sessionTitle) || folder || options.appName,
  }
}

/**
 * List the backends to try, most preferred first.
 *
 * @param {string} platform - `process.platform`.
 * @param {string} configured - configured backend, or `auto`.
 * @returns {string[]} backend names; empty when this platform has none.
 */
export function backendCandidates(platform, configured) {
  if (configured !== 'auto') return BACKENDS.includes(configured) ? [configured] : []
  switch (platform) {
    case 'darwin':
      return ['terminal-notifier', 'osascript']
    case 'linux':
      return ['notify-send']
    case 'win32':
      return ['powershell']
    default:
      return []
  }
}

/**
 * Render one backend invocation.
 *
 * Every backend receives the notification as argv, never through a shell, so a
 * Session title containing a quote or a semicolon stays data.
 *
 * @param {string} backend - one of {@link BACKENDS}.
 * @param {{ title: string, subtitle: string, body: string, group: string }} notification - the notification.
 * @param {typeof DEFAULT_OPTIONS} options - resolved options.
 * @returns {{ command: string, args: string[] } | null} the invocation, or null when unknown.
 */
export function backendSpec(backend, notification, options) {
  const { title, subtitle, body, group } = notification
  switch (backend) {
    case 'osascript': {
      const sound = options.sound ? ` sound name "${escapeAppleScript(options.soundName)}"` : ''
      const script = [
        `display notification "${escapeAppleScript(body)}"`,
        ` with title "${escapeAppleScript(title)}"`,
        subtitle === '' ? '' : ` subtitle "${escapeAppleScript(subtitle)}"`,
        sound,
      ].join('')
      return { command: 'osascript', args: ['-e', script] }
    }
    case 'terminal-notifier': {
      const args = ['-title', title, '-message', body, '-group', group]
      if (subtitle !== '') args.push('-subtitle', subtitle)
      if (options.sound) args.push('-sound', options.soundName)
      return { command: 'terminal-notifier', args }
    }
    case 'notify-send': {
      const args = ['--app-name', options.appName, '--urgency', 'normal']
      if (subtitle !== '') args.push(title, `${subtitle} — ${body}`)
      else args.push(title, body)
      return { command: 'notify-send', args }
    }
    case 'powershell': {
      const xml = [
        '<toast>',
        '<visual><binding template="ToastGeneric">',
        `<text>${escapeXml(title)}</text>`,
        subtitle === '' ? '' : `<text>${escapeXml(subtitle)}</text>`,
        `<text>${escapeXml(body)}</text>`,
        '</binding></visual>',
        options.sound ? '<audio silent="false"/>' : '<audio silent="true"/>',
        '</toast>',
      ].join('')
      const script = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
        `$xml = [Windows.Data.Xml.Dom.XmlDocument]::new(); $xml.LoadXml('${xml.replace(/'/g, "''")}')`,
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(',
        '  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($toast)',
      ].join('\n')
      return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
    }
    default:
      return null
  }
}

/**
 * Decide whether one finished turn is worth a notification, and when.
 *
 * The tracker owns the three rules that keep the feature quiet rather than
 * noisy, all of them derived from the Session log alone:
 *
 *  - a turn shorter than `minTurnMs` is a quick reply, not a task;
 *  - turns separated by less than `cooldownMs` collapse into one notice;
 *  - a turn that starts while a notice is still settling cancels it, so an
 *    automatic goal round is one task instead of one notice per round.
 *
 * `fire` is called once per surviving turn, after `settleMs` of quiet.
 */
export class TurnTracker {
  /**
   * @param {() => typeof DEFAULT_OPTIONS} getOptions - reads the live options, so a
   *   Settings edit takes effect on the next turn without reloading the plugin.
   * @param {object} hooks - injected clock, timers, and sink.
   * @param {(plan: { sessionId: string, kind: string, durationMs?: number, payload: unknown }) => void} hooks.fire - notification sink.
   * @param {() => number} [hooks.now] - wall clock.
   * @param {(callback: () => void, ms: number) => unknown} [hooks.setTimeout] - timer.
   * @param {(handle: unknown) => void} [hooks.clearTimeout] - timer cancellation.
   */
  constructor(getOptions, hooks) {
    this.getOptions = getOptions
    this.fire = hooks.fire
    this.now = hooks.now ?? (() => Date.now())
    this.setTimer = hooks.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = hooks.clearTimeout ?? ((handle) => clearTimeout(handle))
    /** @type {Map<string, number>} session → turn start time. */
    this.starts = new Map()
    /** @type {Map<string, number>} session → last notification time. */
    this.lastNotice = new Map()
    /** @type {Map<string, { handle: unknown, plan: object }>} session → settling notice. */
    this.pending = new Map()
    this.disposed = false
  }

  /**
   * Record that a turn began.
   *
   * A settling notice for the same Session is cancelled here: the work clearly
   * continues, so announcing the previous turn would be premature.
   *
   * @param {string} sessionId - Session identity.
   * @param {number} [time] - start time, defaulting to now.
   */
  onTurnStart(sessionId, time = this.now()) {
    if (this.disposed) return
    this.starts.set(sessionId, time)
    this.cancelPending(sessionId)
  }

  /**
   * Record that a turn ended, scheduling a notice when the rules allow one.
   *
   * @param {string} sessionId - Session identity.
   * @param {string} kind - `turn/end` reason kind.
   * @param {object} payload - opaque data forwarded to `fire`.
   * @param {number} [time] - end time, defaulting to now.
   * @returns {boolean} whether a notice was scheduled.
   */
  onTurnEnd(sessionId, kind, payload, time = this.now()) {
    if (this.disposed) return false
    const options = this.getOptions()
    if (!options.enabled) return false
    if (!options.notifyOn.includes(kind)) return false
    const started = this.starts.get(sessionId)
    this.starts.delete(sessionId)
    const durationMs = started === undefined ? undefined : Math.max(0, time - started)
    if (durationMs !== undefined && durationMs < options.minTurnMs) return false
    const previous = this.lastNotice.get(sessionId)
    if (previous !== undefined && time - previous < options.cooldownMs) return false

    this.cancelPending(sessionId)
    const plan = { sessionId, kind, durationMs, payload }
    const handle = this.setTimer(() => {
      this.pending.delete(sessionId)
      if (this.disposed) return
      this.lastNotice.set(sessionId, this.now())
      this.fire(plan)
    }, options.settleMs)
    this.pending.set(sessionId, { handle, plan })
    return true
  }

  /**
   * Drop any settling notice for one Session.
   * @param {string} sessionId - Session identity.
   */
  cancelPending(sessionId) {
    const entry = this.pending.get(sessionId)
    if (entry === undefined) return
    this.clearTimer(entry.handle)
    this.pending.delete(sessionId)
  }

  /**
   * Forget every fact about one Session.
   * @param {string} sessionId - Session identity.
   */
  forget(sessionId) {
    this.cancelPending(sessionId)
    this.starts.delete(sessionId)
    this.lastNotice.delete(sessionId)
  }

  /** Cancel every settling notice and refuse further work. */
  dispose() {
    this.disposed = true
    for (const sessionId of [...this.pending.keys()]) this.cancelPending(sessionId)
    this.starts.clear()
    this.lastNotice.clear()
  }
}
