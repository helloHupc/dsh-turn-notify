import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, apply, name } from '../index.js'

/**
 * Build a minimal stand-in for a Cordis Host context.
 *
 * The fake records every effect so the test can dispose the plugin the way an
 * unload would, and every `on` listener so a Session event can be delivered
 * without a real Session log.
 */
function fakeContext({ services = {}, logger = console } = {}) {
  const listeners = new Map()
  const effects = []
  const warnings = []
  const infos = []
  const deferred = []
  const ctx = {
    logger: {
      info: (message) => {
        infos.push(String(message))
        void logger
      },
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
    },
    get: (key) => services[key],
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    /**
     * Mirror Cordis's contract: run the callback once every named service is
     * available, and keep it deferred until then. A test can therefore apply
     * the plugin before providing `commands`, which is the cold-start order
     * that a `ctx.get` lookup would silently miss.
     */
    inject(names, callback) {
      const run = () => {
        const scope = {
          effect: ctx.effect,
          get: ctx.get,
        }
        for (const name of names) scope[name] = services[name]
        callback(scope)
      }
      if (names.every((name) => services[name] !== undefined)) {
        run()
        return
      }
      deferred.push(run)
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    /** Provide a service late, then flush the callbacks that were waiting on it. */
    provide(key, value) {
      services[key] = value
      for (const run of deferred.splice(0)) run()
    },
  }
  return {
    ctx,
    services,
    warnings,
    infos,
    listeners,
    dispose() {
      for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose()
    },
  }
}

/** Build a fake live Session with a header and a log. */
function fakeSession({ id = 'session-1', cwd = '/tmp/alpha', origin, parentSession, events = [] } = {}) {
  const header = { id, isSeeded: false, version: 3, createdAt: 0 }
  if (cwd !== undefined) header.cwd = cwd
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  return {
    id,
    header,
    snapshotEvents: () => events,
  }
}

/** Wait long enough for the plugin's own settle timer and the promise chain. */
function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('the plugin declares its identity and no hard dependency', async () => {
  assert.equal(name, 'dsh-turn-notify')
  // No `inject` export: every service is read with `ctx.get`, so a profile that
  // dropped one leaves the plugin active instead of parked in `pending`.
  const module = await import('../index.js')
  assert.equal(module.inject, undefined)
})

/** Read one Config field, accepting both shapes the schema can produce. */
function field(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

test('Config accepts an empty object and applies every default', () => {
  const resolved = Config({})
  assert.equal(field(resolved.enabled), true)
  assert.deepEqual(field(resolved.notifyOn), ['completed', 'error'])
  assert.equal(field(resolved.backend), 'auto')
  assert.equal(field(resolved.settleMs), 800)
  assert.equal(field(resolved.minTurnMs), 1500)
  assert.equal(field(resolved.includeSubagents), false)
  assert.equal(field(resolved.language), 'auto')
})

test('Config rejects an unknown turn kind', () => {
  assert.throws(() => Config({ notifyOn: ['nonsense'] }))
})

test('Config rejects an unknown backend', () => {
  assert.throws(() => Config({ backend: 'smoke-signal' }))
})

test('apply registers a session/event listener and reports readiness', () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({}))
  assert.ok(fake.listeners.has('session/event'))
  assert.ok(fake.listeners.has('session/disposed'))
  assert.ok(fake.infos.some((line) => line.includes('ready')))
  fake.dispose()
})

test('apply stays silent for a turn that is not configured to notify', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ notifyOn: ['error'], settleMs: 0, minTurnMs: 0 }))
  const session = fakeSession()
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(20)
  // No backend is reachable in this fake, so the proof of silence is the
  // absence of the "no backend" warning that a fired notification would emit.
  assert.equal(fake.warnings.length, 0)
  fake.dispose()
})

test('apply warns once when a notifying turn has no backend available', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ settleMs: 0, minTurnMs: 0, backend: 'osascript' }))
  const session = fakeSession()
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(300)
  assert.ok(
    fake.warnings.some((line) => line.includes('no notification backend')),
    `expected a backend warning, got ${JSON.stringify(fake.warnings)}`,
  )
  fake.dispose()
})

test('apply skips a subagent Session unless it is opted in', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ settleMs: 0, minTurnMs: 0, backend: 'osascript' }))
  const child = fakeSession({ id: 'child', origin: 'subagent' })
  fake.ctx.emit('session/event', child, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(300)
  assert.equal(fake.warnings.length, 0)
  fake.dispose()
})

test('apply notifies for a subagent Session when includeSubagents is on', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ settleMs: 0, minTurnMs: 0, includeSubagents: true, backend: 'osascript' }))
  const child = fakeSession({ id: 'child', parentSession: 'root' })
  fake.ctx.emit('session/event', child, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(300)
  assert.ok(fake.warnings.some((line) => line.includes('no notification backend')))
  fake.dispose()
})

test('apply ignores everything while disabled', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ enabled: false, settleMs: 0, minTurnMs: 0, backend: 'osascript' }))
  const session = fakeSession()
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  await settle(300)
  assert.equal(fake.warnings.length, 0)
  fake.dispose()
})

test('apply forgets a Session when it is disposed', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ settleMs: 50, minTurnMs: 0, backend: 'osascript' }))
  const session = fakeSession()
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  fake.ctx.emit('session/disposed', session)
  await settle(300)
  assert.equal(fake.warnings.length, 0, 'a disposed Session must not notify')
  fake.dispose()
})

test('apply disposes its tracker on unload, dropping a settling notice', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ settleMs: 100, minTurnMs: 0, backend: 'osascript' }))
  const session = fakeSession()
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  fake.dispose()
  await settle(300)
  assert.equal(fake.warnings.length, 0)
})

test('apply registers the /notify-test command once a registry exists', () => {
  const registered = []
  const fake = fakeContext()
  apply(fake.ctx, Config({}))
  fake.ctx.provide('commands', {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'notify-test')
  assert.equal(typeof registered[0].handler, 'function')
  fake.dispose()
})

test('apply defers the command instead of losing it when commands arrive late', () => {
  // The cold-start regression: `apply` runs before the row providing
  // `commands`, so a `ctx.get` lookup found nothing and the command was never
  // registered until the user toggled the plugin. It must wait instead.
  const registered = []
  const fake = fakeContext()
  apply(fake.ctx, Config({}))
  assert.equal(registered.length, 0, 'nothing registers before the service exists')
  fake.ctx.provide('commands', {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  })
  assert.equal(registered.length, 1, 'the deferred callback registers the command')
  fake.dispose()
})

test('apply does not require a command registry at all', () => {
  const fake = fakeContext()
  assert.doesNotThrow(() => apply(fake.ctx, Config({})))
  assert.ok(fake.listeners.has('session/event'), 'the turn listener is independent of `commands`')
  fake.dispose()
})

test('the /notify-test command reports disabled rather than firing', async () => {
  const registered = []
  const fake = fakeContext()
  apply(fake.ctx, Config({ enabled: false }))
  fake.ctx.provide('commands', {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  })
  const result = await registered[0].handler({ commandId: 'c', agent: { id: 's' }, rawInput: '', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  fake.dispose()
})

test('apply survives a title service that throws', async () => {
  const fake = fakeContext({
    services: {
      sessionTitle: {
        get: () => {
          throw new Error('title fold unavailable')
        },
      },
    },
  })
  apply(fake.ctx, Config({ settleMs: 0, minTurnMs: 0, backend: 'osascript' }))
  const session = fakeSession({
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'All 39 tests pass.' }] },
        },
      },
    ],
  })
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(300)
  // The title fallback is silent; the only warning is the missing backend.
  assert.ok(!fake.warnings.some((line) => line.includes('title fold unavailable')))
  fake.dispose()
})

test('apply never throws when a Session log cannot be read', async () => {
  const fake = fakeContext()
  apply(fake.ctx, Config({ settleMs: 0, minTurnMs: 0, backend: 'osascript' }))
  const session = {
    id: 'session-broken',
    header: { id: 'session-broken', isSeeded: false, version: 3, createdAt: 0, cwd: '/tmp/alpha' },
    snapshotEvents: () => {
      throw new Error('session is replaying')
    },
  }
  assert.doesNotThrow(() => {
    fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    fake.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  })
  await settle(300)
  fake.dispose()
})
