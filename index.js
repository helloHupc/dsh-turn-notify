/**
 * `dsh-turn-notify` — Host half.
 *
 * Turns one durable Session event, `turn/end`, into a desktop notification.
 * That is the whole feature, and it is deliberately built on the log rather
 * than on `agent/status`: a turn that ends is a task that finished, it carries
 * the reason it ended, and it is the same fact on every entry point (Web,
 * Desktop, SDK, a scheduled task) instead of one transport's view of idleness.
 *
 * The plugin touches nothing the model can see. It appends no Session event,
 * registers no Tool, contributes no prompt text, and holds no state beyond the
 * quiet-period timers it owns.
 *
 * Why the notification goes through a subprocess instead of the browser's
 * `Notification` API: the Web GUI may be closed, hidden, or unfocused exactly
 * when a task finishes, and a notification the page renders is a notification
 * nobody sees. `ctx.subprocess` runs the platform's own notifier — which the
 * OS displays whether or not this app is in front — with argv only, never a
 * shell, so a Session title stays data.
 *
 * @module dsh-turn-notify
 */

import { execFile } from 'node:child_process'
import z from '@deepseek-ai/schemastery'

import {
  BACKENDS,
  DEFAULT_OPTIONS,
  TURN_END_KINDS,
  TurnTracker,
  backendCandidates,
  backendSpec,
  buildNotification,
  clipText,
  normalizeWhitespace,
  notificationOwner,
  resolveOptions,
} from './notify.js'

/** Plugin identity for the Loader row in `cordis.patch.yml`. */
export const name = 'dsh-turn-notify'

/**
 * No `inject` on purpose.
 *
 * Every service this plugin wants is an improvement, never a requirement:
 * `sessionTitle` makes the headline nicer, `subprocess` resolves a notifier
 * path, `commands` adds `/notify-test`. All three are read with `ctx.get(...)`,
 * which yields `undefined` in a profile that dropped them, so the plugin still
 * activates and still notifies instead of sitting in `pending` forever.
 *
 * The one thing it does require is the `session/event` feed, and that is an
 * event rather than a service: a listener on an event nobody emits is simply
 * never called, which is the correct degradation.
 */

/**
 * The plugin's Config schema. DSH generates the settings page from it, so this
 * plugin ships no settings UI of its own.
 *
 * Every field is `volatile()`: the notification path reads them per turn, so a
 * change made in Settings applies to the next turn without reloading the row.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(DEFAULT_OPTIONS.enabled)
    .description('Turn notifications on or off without uninstalling the plugin.')
    .volatile(),
  notifyOn: z
    .array(z.union(TURN_END_KINDS))
    .default(DEFAULT_OPTIONS.notifyOn)
    .description('Which turn outcomes notify: completed, error, aborted, blocked, max-tokens, interrupted, forked.')
    .volatile(),
  backend: z
    .union(['auto', ...BACKENDS])
    .default(DEFAULT_OPTIONS.backend)
    .description('Notification backend. auto picks the best one this platform offers.')
    .volatile(),
  settleMs: z
    .natural()
    .default(DEFAULT_OPTIONS.settleMs)
    .description('Quiet period after a turn ends. A turn that resumes within it sends no notification.')
    .volatile(),
  minTurnMs: z
    .natural()
    .default(DEFAULT_OPTIONS.minTurnMs)
    .description('Turns shorter than this are quick replies and never notify.')
    .volatile(),
  cooldownMs: z
    .natural()
    .default(DEFAULT_OPTIONS.cooldownMs)
    .description('Minimum gap between two notifications for the same Session.')
    .volatile(),
  maxBodyChars: z
    .natural()
    .default(DEFAULT_OPTIONS.maxBodyChars)
    .description('Maximum length of the assistant-text snippet in the notification body.')
    .volatile(),
  includeSubagents: z
    .boolean()
    .default(DEFAULT_OPTIONS.includeSubagents)
    .description('Also notify for subagent Sessions, not just top-level conversations.')
    .volatile(),
  sound: z
    .boolean()
    .default(DEFAULT_OPTIONS.sound)
    .description('Play the platform notification sound.')
    .volatile(),
  showCwd: z
    .boolean()
    .default(DEFAULT_OPTIONS.showCwd)
    .description('Show the Session working directory in the notification.')
    .volatile(),
  appName: z
    .string()
    .default(DEFAULT_OPTIONS.appName)
    .description('App name shown by backends that have no title field of their own.')
    .volatile(),
  soundName: z
    .string()
    .default(DEFAULT_OPTIONS.soundName)
    .description('macOS sound name, for example Glass, Ping, or Submarine.')
    .volatile(),
  senderBundleId: z
    .string()
    .default(DEFAULT_OPTIONS.senderBundleId)
    .description(
      'macOS: bundle id terminal-notifier shows as the sender (name and icon only; the alert style stays with its own app). Blank to disable.',
    )
    .volatile(),
  language: z
    .union(['auto', 'en', 'zh'])
    .default(DEFAULT_OPTIONS.language)
    .description('Language of the notification text. auto follows the Host locale.')
    .volatile(),
})

/**
 * Read one Config field, accepting both shapes a schema can produce.
 *
 * A `volatile()` field arrives as a live reference (`.get()`); a plain field
 * arrives as the value itself. Both are accepted so a schema edit that drops
 * `volatile()` cannot break the notification path.
 *
 * @param {unknown} field - the Config field in either shape.
 * @returns {unknown} the current value.
 */
function readField(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * Project the whole Config object into the plain shape the helpers read.
 *
 * @param {Record<string, unknown> | undefined} config - resolved Config.
 * @returns {Record<string, unknown>} the flattened values.
 */
function readConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const flat = {}
  for (const key of Object.keys(source)) flat[key] = readField(source[key])
  return flat
}

/** Render an unknown thrown value as a message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extract the plain text of one message's content blocks.
 *
 * @param {{ content?: unknown }} message - a Session message.
 * @returns {string} the concatenated text, without reasoning blocks.
 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return normalizeWhitespace(parts.join(' '))
}

/**
 * Read the last assistant text of one turn from the Session log.
 *
 * The snippet is what makes a notification useful: "任务完成" alone says nothing
 * about which task. Only assistant messages of that exact turn are considered,
 * so the body belongs to the turn that just ended.
 *
 * @param {object} session - live Session.
 * @param {number} turn - turn number that ended.
 * @returns {string} the last assistant text, or an empty string.
 */
function lastAssistantText(session, turn) {
  try {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      if (event.data?.turn !== turn) continue
      const text = textOf(event.data.message)
      if (text !== '') return text
    }
  } catch {
    // A disposed or replaying Session cannot be read; the body falls back to
    // the status line, which is still a useful notification.
  }
  return ''
}

/**
 * Resolve the Session title, preferring the durable folded title.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} session - live Session.
 * @returns {string} the title, or an empty string.
 */
function sessionTitleOf(ctx, session) {
  try {
    const title = ctx.get('sessionTitle')?.get(session)
    if (typeof title?.title === 'string' && title.title.trim() !== '') return title.title.trim()
  } catch {
    // No title service, or no folded title yet.
  }
  return ''
}

/**
 * Ask the Host whether a Session is a subagent's.
 *
 * Subagents end their turns constantly and their notifications would bury the
 * ones a person actually wants, so they are opt-in.
 *
 * @param {object} session - live Session.
 * @returns {boolean} true for a child Session.
 */
function isSubagent(session) {
  const header = session?.header
  if (header === undefined || header === null) return false
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/**
 * Locate a backend executable on `PATH` without starting it.
 *
 * `resolveExecutable` is the documented way, but it is async and the result is
 * cached for the life of the process, so the probe runs once per candidate.
 *
 * @param {object} ctx - Host plugin context.
 * @param {string} command - executable name.
 * @returns {Promise<string | undefined>} the resolved path, when present.
 */
async function resolveCommand(ctx, command) {
  const subprocess = ctx.get('subprocess')
  if (subprocess !== undefined && typeof subprocess.resolveExecutable === 'function') {
    try {
      return await subprocess.resolveExecutable(command)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Run one notification command and swallow every failure.
 *
 * A missing notifier, a denied permission, or a closed session must never
 * disturb the Agent, so this never throws and never rejects.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {(error: unknown) => void} onError - called with any failure.
 */
function run(command, args, onError) {
  try {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => {
      if (error !== null && error !== undefined) onError(error)
    })
  } catch (error) {
    onError(error)
  }
}

/**
 * Register the turn listener for the lifetime of this plugin's fiber.
 *
 * @param {object} ctx - Host plugin context.
 * @param {Record<string, unknown> | undefined} config - resolved Config.
 */
export function apply(ctx, config) {
  const logger = ctx.logger

  /** Live options; a Settings edit lands here on the next read. */
  const currentOptions = () => resolveOptions(readConfig(config))

  /**
   * Backend discovery is lazy and cached: the probe spawns nothing, but it is
   * async and there is no reason to repeat it for every turn.
   *
   * @type {{ backend: string, path: string } | undefined}
   */
  let backendChoice = undefined
  /** @type {Promise<{ backend: string, path: string } | undefined> | undefined} */
  let backendProbe = undefined

  /**
   * Resolve the backend to use, once.
   *
   * A failed probe is retried on the next notification, so installing a
   * notifier mid-session starts working without a restart. The resolved
   * absolute path is what gets executed, so a `PATH` change mid-session cannot
   * silently redirect a notification to a different binary.
   *
   * @param {typeof DEFAULT_OPTIONS} options - resolved options.
   * @returns {Promise<{ backend: string, path: string } | undefined>} the choice.
   */
  async function chooseBackend(options) {
    if (backendChoice !== undefined) return backendChoice
    if (backendProbe === undefined) {
      backendProbe = (async () => {
        for (const candidate of backendCandidates(process.platform, options.backend)) {
          const resolved = await resolveCommand(ctx, candidate)
          if (resolved !== undefined) return { backend: candidate, path: resolved }
        }
        return undefined
      })()
    }
    const found = await backendProbe
    if (found !== undefined) backendChoice = found
    else backendProbe = undefined
    return found
  }

  /**
   * Deliver one notification.
   *
   * @param {{ sessionId: string, kind: string, durationMs?: number, payload: object }} plan - the settled turn.
   */
  function notify(plan) {
    const options = currentOptions()
    if (!options.enabled) return
    const { session, snippet } = plan.payload
    const notification = buildNotification({
      kind: plan.kind,
      durationMs: plan.durationMs,
      snippet,
      sessionTitle: sessionTitleOf(ctx, session),
      cwd: session?.header?.cwd,
      options,
    })
    void chooseBackend(options).then((choice) => {
      if (choice === undefined) {
        logger.warn('turn-notify: no notification backend available; install terminal-notifier, or check notify-send / powershell')
        return
      }
      const spec = backendSpec(choice.backend, notification, options)
      if (spec === null) return
      run(choice.path, spec.args, (error) => {
        // Reset the memoized choice so a later turn re-probes: the notifier may
        // have been removed, or its permission may have been revoked.
        backendChoice = undefined
        backendProbe = undefined
        logger.warn(`turn-notify: ${choice.backend} failed: ${messageOf(error)}`)
      })
    })
  }

  const tracker = new TurnTracker(currentOptions, { fire: notify })

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        const options = currentOptions()
        if (!options.enabled) return
        if (!options.includeSubagents && isSubagent(session)) return

        switch (event.type) {
          case 'turn/start':
            tracker.onTurnStart(session.id)
            return
          case 'turn/end': {
            const kind = event.data?.reason?.kind ?? 'completed'
            const turn = event.data?.turn
            tracker.onTurnEnd(session.id, kind, {
              session,
              snippet: turn === undefined ? '' : clipText(lastAssistantText(session, turn), options.maxBodyChars),
            })
            return
          }
          case 'session/title':
            return
          default:
            return
        }
      }),
    'dsh-turn-notify: session/event listener',
  )

  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        tracker.forget(session.id)
      }),
    'dsh-turn-notify: session/disposed listener',
  )

  ctx.effect(
    () => () => {
      tracker.dispose()
    },
    'dsh-turn-notify: tracker',
  )

  // A `/notify-test` command gives the user a way to check the plumbing without
  // waiting for a task to finish.
  //
  // `ctx.inject` is required here, not `ctx.get`. At cold start the Loader
  // mounts rows in order, so this plugin's `apply` can run before the row that
  // provides `commands`; `ctx.get('commands')` would then return `undefined`
  // and the command would never be registered — it would only appear after the
  // user toggled the plugin off and on again, once `commands` already existed.
  // `ctx.inject` defers the callback until the service is available and removes
  // it when the service goes away, which is the contract this needs.
  ctx.inject(['commands'], (scope) => {
    scope.effect(
      () =>
        scope.commands.register({
          name: 'notify-test',
          description: 'Send one test notification to check the turn-notify plugin.',
          handler: async () => {
            const options = currentOptions()
            if (!options.enabled) return { kind: 'error', text: options.messages.disabled }
            const notification = {
              title: options.messages.testTitle,
              subtitle: options.appName,
              body: options.messages.testBody,
              group: options.appName,
            }
            // Resolve the backend first so the reply can name the application
            // macOS actually attributed the notification to. A user who sees it
            // only in Notification Center has to change THAT app's alert style,
            // and its name is not something they could guess.
            const choice = await chooseBackend(options)
            if (choice === undefined) return { kind: 'error', text: options.messages.noBackend }
            const spec = backendSpec(choice.backend, notification, options)
            if (spec !== null) {
              run(choice.path, spec.args, (error) => logger.warn(`turn-notify: ${choice.backend} failed: ${messageOf(error)}`))
            }
            const owner = notificationOwner(choice.backend)
            if (owner === undefined) return { kind: 'success', text: options.messages.testCommand }
            const localized = options.languageId === 'zh' ? owner.appZh : owner.app
            return {
              kind: 'success',
              text: `${options.messages.testCommand}\n\n${options.messages.testOwner(localized, owner.bundleId)}`,
            }
          },
        }),
      'dsh-turn-notify: /notify-test command',
    )
  })

  // Read once at load so a broken row is reported in the log rather than
  // discovered by a user who never receives a notification.
  const initial = currentOptions()
  logger.info(
    `turn-notify: ready (notifyOn=${initial.notifyOn.join(',')}, backend=${initial.backend}, language=${initial.languageId})`,
  )
}
