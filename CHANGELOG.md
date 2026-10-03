# Changelog

All notable changes to this bundle are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The test suite no longer depends on the machine it runs on: every assertion
  that describes one platform now pins `process.platform` explicitly, so
  `node --test` reaches the same result on Windows, macOS, and Linux. The CI
  matrix previously failed on ubuntu and macOS while passing on Windows.

## [1.1.0] — 2026-10-03

### Added

- Per-platform notification backends: Windows toast (WinRT), macOS `osascript`,
  and Linux/BSD `notify-send`; an unknown platform logs one warning instead of
  silently doing nothing.
- `locale: auto` (new default): the notification text follows the machine's
  locale, falling back to English for any language other than Chinese.
- Executable discovery ladders: `powershell.exe` → absolute
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → `pwsh.exe`, and
  bare name → `/usr/bin/...` for the POSIX backends, so a scrubbed `PATH` or a
  PowerShell 7-only machine still works.
- Windows notifier identity ladder (configured AppUserModelID → PowerShell's own
  AUMID → host process identity), so a machine that has not registered
  `PowerShell` as a toast app still shows the notification.
- `appName` config key for the `notify-send` backend.
- `test/live-windows.mjs`: opt-in live check that runs the real Host half
  against a real subprocess implementation and prints the chosen backend, argv,
  and decoded script.
- GitHub Actions workflow running the test suite on Linux, Windows, and macOS.

### Changed

- The Host half is now platform-generic: no absolute paths, no machine-specific
  assumptions, and the platform enters the pure helpers as an input, so the test
  suite runs identically everywhere.
- The test suite grew from 23 to 31 cases and covers the win32 / darwin / linux
  / unsupported branches, locale resolution, the AppUserModelID ladder, and
  AppleScript escaping.

### Fixed

- The load-time test notification now names the loaded version, which makes it
  possible to tell which module generation a running host holds.

## [1.0.0] — 2026-10-03

### Added

- First version: pass-through listeners on `approval/request` and
  `user-questions/request` that raise a Windows toast, with `enabled`,
  `approvals`, `userQuestions`, `locale`, `silent`, `toastAppId`, `dedupeMs`,
  `timeoutMs`, and `testOnLoad` configuration.
