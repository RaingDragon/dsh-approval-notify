/**
 * Integration tests for the Host half of `@local/dsh-approval-notify`.
 *
 * `apply` is driven with a recording Cordis context, so the tests assert the
 * real contract the Harness depends on — the listener options, the synchronous
 * `next()` pass-through, the per-platform argv, de-duplication, and that every
 * failure is logged instead of thrown — without needing a live DSH host.
 *
 * Platform-dependent tests stub `process.platform`, so the whole suite runs the
 * same way on Windows, macOS, and Linux.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject } from '../index.js'

/** Build one recording context that mimics the Cordis members `apply` uses. */
function makeContext(options = {}) {
  const record = {
    logs: [],
    spawns: [],
    resolved: [],
    timers: [],
    timerCreated: 0,
    timerDisposed: 0,
    terminated: 0,
    effects: [],
    exitCode: options.exitCode ?? 0,
    stderr: options.stderr ?? '',
    resolveFailsFor: options.resolveFailsFor ?? [],
  }
  const listeners = new Map()
  const ctx = {
    logger: {
      info: (message) => record.logs.push(['info', message]),
      warn: (message) => record.logs.push(['warn', message]),
    },
    on(name, listener, listenerOptions) {
      listeners.set(name, { listener, options: listenerOptions })
      return () => {
        listeners.delete(name)
        return true
      }
    },
    effect(callback, label) {
      const disposer = callback()
      record.effects.push({ label, disposer })
      return () => disposer?.()
    },
    timer: {
      timeout(callback, delay) {
        const entry = { callback, delay }
        record.timers.push(entry)
        record.timerCreated += 1
        return () => {
          record.timerDisposed += 1
          const index = record.timers.indexOf(entry)
          if (index >= 0) record.timers.splice(index, 1)
        }
      },
    },
    subprocess: {
      async resolveExecutable(command) {
        record.resolved.push(command)
        if (record.resolveFailsFor.includes(command)) throw new Error(`${command} missing`)
        return `resolved:${command}`
      },
      spawn(spec) {
        record.spawns.push(spec)
        const reader = () => ({ text: record.stderr, nextOffset: 0, lossy: false })
        return {
          done: Promise.resolve({ exitCode: record.exitCode, signal: null }),
          collected: { stdout: { readFrom: reader }, stderr: { readFrom: reader } },
          terminate: () => {
            record.terminated += 1
          },
        }
      },
    },
  }
  return { ctx, record, listeners }
}

/** Let every already-scheduled microtask and macrotask of one delivery run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Run `body` with `process.platform` reporting another operating system. */
async function withPlatform(platform, body) {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await body()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/** Decode the script handed to `powershell.exe -EncodedCommand`. */
function decodeCommand(spec) {
  return Buffer.from(spec.argv[spec.argv.length - 1], 'base64').toString('utf16le')
}

const approvalRequest = {
  agent: { id: 'session-1' },
  toolName: 'bash',
  callId: 'call-1',
  reason: 'fallback reason',
  displayReason: { en: 'run a privileged command', zh: '执行越权命令' },
}

test('the plugin declares the services it needs', () => {
  assert.deepEqual(inject, ['subprocess', 'timer'])
})

test('both waterfalls get a prepended, global, pass-through listener', () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, {})
  for (const name of ['approval/request', 'user-questions/request']) {
    const entry = listeners.get(name)
    assert.ok(entry, `${name} listener is registered`)
    assert.deepEqual(entry.options, { prepend: true, global: true })
  }
})

test('an approval request is passed through unchanged and raises one toast', async () => {
  const { ctx, record, listeners } = makeContext()
  apply(ctx, { locale: 'zh' })
  const outcome = { marker: 'the real waterfall outcome' }
  const returned = listeners.get('approval/request').listener(approvalRequest, () => outcome)
  assert.equal(returned, outcome, 'the listener returns next() synchronously')
  await settle()
  assert.equal(record.spawns.length, 1)
  const spec = record.spawns[0]
  assert.deepEqual(spec.argv.slice(0, 4), [
    'resolved:powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
  ])
  assert.deepEqual(spec.stdio, {
    stdin: 'ignore',
    stdout: { maxBytes: 32 * 1024 },
    stderr: { maxBytes: 32 * 1024 },
  })
  const script = decodeCommand(spec)
  assert.match(script, /CreateTextNode\('DSH 需要你的确认'\)/)
  assert.match(script, /CreateTextNode\('工具 bash 请求授权：执行越权命令'\)/)
  assert.equal(record.timerCreated, 1, 'a watchdog guards the notification process')
  assert.equal(record.timerDisposed, 1, 'the watchdog is cleared once the process exits')
})

test('the same request inside the de-duplication window notifies once', async () => {
  const { ctx, record, listeners } = makeContext()
  apply(ctx, { dedupeMs: 60000 })
  const listener = listeners.get('approval/request').listener
  listener(approvalRequest, () => 'first')
  listener({ ...approvalRequest }, () => 'second')
  listener({ ...approvalRequest, callId: 'call-2' }, () => 'third')
  await settle()
  assert.equal(record.spawns.length, 2, 'the repeated call id is skipped, a new call id is not')
})

test('a user question becomes its own notification', async () => {
  const { ctx, record, listeners } = makeContext()
  apply(ctx, { userQuestions: true, locale: 'zh' })
  listeners.get('user-questions/request').listener({
    questions: [{ id: 'q1', question: '选哪个模式？', header: '确认' }],
  }, () => 'delegated')
  await settle()
  assert.equal(record.spawns.length, 1)
  const script = decodeCommand(record.spawns[0])
  assert.match(script, /CreateTextNode\('DSH 需要你的回答'\)/)
  assert.match(script, /CreateTextNode\('确认：选哪个模式？'\)/)
})

test('a request without a question raises nothing', async () => {
  const { ctx, record, listeners } = makeContext()
  apply(ctx, {})
  listeners.get('user-questions/request').listener({ questions: [] }, () => 'delegated')
  await settle()
  assert.deepEqual(record.spawns, [])
})

test('config.disabled and the per-waterfall switches register nothing', () => {
  const disabled = makeContext()
  apply(disabled.ctx, { enabled: false })
  assert.equal(disabled.listeners.size, 0)
  assert.ok(disabled.record.logs.some(([level]) => level === 'info'))

  const approvalsOnly = makeContext()
  apply(approvalsOnly.ctx, { userQuestions: false })
  assert.deepEqual([...approvalsOnly.listeners.keys()], ['approval/request'])
})

test('a failing notification process is logged, never thrown', async () => {
  const { ctx, record, listeners } = makeContext({ exitCode: 1, stderr: 'toast blew up' })
  apply(ctx, {})
  listeners.get('approval/request').listener(approvalRequest, () => 'ok')
  await settle()
  assert.ok(record.logs.some(([level, message]) => level === 'warn' && message.includes('toast blew up')))
})

test('an unresolvable executable is logged, never thrown', async () => {
  const { ctx, record, listeners } = makeContext()
  record.resolveFailsFor = ['powershell.exe', `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, 'pwsh.exe']
  apply(ctx, {})
  listeners.get('approval/request').listener(approvalRequest, () => 'ok')
  await settle()
  assert.deepEqual(record.spawns, [])
  assert.ok(record.logs.some(([level, message]) => level === 'warn' && message.includes('找不到可用的通知命令')))
})

test('an over-long reason is truncated in the notification body', async () => {
  const { ctx, record, listeners } = makeContext()
  apply(ctx, { locale: 'zh' })
  listeners.get('approval/request').listener({
    agent: { id: 'session-1' },
    toolName: 'bash',
    callId: 'call-long',
    reason: 'x'.repeat(600),
  }, () => 'ok')
  await settle()
  const script = decodeCommand(record.spawns[0])
  assert.match(script, /…/)
  assert.ok(!script.includes('x'.repeat(400)), 'the body is cut before the toast')
})

test('macOS runs osascript with the AppleScript plan', async () => {
  await withPlatform('darwin', async () => {
    const { ctx, record, listeners } = makeContext()
    apply(ctx, { locale: 'en' })
    listeners.get('approval/request').listener(approvalRequest, () => 'ok')
    await settle()
    assert.equal(record.spawns.length, 1)
    const spec = record.spawns[0]
    assert.equal(spec.argv[0], 'resolved:osascript')
    assert.equal(spec.argv[1], '-e')
    assert.match(spec.argv[2], /^display notification ".+" with title ".+" sound name "Ping"$/)
    assert.match(spec.argv[2], /Tool bash requests approval/)
  })
})

test('Linux runs notify-send with the app name and plain text', async () => {
  await withPlatform('linux', async () => {
    const { ctx, record, listeners } = makeContext()
    apply(ctx, { locale: 'en', appName: 'MyDSH' })
    listeners.get('approval/request').listener(approvalRequest, () => 'ok')
    await settle()
    assert.equal(record.spawns.length, 1)
    assert.deepEqual(record.spawns[0].argv, [
      'resolved:notify-send',
      '--app-name=MyDSH',
      'DSH needs your confirmation',
      'Tool bash requests approval: run a privileged command',
    ])
  })
})

test('an unsupported platform warns twice (activation + first skip) and never spawns', async () => {
  await withPlatform('aix', async () => {
    const { ctx, record, listeners } = makeContext()
    apply(ctx, {})
    assert.deepEqual([...listeners.keys()], ['approval/request', 'user-questions/request'])
    const listener = listeners.get('approval/request').listener
    listener(approvalRequest, () => 'ok')
    listener({ ...approvalRequest, callId: 'call-2' }, () => 'ok')
    await settle()
    assert.deepEqual(record.spawns, [])
    const warnings = record.logs.filter(([level, message]) => level === 'warn' && message.includes('没有可用的通知后端'))
    assert.equal(warnings.length, 2, 'one warning at activation, one when a notification is skipped')
  })
})

test('testOnLoad schedules one probe that names the loaded version', async () => {
  const { ctx, record } = makeContext()
  apply(ctx, { testOnLoad: true, locale: 'en' })
  assert.equal(record.timers.length, 1)
  assert.equal(record.timers[0].delay, 1500)
  record.timers[0].callback()
  await settle()
  assert.equal(record.spawns.length, 1)
  assert.match(decodeCommand(record.spawns[0]), /v1\.1\.0/)
})
