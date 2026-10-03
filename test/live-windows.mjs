/**
 * Opt-in live check for one Windows machine: runs the real Host half
 * (`apply` → listener → command plan → real PowerShell → real toast) against a
 * real, dependency-free subprocess implementation, and prints what it chose.
 *
 *   node test/live-windows.mjs [zh|en|auto]
 *
 * It is NOT part of `node --test`: it really shows a notification, so it stays
 * explicit. Everything it prints is the evidence that this machine's backend
 * works end to end; the macOS/Linux plans are covered by the unit tests.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { apply } from '../index.js'

/** Resolve one command the way a shell would, including PATHEXT. */
async function resolveExecutable(command) {
  if (command.includes('/') || command.includes('\\')) {
    if (!existsSync(command)) throw new Error(`${command} does not exist`)
    return command
  }
  const extensions = ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`${command} not found on PATH`)
}

/** The smallest faithful implementation of the composed subprocess service. */
function spawnSpec(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const done = new Promise((resolve) => {
    child.on('close', (exitCode) => resolve({ exitCode, signal: null }))
    child.on('error', () => resolve({ exitCode: -1, signal: null }))
  })
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    done,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    terminate: () => child.kill(),
  }
}

const listeners = new Map()
const printed = []

const ctx = {
  logger: {
    info: (message) => console.log('[info]', message),
    warn: (message) => console.log('[warn]', message),
  },
  on(name, listener, options) {
    listeners.set(name, { listener, options })
    return () => listeners.delete(name)
  },
  effect(callback, label) {
    return callback()
  },
  timer: {
    timeout(callback, delay) {
      const handle = setTimeout(callback, delay)
      return () => clearTimeout(handle)
    },
  },
  subprocess: {
    resolveExecutable,
    spawn(spec) {
      const encoded = spec.argv[spec.argv.length - 1]
      const script = Buffer.from(encoded, 'base64').toString('utf16le')
      printed.push({ argv: spec.argv, script })
      console.log('--- notification process ---')
      console.log('argv[0]   :', spec.argv[0])
      console.log('argv[1..3]:', spec.argv.slice(1, 4).join(' '))
      console.log('cwd       :', spec.cwd)
      console.log('appId ladder in script :', script.includes('$appIds'))
      console.log('script bytes           :', script.length)
      console.log('title line :', /CreateTextNode\('([^']*)'\)/.exec(script)?.[1] ?? '(none)')
      console.log('body line  :', [...script.matchAll(/CreateTextNode\('([^']*)'\)/g)][1]?.[1] ?? '(none)')
      return spawnSpec(spec)
    },
  },
}

apply(ctx, { locale: process.argv[2] ?? 'auto' })

console.log('listeners:', [...listeners.keys()].join(', '))
console.log('listener options:', JSON.stringify(listeners.get('approval/request')?.options))

let delegated = 0
const outcome = listeners.get('approval/request').listener({
  agent: { id: 'live-verify' },
  toolName: 'bash',
  callId: 'live-verify-1',
  reason: 'fallback reason',
  displayReason: {
    zh: '实测：审批链路会弹出系统通知',
    en: 'live check: the approval path raises a system notification',
  },
}, () => {
  delegated += 1
  return 'allowed-once'
})

console.log('waterfall value returned:', outcome)
console.log('next() delegated        :', delegated === 1)

await new Promise((resolve) => setTimeout(resolve, 3000))
console.log('notification processes  :', printed.length)
console.log('LIVE CHECK DONE')
