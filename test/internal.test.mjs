/**
 * Unit tests for the pure helpers of `@local/dsh-approval-notify`.
 * Run with `node --test` from this directory: they need no DSH runtime and no
 * particular operating system, because the platform only enters as an input.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_CONFIG,
  PLUGIN_VERSION,
  WINDOWS_TOAST_FALLBACK_APP_ID,
  approvalNotice,
  backendFor,
  buildAppleScript,
  buildNotificationCommand,
  buildToastScript,
  dedupeKeyOf,
  encodePowerShellCommand,
  escapeAppleScriptLiteral,
  escapePowerShellLiteral,
  parseConfig,
  questionNotice,
  resolveDisplayReason,
  resolveLocale,
  testNotice,
  truncate,
} from '../internal.js'

/** Decode the script carried by a `-EncodedCommand` argument. */
function decodeEncoded(argumentsList) {
  return Buffer.from(argumentsList[argumentsList.length - 1], 'base64').toString('utf16le')
}

test('parseConfig returns the documented defaults for an absent or invalid config', () => {
  assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(parseConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(parseConfig('nonsense'), DEFAULT_CONFIG)
  // A non-numeric value falls back to the default; an out-of-range number is clamped.
  assert.deepEqual(parseConfig({ locale: 'fr', dedupeMs: 'x', silent: 'yes' }), DEFAULT_CONFIG)
  assert.equal(parseConfig({ timeoutMs: -5 }).timeoutMs, 1000)
  assert.equal(parseConfig({ dedupeMs: 1e9 }).dedupeMs, 60000)
})

test('parseConfig accepts the row config and normalizes values', () => {
  const config = parseConfig({
    enabled: false,
    approvals: false,
    userQuestions: false,
    locale: 'EN-us',
    silent: true,
    toastAppId: '  MyApp  ',
    appName: '  My DSH  ',
    dedupeMs: 0,
    timeoutMs: 999999,
    testOnLoad: true,
  })
  assert.deepEqual(config, {
    enabled: false,
    approvals: false,
    userQuestions: false,
    locale: 'en',
    silent: true,
    toastAppId: 'MyApp',
    appName: 'My DSH',
    dedupeMs: 0,
    timeoutMs: 120000,
    testOnLoad: true,
  })
})

test('resolveLocale maps auto onto the detected machine locale', () => {
  assert.equal(resolveLocale('auto', 'zh-CN'), 'zh')
  assert.equal(resolveLocale('auto', 'zh-Hant-TW'), 'zh')
  assert.equal(resolveLocale('auto', 'en-GB'), 'en')
  assert.equal(resolveLocale('auto', 'fr-FR'), 'en')
  assert.equal(resolveLocale('auto', undefined), 'en')
  assert.equal(resolveLocale('zh', 'en-US'), 'zh')
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
})

test('backendFor maps every supported platform and refuses the rest', () => {
  assert.equal(backendFor('win32'), 'windows-toast')
  assert.equal(backendFor('darwin'), 'macos-notification')
  assert.equal(backendFor('linux'), 'notify-send')
  assert.equal(backendFor('freebsd'), 'notify-send')
  assert.equal(backendFor('aix'), null)
  assert.equal(backendFor(undefined), null)
})

test('truncate flattens whitespace and cuts with an ellipsis', () => {
  assert.equal(truncate('a\n  b\tc'), 'a b c')
  assert.equal(truncate('  x  ', 10), 'x')
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate(null), '')
})

test('escaping keeps platform-specific literals intact', () => {
  assert.equal(escapePowerShellLiteral("it's a 'test'"), "it''s a ''test''")
  assert.equal(escapePowerShellLiteral('中文'), '中文')
  assert.equal(escapeAppleScriptLiteral('say "hi" \\ now'), 'say \\"hi\\" \\\\ now')
})

test('buildToastScript escapes literals and retries the notifier identity', () => {
  const script = buildToastScript({ title: "O'Brien", body: '工具 bash 请求授权', appId: 'PowerShell', silent: false })
  assert.match(script, /ToastText02/)
  assert.match(script, /CreateTextNode\('O''Brien'\)/)
  assert.match(script, /CreateTextNode\('工具 bash 请求授权'\)/)
  assert.match(script, /foreach \(\$candidate in \$appIds\)/)
  assert.ok(script.includes(WINDOWS_TOAST_FALLBACK_APP_ID), 'the PowerShell identity is a fallback')
  assert.match(script, /CreateToastNotifier\(\)/)
  assert.doesNotMatch(script, /CreateElement\('audio'\)/)
})

test('buildToastScript marks the toast silent only when asked', () => {
  const script = buildToastScript({ title: 't', body: 'b', silent: true })
  assert.match(script, /CreateElement\('audio'\)/)
  assert.match(script, /SetAttribute\('silent', 'true'\)/)
})

test('buildAppleScript quotes and sounds the notification', () => {
  assert.equal(
    buildAppleScript({ title: 'DSH 需要你的确认', body: '工具 bash 请求授权', silent: false }),
    'display notification "工具 bash 请求授权" with title "DSH 需要你的确认" sound name "Ping"',
  )
  assert.equal(buildAppleScript({ title: 't', body: 'b', silent: true }), 'display notification "b" with title "t"')
})

test('encodePowerShellCommand round-trips through UTF-16LE base64', () => {
  const script = "Write-Output '中文 ok'"
  const decoded = Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')
  assert.equal(decoded, script)
})

test('buildNotificationCommand plans Windows, macOS, Linux, and nothing else', () => {
  const windows = buildNotificationCommand({ platform: 'win32', title: 'T', body: 'B', systemRoot: 'D:\\Windows' })
  assert.equal(windows.kind, 'windows-toast')
  assert.deepEqual(windows.executables, [
    'powershell.exe',
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'pwsh.exe',
  ])
  assert.deepEqual(windows.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assert.match(decodeEncoded(windows.args), /CreateTextNode\('T'\)/)

  const mac = buildNotificationCommand({ platform: 'darwin', title: 'T', body: 'B' })
  assert.equal(mac.kind, 'macos-notification')
  assert.deepEqual(mac.executables, ['osascript', '/usr/bin/osascript'])
  assert.deepEqual(mac.args, ['-e', buildAppleScript({ title: 'T', body: 'B', silent: false })])

  const linux = buildNotificationCommand({ platform: 'linux', title: 'T', body: 'B', appName: 'MyDSH' })
  assert.equal(linux.kind, 'notify-send')
  assert.deepEqual(linux.executables, ['notify-send', '/usr/bin/notify-send'])
  assert.deepEqual(linux.args, ['--app-name=MyDSH', 'T', 'B'])

  assert.equal(buildNotificationCommand({ platform: 'aix', title: 'T', body: 'B' }), null)
  assert.equal(buildNotificationCommand({ platform: 'win32', title: 'T', body: 'B' }).executables[0], 'powershell.exe')
})

test('resolveDisplayReason prefers this locale, then zh, then en, then reason', () => {
  const display = { en: 'english text', zh: '中文说明' }
  assert.equal(resolveDisplayReason(display, 'raw', 'en-US'), 'english text')
  assert.equal(resolveDisplayReason(display, 'raw', 'zh'), '中文说明')
  assert.equal(resolveDisplayReason({ de: 'deutsch' }, 'raw', 'zh'), 'deutsch')
  assert.equal(resolveDisplayReason(undefined, 'raw reason', 'zh'), 'raw reason')
  assert.equal(resolveDisplayReason(undefined, undefined, 'zh'), null)
  assert.equal(resolveDisplayReason({}, '   ', 'zh'), null)
})

test('approvalNotice names the tool and uses the localized reason', () => {
  const notice = approvalNotice({
    toolName: 'bash',
    reason: 'fallback',
    displayReason: { en: 'run a privileged command', zh: '执行越权命令' },
  }, { locale: 'zh' })
  assert.equal(notice.kind, 'approval')
  assert.equal(notice.title, 'DSH 需要你的确认')
  assert.equal(notice.body, '工具 bash 请求授权：执行越权命令')

  const english = approvalNotice({ toolName: 'bash' }, { locale: 'en' })
  assert.equal(english.title, 'DSH needs your confirmation')
  assert.equal(english.body, 'Tool bash is waiting for your approval')
})

test('approvalNotice survives a request without a tool name or reason', () => {
  const notice = approvalNotice({}, { locale: 'zh' })
  assert.equal(notice.body, '工具 tool 正在等待你的审批')
})

test('questionNotice uses the first question, with its header when present', () => {
  const notice = questionNotice({
    questions: [{ id: 'q', question: '选哪种模式？', header: '确认' }],
  }, { locale: 'zh' })
  assert.equal(notice.kind, 'question')
  assert.equal(notice.title, 'DSH 需要你的回答')
  assert.equal(notice.body, '确认：选哪种模式？')

  assert.equal(questionNotice({ questions: [{ id: 'q' }] }, { locale: 'zh' }), null)
  assert.equal(questionNotice({}, { locale: 'zh' }), null)
  assert.equal(questionNotice(undefined, {}), null)
})

test('testNotice is a stable localized probe that names the loaded version', () => {
  assert.equal(testNotice({ locale: 'zh' }).kind, 'test')
  assert.equal(testNotice({ locale: 'en' }).title, 'DSH approval notifications are ready')
  assert.ok(testNotice({ locale: 'zh' }).body.includes(PLUGIN_VERSION))
  assert.ok(testNotice({ locale: 'en', version: '9.9.9' }).body.includes('v9.9.9'))
})

test('dedupeKeyOf prefers the Tool call id and stays stable otherwise', () => {
  const notice = { kind: 'question', title: 't', body: 'b' }
  assert.equal(dedupeKeyOf(notice, { callId: 'call-1', agent: { id: 's1' } }), 'question:call-1')
  assert.equal(dedupeKeyOf(notice, { agent: { id: 's1' } }), 'question:s1:t:b')
  assert.equal(dedupeKeyOf(notice, undefined), 'question::t:b')
})
