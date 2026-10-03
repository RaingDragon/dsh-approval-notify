/**
 * @local/dsh-approval-notify — pure helpers for the Host half.
 *
 * Everything here is deliberately free of DSH services, timers, and I/O so the
 * text, the per-platform command plan, and the generated scripts can be
 * unit-tested with plain `node --test` on any machine.
 *
 * The Host half (`index.js`) owns the event listeners and the subprocess; this
 * module only answers "what command would show this notification here?".
 */

/** Version reported by the load-time test notification; kept in step with package.json. */
export const PLUGIN_VERSION = '1.1.0'

/** Config values used when the bundle row omits a key. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  approvals: true,
  userQuestions: true,
  locale: 'auto',
  silent: false,
  toastAppId: 'PowerShell',
  appName: 'DSH',
  dedupeMs: 1200,
  timeoutMs: 15000,
  testOnLoad: false,
})

/**
 * Last-resort Windows AppUserModelID: the Start-menu identity of Windows
 * PowerShell itself, which exists on every Windows installation that can raise
 * a toast. Used only when the configured AppUserModelID raises nothing.
 */
export const WINDOWS_TOAST_FALLBACK_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Longest notification body kept; toast bodies are shown on one short line. */
export const MAX_BODY = 200

/** Human-readable failure text for any thrown value. */
export function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function boundedNumberOr(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** `auto`, `zh*`, or `en*`; every other value means `auto`. */
function localeOr(value, fallback) {
  const text = stringOr(value, fallback).toLowerCase()
  if (text.startsWith('zh')) return 'zh'
  if (text.startsWith('en')) return 'en'
  return 'auto'
}

/**
 * Validate the raw bundle-row config.
 * Unknown keys are ignored, a non-numeric or mistyped value falls back to its
 * default, and an out-of-range number is clamped into the accepted range, so a
 * typo in the profile patch degrades to documented behavior.
 */
export function parseConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: booleanOr(source.enabled, DEFAULT_CONFIG.enabled),
    approvals: booleanOr(source.approvals, DEFAULT_CONFIG.approvals),
    userQuestions: booleanOr(source.userQuestions, DEFAULT_CONFIG.userQuestions),
    locale: localeOr(source.locale, DEFAULT_CONFIG.locale),
    silent: booleanOr(source.silent, DEFAULT_CONFIG.silent),
    toastAppId: stringOr(source.toastAppId, DEFAULT_CONFIG.toastAppId),
    appName: stringOr(source.appName, DEFAULT_CONFIG.appName),
    dedupeMs: boundedNumberOr(source.dedupeMs, DEFAULT_CONFIG.dedupeMs, 0, 60000),
    timeoutMs: boundedNumberOr(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 120000),
    testOnLoad: booleanOr(source.testOnLoad, DEFAULT_CONFIG.testOnLoad),
  }
}

/**
 * Resolve `auto` against the runtime locale this process reports.
 * Only `zh` and `en` texts exist; any other detected language reads English.
 */
export function resolveLocale(configured, detected) {
  const wanted = String(configured ?? '').toLowerCase()
  if (wanted.startsWith('zh')) return 'zh'
  if (wanted.startsWith('en')) return 'en'
  return String(detected ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function truncate(text, max = MAX_BODY) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** Escape one value for a single-quoted PowerShell string literal. */
export function escapePowerShellLiteral(text) {
  return String(text ?? '').replace(/'/g, "''")
}

/** Encode a PowerShell script for `powershell.exe -EncodedCommand`. */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64')
}

/** Escape one value for an AppleScript double-quoted string literal. */
export function escapeAppleScriptLiteral(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the PowerShell that shows one Windows toast.
 * The values arrive as single-quoted literals (escaped above) and the whole
 * script is handed to PowerShell over `-EncodedCommand`, so no shell quoting,
 * temporary file, or console code page can corrupt non-ASCII text.
 *
 * The notifier is resolved through a ladder — the configured AppUserModelID,
 * then {@link WINDOWS_TOAST_FALLBACK_APP_ID}, then the host process identity —
 * because a machine where the configured identity is not registered otherwise
 * silently loses every notification.
 */
export function buildToastScript(input) {
  const title = escapePowerShellLiteral(input?.title ?? '')
  const body = escapePowerShellLiteral(input?.body ?? '')
  const appId = escapePowerShellLiteral(input?.appId ?? DEFAULT_CONFIG.toastAppId)
  const fallbackAppId = escapePowerShellLiteral(WINDOWS_TOAST_FALLBACK_APP_ID)
  const silent = input?.silent === true
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$texts = $template.GetElementsByTagName('text')",
    `[void]$texts.Item(0).AppendChild($template.CreateTextNode('${title}'))`,
    `[void]$texts.Item(1).AppendChild($template.CreateTextNode('${body}'))`,
  ]
  if (silent) {
    lines.push(
      "$audio = $template.CreateElement('audio')",
      "$audio.SetAttribute('silent', 'true')",
      '[void]$template.DocumentElement.AppendChild($audio)',
    )
  }
  lines.push(
    `$appIds = @('${appId}', '${fallbackAppId}', '')`,
    '$shown = $false',
    "$lastError = ''",
    'foreach ($candidate in $appIds) {',
    '  try {',
    '    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    "    if ($candidate -eq '') { $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier() }",
    '    else { $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($candidate) }',
    '    $notifier.Show($toast)',
    '    $shown = $true',
    '    break',
    '  } catch { $lastError = $_.Exception.Message }',
    '}',
    'if (-not $shown) { throw "toast failed: $lastError" }',
  )
  return lines.join('\r\n')
}

/** Build the AppleScript that shows one notification on macOS. */
export function buildAppleScript(input) {
  const title = escapeAppleScriptLiteral(input?.title ?? '')
  const body = escapeAppleScriptLiteral(input?.body ?? '')
  const sound = input?.silent === true ? '' : ' sound name "Ping"'
  return `display notification "${body}" with title "${title}"${sound}`
}

/** The notification backend a platform uses, or null when none is known. */
export function backendFor(platform) {
  switch (platform) {
    case 'win32': return 'windows-toast'
    case 'darwin': return 'macos-notification'
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'netbsd': return 'notify-send'
    default: return null
  }
}

/** Windows PowerShell candidates, most portable first. */
function windowsPowerShellCandidates(systemRoot) {
  const root = stringOr(systemRoot, 'C:\\Windows').replace(/[\\/]+$/, '')
  return [
    'powershell.exe',
    `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    'pwsh.exe',
  ]
}

/**
 * Plan the command that shows one notification on this platform.
 * @returns `{ kind, executables, args }`, or null when the platform has no
 *   backend — the caller resolves the first executable that exists and spawns
 *   `[executable, ...args]`.
 */
export function buildNotificationCommand(input = {}) {
  const kind = backendFor(input.platform)
  if (kind === null) return null
  const title = String(input.title ?? '')
  const body = String(input.body ?? '')
  const silent = input.silent === true
  if (kind === 'windows-toast') {
    return {
      kind,
      executables: windowsPowerShellCandidates(input.systemRoot),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShellCommand(buildToastScript({
          title,
          body,
          appId: input.appId ?? DEFAULT_CONFIG.toastAppId,
          silent,
        })),
      ],
    }
  }
  if (kind === 'macos-notification') {
    return {
      kind,
      executables: ['osascript', '/usr/bin/osascript'],
      args: ['-e', buildAppleScript({ title, body, silent })],
    }
  }
  return {
    kind,
    executables: ['notify-send', '/usr/bin/notify-send'],
    args: [`--app-name=${String(input.appName ?? DEFAULT_CONFIG.appName)}`, title, body],
  }
}

const LABELS = {
  zh: {
    approvalTitle: 'DSH 需要你的确认',
    approvalBody: (toolName, reason) => (reason === null
      ? `工具 ${toolName} 正在等待你的审批`
      : `工具 ${toolName} 请求授权：${reason}`),
    questionTitle: 'DSH 需要你的回答',
    questionBody: (header, question) => (header === null ? question : `${header}：${question}`),
    testTitle: 'DSH 审批提醒已就绪',
    testBody: (version) => `插件 v${version} 已就绪：DSH 需要你确认或回答时会发送这样的通知。`,
  },
  en: {
    approvalTitle: 'DSH needs your confirmation',
    approvalBody: (toolName, reason) => (reason === null
      ? `Tool ${toolName} is waiting for your approval`
      : `Tool ${toolName} requests approval: ${reason}`),
    questionTitle: 'DSH is waiting for your answer',
    questionBody: (header, question) => (header === null ? question : `${header}: ${question}`),
    testTitle: 'DSH approval notifications are ready',
    testBody: (version) => `Plugin v${version} is ready: DSH sends a notification like this when it needs your confirmation or answer.`,
  },
}

function labels(locale) {
  return String(locale ?? '').toLowerCase().startsWith('en') ? LABELS.en : LABELS.zh
}

/**
 * Resolve the reason a user should read: the request's localized
 * `displayReason` for this locale, then any locale it does carry, then the raw
 * `reason`.
 * @returns the resolved text, or null when the request carries none.
 */
export function resolveDisplayReason(displayReason, reason, locale) {
  if (displayReason !== null && typeof displayReason === 'object') {
    const wanted = String(locale ?? '').toLowerCase()
    const primary = wanted.split('-')[0]
    const entries = Object.entries(displayReason).filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    const exact = entries.find(([key]) => key.toLowerCase() === wanted)
    if (exact !== undefined) return exact[1].trim()
    const near = entries.find(([key]) => key.toLowerCase().split('-')[0] === primary)
    if (near !== undefined) return near[1].trim()
    const zh = entries.find(([key]) => key.toLowerCase().split('-')[0] === 'zh')
    if (zh !== undefined) return zh[1].trim()
    const en = entries.find(([key]) => key.toLowerCase().split('-')[0] === 'en')
    if (en !== undefined) return en[1].trim()
    if (entries.length > 0) return entries[0][1].trim()
  }
  if (typeof reason === 'string' && reason.trim() !== '') return reason.trim()
  return null
}

/** The notification for one `approval/request`; never null. */
export function approvalNotice(request, options = {}) {
  const text = labels(options.locale)
  const toolName = typeof request?.toolName === 'string' && request.toolName.trim() !== ''
    ? request.toolName.trim()
    : 'tool'
  const reason = resolveDisplayReason(request?.displayReason, request?.reason, options.locale)
  return {
    kind: 'approval',
    title: text.approvalTitle,
    body: truncate(text.approvalBody(toolName, reason)),
  }
}

/** The notification for one `user-questions/request`, or null without a question. */
export function questionNotice(request, options = {}) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions.find((item) => item !== null && typeof item === 'object'
    && typeof item.question === 'string' && item.question.trim() !== '')
  if (first === undefined) return null
  const text = labels(options.locale)
  const header = typeof first.header === 'string' && first.header.trim() !== '' ? first.header.trim() : null
  return {
    kind: 'question',
    title: text.questionTitle,
    body: truncate(text.questionBody(header, first.question.trim())),
  }
}

/** The notification used by the `testOnLoad` probe; names the loaded version. */
export function testNotice(options = {}) {
  const text = labels(options.locale)
  const version = String(options.version ?? PLUGIN_VERSION)
  return { kind: 'test', title: text.testTitle, body: truncate(text.testBody(version)) }
}

/**
 * Stable identity of one pending request, for de-duplication.
 * A Tool call id is exact; a question has none, so its own text identifies it.
 */
export function dedupeKeyOf(notice, request) {
  const callId = typeof request?.callId === 'string' && request.callId !== '' ? request.callId : null
  if (callId !== null) return `${notice.kind}:${callId}`
  const agentId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
  return `${notice.kind}:${agentId}:${notice.title}:${notice.body}`
}
