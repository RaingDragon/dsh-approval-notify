/**
 * @local/dsh-approval-notify — Host half.
 *
 * DSH dispatches `approval/request` (and `user-questions/request`) through a
 * waterfall before it waits for you. This plugin registers a pass-through
 * listener on both, prepended so it runs before the Web bridge that hands the
 * request to the browser, and raises one system notification per request.
 *
 * The listener never decides anything: it calls `next()` synchronously and does
 * its work beside the chain, so approval semantics, ordering, and the recorded
 * ask/outcome pair stay exactly as the Harness defines them. Nothing here is
 * machine-specific: the notification command is planned per platform from the
 * plugin directory this module was loaded from, and every executable is
 * resolved through the composed subprocess service before it runs.
 *
 * Every resource is registered inside `apply` through `ctx.effect`, so
 * unloading the plugin removes both listeners and any pending timer.
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_VERSION,
  approvalNotice,
  backendFor,
  buildNotificationCommand,
  dedupeKeyOf,
  messageOf,
  parseConfig,
  questionNotice,
  resolveLocale,
  testNotice,
  truncate,
} from './internal.js'

/** Services this plugin needs; without them it stays inactive. */
export const inject = ['subprocess', 'timer']

/** Directory holding this module; an existing directory is required as `cwd`. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** Delay before the optional load-time test notification. */
const TEST_DELAY_MS = 1500

/** The runtime locale this process reports, for `locale: auto`. */
function detectedLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/**
 * Mount the notifier on one Cordis context.
 * @param ctx - plugin context owning the listeners, the timer, and subprocess.
 * @param rawConfig - the bundle row's config, as the profile patch declares it.
 */
export function apply(ctx, rawConfig) {
  const config = parseConfig(rawConfig)
  const locale = resolveLocale(config.locale, detectedLocale())
  const log = (level, text) => {
    try {
      ctx.logger?.[level]?.(`[dsh-approval-notify] ${text}`)
    } catch {
      /* a logger failure never affects the plugin */
    }
  }

  if (!config.enabled) {
    log('info', '已在 config 中禁用（enabled: false），不注册任何监听')
    return
  }

  const backend = backendFor(process.platform)
  if (backend === null) {
    log('warn', `平台 ${process.platform} 没有可用的通知后端；监听器仍会注册，但不会发送提醒`)
  }

  /** One resolved executable per backend, so lookups happen once per activation. */
  const executableCache = new Map()

  function resolveExecutable(kind, candidates) {
    if (executableCache.has(kind)) return executableCache.get(kind)
    const pending = (async () => {
      const failures = []
      for (const candidate of candidates) {
        try {
          return await ctx.subprocess.resolveExecutable(candidate)
        } catch (error) {
          failures.push(`${candidate}: ${messageOf(error)}`)
        }
      }
      throw new Error(`找不到可用的通知命令（${failures.join('；')}）`)
    })()
    executableCache.set(kind, pending)
    return pending
  }

  /** Set once a notification was refused for an unsupported platform. */
  let warnedUnsupported = false

  /**
   * Show one notification on this platform and wait for the short-lived process
   * to exit. Failures are logged only: a notification must never disturb an
   * approval.
   */
  async function show(notice) {
    const plan = buildNotificationCommand({
      platform: process.platform,
      title: notice.title,
      body: notice.body,
      appId: config.toastAppId,
      appName: config.appName,
      silent: config.silent,
      systemRoot: process.env.SystemRoot,
    })
    if (plan === null) {
      if (!warnedUnsupported) {
        warnedUnsupported = true
        log('warn', `平台 ${process.platform} 没有可用的通知后端，已跳过提醒`)
      }
      return
    }
    const executable = await resolveExecutable(plan.kind, plan.executables)
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...plan.args],
      cwd: PLUGIN_DIR,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 32 * 1024 },
        stderr: { maxBytes: 32 * 1024 },
      },
      graceMs: 5000,
    })
    const watchdog = ctx.timer.timeout(() => {
      log('warn', `通知进程超过 ${config.timeoutMs} ms 未退出，已终止`)
      handle.terminate()
    }, config.timeoutMs)
    let outcome
    try {
      outcome = await handle.done
    } finally {
      watchdog()
    }
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0)?.text?.trim() ?? ''
      log('warn', `系统通知失败（${plan.kind}，退出码 ${outcome.exitCode ?? 'null'}）${stderr === '' ? '' : `：${truncate(stderr, 300)}`}`)
    } else {
      log('info', `已发送通知（${plan.kind}）：${notice.title}｜${truncate(notice.body, 80)}`)
    }
  }

  /** Requests already notified, so one request never produces two notifications. */
  const notified = new Map()

  function alreadyNotified(key, now) {
    for (const [seenKey, seenAt] of notified) {
      if (now - seenAt > config.dedupeMs || notified.size > 64) notified.delete(seenKey)
    }
    if (notified.has(key)) return true
    notified.set(key, now)
    return false
  }

  /**
   * Build the notice for one request, then send it beside the waterfall.
   * Returning `next()` synchronously keeps this listener a pure observer.
   */
  function observer(build) {
    return function observeRequest(request, next) {
      try {
        const notice = build(request, { locale })
        if (notice !== null) {
          const key = dedupeKeyOf(notice, request)
          if (!alreadyNotified(key, Date.now())) {
            void show(notice).catch((error) => log('warn', `发送通知失败：${messageOf(error)}`))
          }
        }
      } catch (error) {
        log('warn', `生成通知内容失败：${messageOf(error)}`)
      }
      return next()
    }
  }

  if (config.approvals) {
    ctx.effect(
      () => ctx.on('approval/request', observer(approvalNotice), { prepend: true, global: true }),
      'dsh-approval-notify: approval listener',
    )
  }
  if (config.userQuestions) {
    ctx.effect(
      () => ctx.on('user-questions/request', observer(questionNotice), { prepend: true, global: true }),
      'dsh-approval-notify: user-question listener',
    )
  }

  if (config.testOnLoad) {
    ctx.effect(() => {
      const cancel = ctx.timer.timeout(() => {
        void show(testNotice({ locale, version: PLUGIN_VERSION })).catch((error) => log('warn', `发送测试通知失败：${messageOf(error)}`))
      }, TEST_DELAY_MS)
      return () => cancel()
    }, 'dsh-approval-notify: load-time test notice')
  }

  log('info', `已启用（审批=${config.approvals ? '开' : '关'}，提问=${config.userQuestions ? '开' : '关'}，后端=${backend ?? '无'}，文案=${locale}，静音=${config.silent ? '是' : '否'}）`)
}
