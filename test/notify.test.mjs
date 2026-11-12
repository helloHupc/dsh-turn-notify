import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OPTIONS,
  MESSAGES,
  TURN_END_KINDS,
  TurnTracker,
  backendCandidates,
  backendSpec,
  buildNotification,
  clipText,
  escapeAppleScript,
  escapeXml,
  normalizeWhitespace,
  notificationOwner,
  notificationSettingsUrl,
  resolveLanguage,
  resolveOptions,
  statusLine,
} from '../notify.js'

/** Build a fake clock plus a manual timer queue for deterministic tracker tests. */
function fakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = (nextId += 1)
      timers.set(id, { callback, at: now + ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += ms
      let ran = true
      while (ran) {
        ran = false
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(id)
          timer.callback()
          ran = true
        }
      }
    },
    pending: () => timers.size,
  }
}

/** Build a tracker whose options can be swapped mid-test. */
function makeTracker(overrides = {}) {
  const clock = fakeClock()
  const fired = []
  const options = resolveOptions({ ...DEFAULT_OPTIONS, ...overrides })
  const tracker = new TurnTracker(() => options, {
    fire: (plan) => fired.push(plan),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  return { clock, fired, tracker, options }
}

test('resolveOptions fills every default for an empty config', () => {
  const options = resolveOptions({})
  for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
    assert.deepEqual(options[key], value, `default for ${key}`)
  }
  assert.deepEqual(options.notifyOn, ['completed', 'error'])
})

test('resolveOptions drops unknown turn kinds instead of throwing', () => {
  const options = resolveOptions({ notifyOn: ['completed', 'nonsense', 'error'] })
  assert.deepEqual(options.notifyOn, ['completed', 'error'])
})

test('resolveOptions falls back when every requested kind is unknown', () => {
  const options = resolveOptions({ notifyOn: ['nonsense'] })
  assert.deepEqual(options.notifyOn, DEFAULT_OPTIONS.notifyOn)
})

test('resolveOptions de-duplicates the kinds it keeps', () => {
  const options = resolveOptions({ notifyOn: ['error', 'error', 'completed'] })
  assert.deepEqual(options.notifyOn, ['error', 'completed'])
})

test('resolveOptions rejects an unknown backend in favour of auto', () => {
  assert.equal(resolveOptions({ backend: 'carrier-pigeon' }).backend, 'auto')
  assert.equal(resolveOptions({ backend: 'osascript' }).backend, 'osascript')
})

test('resolveOptions clamps a negative or absurd number', () => {
  assert.equal(resolveOptions({ settleMs: -5 }).settleMs, 0)
  assert.equal(resolveOptions({ minTurnMs: Number.NaN }).minTurnMs, DEFAULT_OPTIONS.minTurnMs)
  assert.equal(resolveOptions({ maxBodyChars: 5 }).maxBodyChars, 20)
  assert.equal(resolveOptions({ cooldownMs: 1e9 }).cooldownMs, 600_000)
})

test('resolveOptions accepts a Config that carries live volatile fields', () => {
  const config = { enabled: { get: () => false }, settleMs: { get: () => 42 } }
  const flat = {}
  for (const key of Object.keys(config)) flat[key] = config[key].get()
  const options = resolveOptions(flat)
  assert.equal(options.enabled, false)
  assert.equal(options.settleMs, 42)
})

test('resolveLanguage honours an explicit setting', () => {
  assert.equal(resolveLanguage('zh', { LANG: 'en_US.UTF-8' }).id, 'zh')
  assert.equal(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' }).id, 'en')
})

test('resolveLanguage follows the environment for auto', () => {
  assert.equal(resolveLanguage('auto', { LANG: 'zh_CN.UTF-8' }).id, 'zh')
  assert.equal(resolveLanguage('auto', { LANG: 'en_US.UTF-8' }).id, 'en')
  assert.equal(resolveLanguage('auto', {}).id, 'en')
  assert.equal(resolveLanguage(undefined, { LC_ALL: 'zh_CN.UTF-8' }).id, 'zh')
})

test('normalizeWhitespace collapses lines and strips fenced code', () => {
  assert.equal(normalizeWhitespace('a\n\nb\tc'), 'a b c')
  assert.equal(normalizeWhitespace('see ```js\nconst a = 1\n``` done'), 'see done')
  assert.equal(normalizeWhitespace(undefined), '')
})

test('clipText keeps short text and ellipsizes long text on a word boundary', () => {
  assert.equal(clipText('short', 40), 'short')
  const clipped = clipText('alpha beta gamma delta epsilon zeta', 20)
  assert.ok(clipped.length <= 20)
  assert.ok(clipped.endsWith('…'))
  assert.ok(!clipped.includes('  '))
})

test('clipText does not leave a dangling space before the ellipsis', () => {
  assert.equal(clipText('aaaaaaaaaa bbbbbbbbbb', 12), 'aaaaaaaaaa…')
})

test('escapeAppleScript escapes backslash before quote', () => {
  assert.equal(escapeAppleScript('say "hi"'), 'say \\"hi\\"')
  assert.equal(escapeAppleScript('a\\b'), 'a\\\\b')
  assert.equal(escapeAppleScript('a\\"b'), 'a\\\\\\"b')
})

test('escapeXml escapes every metacharacter', () => {
  assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;')
})

test('statusLine appends a duration when one is known', () => {
  assert.equal(statusLine('completed', 3400, MESSAGES.en), 'Task completed · 3.4s')
  assert.equal(statusLine('completed', undefined, MESSAGES.en), 'Task completed')
  assert.equal(statusLine('error', 3400, MESSAGES.zh), '任务出错 · 3.4 秒')
})

test('statusLine falls back to completed for an unknown kind', () => {
  assert.equal(statusLine('mystery', undefined, MESSAGES.en), 'Task completed')
})

test('buildNotification uses the Session title as the headline', () => {
  const options = resolveOptions({})
  const notification = buildNotification({
    kind: 'completed',
    durationMs: 2000,
    snippet: 'All tests pass.',
    sessionTitle: 'Refactor the loader',
    cwd: '/Users/hupc/AgentTest/dsh-turn-notify',
    options,
  })
  assert.equal(notification.title, 'Refactor the loader')
  assert.equal(notification.subtitle, 'dsh-turn-notify')
  assert.equal(notification.body, 'Task completed · 2.0s · All tests pass.')
})

test('buildNotification falls back to the folder name without a title', () => {
  const options = resolveOptions({})
  const notification = buildNotification({
    kind: 'error',
    sessionTitle: '',
    cwd: '/Users/hupc/projects/alpha/',
    options,
  })
  assert.equal(notification.title, 'alpha')
  assert.equal(notification.subtitle, 'DeepSeek Harness')
  assert.equal(notification.group, 'alpha')
})

test('buildNotification omits the folder when showCwd is false', () => {
  const options = resolveOptions({ showCwd: false })
  const notification = buildNotification({
    kind: 'completed',
    snippet: 'done',
    sessionTitle: 'My task',
    cwd: '/tmp/alpha',
    options,
  })
  assert.equal(notification.subtitle, 'DeepSeek Harness')
  assert.equal(notification.body, 'Task completed · done')
})

test('buildNotification clips the snippet to the configured budget', () => {
  const options = resolveOptions({ maxBodyChars: 30 })
  const notification = buildNotification({
    kind: 'completed',
    snippet: 'x '.repeat(200),
    sessionTitle: 'Task',
    options,
  })
  assert.ok(notification.body.length <= 60)
  assert.ok(notification.body.endsWith('…'))
})

test('backendCandidates prefers osascript on macOS', () => {
  // osascript posts through Script Editor, which is a registered app with a
  // banner-capable default; a fresh terminal-notifier bundle defaults to
  // "Notification Center only" and never shows a banner until the user changes
  // it. Preferring the one that works out of the box is the whole point.
  assert.deepEqual(backendCandidates('darwin', 'auto'), ['osascript', 'terminal-notifier'])
  assert.deepEqual(backendCandidates('linux', 'auto'), ['notify-send'])
  assert.deepEqual(backendCandidates('win32', 'auto'), ['powershell'])
  assert.deepEqual(backendCandidates('aix', 'auto'), [])
})

test('notificationOwner names the application macOS attributes the banner to', () => {
  assert.deepEqual(notificationOwner('osascript'), {
    bundleId: 'com.apple.ScriptEditor2',
    app: 'Script Editor',
    appZh: '脚本编辑器',
  })
  assert.equal(notificationOwner('terminal-notifier').bundleId, 'fr.julienxx.oss.terminal-notifier')
  assert.equal(notificationOwner('notify-send'), undefined)
})

test('notificationSettingsUrl deep-links to one app page', () => {
  const url = notificationSettingsUrl('com.apple.ScriptEditor2')
  assert.ok(url.startsWith('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id='))
  assert.ok(url.endsWith(encodeURIComponent('com.apple.ScriptEditor2')))
})

test('backendCandidates honours an explicit choice', () => {
  assert.deepEqual(backendCandidates('darwin', 'osascript'), ['osascript'])
  assert.deepEqual(backendCandidates('darwin', 'bogus'), [])
})

test('backendSpec builds an osascript notification with an escaped script', () => {
  const options = resolveOptions({ sound: true, soundName: 'Glass' })
  const spec = backendSpec(
    'osascript',
    { title: 'T', subtitle: 'S', body: 'say "hi"', group: 'g' },
    options,
  )
  assert.equal(spec.command, 'osascript')
  assert.equal(spec.args[0], '-e')
  assert.match(spec.args[1], /^display notification "say \\"hi\\""/)
  assert.match(spec.args[1], /sound name "Glass"/)
})

test('backendSpec omits the sound when disabled', () => {
  const options = resolveOptions({ sound: false })
  const spec = backendSpec('osascript', { title: 'T', subtitle: '', body: 'b', group: 'g' }, options)
  assert.ok(!spec.args[1].includes('sound name'))
})

test('backendSpec passes terminal-notifier flags as separate argv entries', () => {
  const options = resolveOptions({ sound: true, senderBundleId: 'com.deepseek.dsh' })
  const spec = backendSpec(
    'terminal-notifier',
    { title: 'T', subtitle: 'S', body: 'B', group: 'g' },
    options,
  )
  assert.deepEqual(spec.args, [
    '-title', 'T',
    '-message', 'B',
    '-group', 'g',
    '-subtitle', 'S',
    '-sound', 'Glass',
    '-sender', 'com.deepseek.dsh',
  ])
})

test('backendSpec omits -sender when the bundle id is blank', () => {
  const options = resolveOptions({ senderBundleId: '' })
  const spec = backendSpec('terminal-notifier', { title: 'T', subtitle: '', body: 'B', group: 'g' }, options)
  assert.ok(!spec.args.includes('-sender'))
})

test('backendSpec builds notify-send arguments', () => {
  const options = resolveOptions({})
  const spec = backendSpec('notify-send', { title: 'T', subtitle: 'S', body: 'B', group: 'g' }, options)
  assert.equal(spec.command, 'notify-send')
  assert.deepEqual(spec.args, ['--app-name', 'DeepSeek Harness', '--urgency', 'normal', 'T', 'S — B'])
})

test('backendSpec builds a powershell toast with escaped xml', () => {
  const options = resolveOptions({})
  const spec = backendSpec('powershell', { title: 'a&b', subtitle: '', body: '<c>', group: 'g' }, options)
  assert.equal(spec.command, 'powershell')
  const script = spec.args.at(-1)
  assert.ok(script.includes('a&amp;b'))
  assert.ok(script.includes('&lt;c&gt;'))
})

test('backendSpec returns null for an unknown backend', () => {
  assert.equal(backendSpec('smoke-signal', { title: 'T', subtitle: '', body: 'B', group: 'g' }, resolveOptions({})), null)
})

test('TurnTracker notifies once a turn settles', () => {
  const { clock, fired, tracker } = makeTracker({ minTurnMs: 1000, settleMs: 800 })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  tracker.onTurnEnd('s1', 'completed', { snippet: 'ok' })
  assert.equal(fired.length, 0, 'nothing fires before the quiet period')
  clock.advance(800)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, 'completed')
  assert.equal(fired[0].durationMs, 5000)
})

test('TurnTracker ignores a turn shorter than minTurnMs', () => {
  const { clock, fired, tracker } = makeTracker({ minTurnMs: 1500 })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(200)
  assert.equal(tracker.onTurnEnd('s1', 'completed', {}), false)
  clock.advance(5000)
  assert.equal(fired.length, 0)
})

test('TurnTracker ignores a kind that is not configured', () => {
  const { clock, fired, tracker } = makeTracker({ notifyOn: ['error'] })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  assert.equal(tracker.onTurnEnd('s1', 'completed', {}), false)
  clock.advance(5000)
  assert.equal(fired.length, 0)
})

test('TurnTracker cancels a settling notice when the turn resumes', () => {
  const { clock, fired, tracker } = makeTracker({ settleMs: 800 })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  tracker.onTurnEnd('s1', 'completed', {})
  clock.advance(400)
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  assert.equal(fired.length, 0, 'a resumed turn is one task, not two')
  assert.equal(clock.pending(), 0)
})

test('TurnTracker collapses two turns inside the cooldown window', () => {
  const { clock, fired, tracker } = makeTracker({ settleMs: 0, cooldownMs: 2000, minTurnMs: 0 })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(3000)
  tracker.onTurnEnd('s1', 'completed', {})
  clock.advance(0)
  assert.equal(fired.length, 1)
  tracker.onTurnStart('s1', clock.now())
  clock.advance(1000)
  assert.equal(tracker.onTurnEnd('s1', 'completed', {}), false)
  clock.advance(3000)
  assert.equal(fired.length, 1, 'the second turn stays quiet inside the cooldown')
})

test('TurnTracker keeps Sessions independent', () => {
  const { clock, fired, tracker } = makeTracker({ settleMs: 0, cooldownMs: 0 })
  tracker.onTurnStart('a', clock.now())
  tracker.onTurnStart('b', clock.now())
  clock.advance(4000)
  tracker.onTurnEnd('a', 'completed', {})
  clock.advance(0)
  tracker.onTurnEnd('b', 'error', {})
  clock.advance(0)
  assert.deepEqual(fired.map((plan) => plan.sessionId), ['a', 'b'])
  assert.deepEqual(fired.map((plan) => plan.kind), ['completed', 'error'])
})

test('TurnTracker reports no duration when the start was not observed', () => {
  const { clock, fired, tracker } = makeTracker({ settleMs: 0, cooldownMs: 0 })
  clock.advance(1000)
  tracker.onTurnEnd('s1', 'completed', {})
  clock.advance(0)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].durationMs, undefined)
})

test('TurnTracker forgets a disposed Session', () => {
  const { clock, fired, tracker } = makeTracker({ settleMs: 800 })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  tracker.onTurnEnd('s1', 'completed', {})
  tracker.forget('s1')
  assert.equal(clock.pending(), 0)
  clock.advance(5000)
  assert.equal(fired.length, 0)
})

test('TurnTracker dispose cancels everything and refuses new work', () => {
  const { clock, fired, tracker } = makeTracker({ settleMs: 800 })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  tracker.onTurnEnd('s1', 'completed', {})
  tracker.dispose()
  assert.equal(clock.pending(), 0)
  clock.advance(5000)
  assert.equal(fired.length, 0)
  assert.equal(tracker.onTurnEnd('s1', 'completed', {}), false)
})

test('TurnTracker reads options live, so a Settings edit applies immediately', () => {
  const clock = fakeClock()
  const fired = []
  let options = resolveOptions({ settleMs: 0, cooldownMs: 0 })
  const tracker = new TurnTracker(() => options, {
    fire: (plan) => fired.push(plan),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  tracker.onTurnStart('s1', clock.now())
  clock.advance(5000)
  options = { ...options, enabled: false }
  assert.equal(tracker.onTurnEnd('s1', 'completed', {}), false)
  clock.advance(0)
  assert.equal(fired.length, 0)
})

test('every configured turn kind has a message in both languages', () => {
  for (const kind of TURN_END_KINDS) {
    assert.equal(typeof MESSAGES.en[kind], 'string', `en message for ${kind}`)
    assert.equal(typeof MESSAGES.zh[kind], 'string', `zh message for ${kind}`)
  }
})
