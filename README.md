# DSH 审批提醒（@local/dsh-approval-notify）

当 DSH 需要你确认时，弹出一条 **系统通知** 提醒你：

- **Tool 审批**：模型调用需要你授权的工具（DSH 界面里的「等待审批」）。
- **向你提问**：模型用 `ask_user_question` 提问并等你回答。

浏览器标签页最小化、切到别的窗口时同样有效，不依赖页面是否在前台。当前版本 **v1.1.0**。

> **English summary** — A DSH (DeepSeek Harness) profile bundle that raises a
> desktop notification whenever the Harness waits for you: a Tool call that needs
> approval (`approval/request`) or a question asked with `ask_user_question`
> (`user-questions/request`). It registers one pass-through waterfall listener
> per event (`{ prepend: true, global: true }`, always calling `next()`), so it
> observes without ever deciding anything, and it has no dependencies. Windows
> toast via WinRT, macOS via `osascript`, Linux/BSD via `notify-send`; the
> platform only enters the pure helpers as an input, so the test suite runs
> anywhere.

## 它如何工作

DSH 在等待你之前，会先派发一个 waterfall 事件：

| 事件 | 时机 |
| --- | --- |
| `approval/request` | 某个工具调用需要你授权 |
| `user-questions/request` | 模型向你提问并等待回答 |

本插件在 `apply` 里为这两个事件各注册一个 **`{ prepend: true, global: true }` 监听器**：

- `prepend` 让它排在 Web 桥接监听器之前，所以无论页面上有没有人在应答，都能收到每一次请求；
- 监听器**只观察、不决策**：同步返回 `next()`，审批链路的顺序、结果与「ask/outcome」日志完全不变；
- 通知内容由请求本身生成（工具名 + `displayReason` 本地化原因，或问题标题/正文），随后按平台计划命令、经 `ctx.subprocess.resolveExecutable` 找到可执行文件，再启动一个短命进程：
  - Windows：`powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64(UTF-16LE)>` → WinRT `ToastNotificationManager`
  - macOS：`osascript -e 'display notification …'`
  - Linux/BSD：`notify-send --app-name=DSH <title> <body>`

脚本通过 `-EncodedCommand` 传入，因此中文、引号都不会被命令行或编码破坏；进程有超时看门狗，任何失败只写日志（`[dsh-approval-notify] …`），绝不会影响审批本身。

## 为什么它在别的电脑上也通用

代码里没有任何本机专有信息，全部在运行时按环境决定：

| 关注点 | 处理方式 |
| --- | --- |
| 安装路径 | 用 `import.meta.url` 算出插件目录当 `cwd`，不写死任何本机专有路径 |
| 界面语言 | `locale: auto`（默认）跟随机器 locale，中文系统出中文、其他出英文 |
| PowerShell | 依次尝试 `powershell.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → `pwsh.exe`，PATH 被裁剪或只装了 PowerShell 7 也能找到 |
| Toast 身份 | AppUserModelID 走三级降级：配置值 → PowerShell 自身 AUMID → 宿主进程身份；某个机器没注册 `PowerShell` 也不会静默丢通知 |
| 编码 | 全程 `-EncodedCommand`（UTF-16LE base64），不落临时 `.ps1`、不受 ExecutionPolicy 与命令行代码页影响 |
| 写入 | 不写任何文件/注册表/profile 状态，只弹通知 |
| 监听注册 | 不依赖具体机器，`prepend + global` 与 DSH 版本的事件契约绑定 |
| 平台 | Windows / macOS / Linux·BSD 三种后端；未知平台只记 warn（激活时一条、首次跳过提醒时再一条），不抛错 |

## 仓库内容

| 路径 | 内容 |
| --- | --- |
| `index.js` | Host 半边：两个监听器、平台命令计划、子进程与超时看门狗、去重 |
| `internal.js` | 纯函数：配置校验、通知文案、按平台生成命令、脚本与转义 |
| `cordis.patch.yml` | bundle patch：插入插件行 + 带注释的全部配置 |
| `package.json` | DSH bundle 清单（`dsh.bundle.patch`）、显示元数据、图标 |
| `icon.svg` | 插件卡片图标 |
| `locale/zh.json`、`locale/en.json` | 插件卡片名称与说明 |
| `test/internal.test.mjs`、`test/plugin.test.mjs` | 31 条单测/集成测试，不需要 DSH 运行时 |
| `test/live-windows.mjs` | 可选的本机活体自检，会真的弹一条通知 |
| `docs/verification.md` | 各能力的验证方式、可复现命令与实测记录 |
| `.github/workflows/test.yml` | CI：ubuntu / windows / macos × node 20、22 |
| `CHANGELOG.md`、`LICENSE` | 版本记录与 MIT 许可 |

> 包名沿用 DSH profile 的本地约定 `@local/dsh-approval-notify`，并且 `package.json` 标了
> `private: true`：这个包是「按目录安装进 profile」的 bundle，不是 npm 发布物。要发布到
> npm 的话，把 `name` 换成自己的 scope 并去掉 `private`，然后在 profile 里重新安装一次
> （profile 里那条 `link:` 依赖指向旧包名，改名会需要重装）。

## 安装

这是标准的 DSH workspace bundle，用 `plugin_manager` 在**目标机器**上安装一次（路径换成那台机器上的实际目录）：

```
plugin_manager(action: "install_bundle", target: "<该机器上 dsh-approval-notify 目录的绝对路径>")
```

安装后它出现在「设置 → 插件」里，名字是 **DSH 审批提醒**（entry id `include:dsh-approval-notify`）。它需要 profile 里有 `subprocess` 与 `timer` 服务（DSH 默认组合都有），否则插件保持不激活。

> 已安装之后再用同一个目录执行 `install_bundle` 会返回 `ambiguous-install`：profile 里这条依赖是 `link:` 路径且没有变化，plugin_manager 无法判断要重装哪个包。这是该工具的既有行为，不是插件问题。

## 配置

配置写在 bundle 自己的 `cordis.patch.yml`（本目录）；profile 的 `cordis.patch.yml` 里也可以用同一个 `id` 覆盖（`- id: dsh-approval-notify`）。

**改完之后必须重启 DSH 才生效**：`set_bundle` 关掉再打开只会重新激活条目，运行中的 Host 进程仍持有上一次安装时载入的模块代次与配置；JS 代码与 config 的改动都请重启后再验证。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时不注册任何监听 |
| `approvals` | `true` | 是否在 `approval/request` 时提醒 |
| `userQuestions` | `true` | 是否在 `user-questions/request` 时提醒 |
| `locale` | `auto` | 文案语言：`auto`（跟随机器）/ `zh` / `en`；其他值等同 `auto` |
| `silent` | `false` | `true` 时通知不发声（Windows / macOS） |
| `toastAppId` | `PowerShell` | 首选 Windows AppUserModelID，失败会自动降级 |
| `appName` | `DSH` | Linux `notify-send` 显示的应用名 |
| `dedupeMs` | `1200` | 同一请求在此毫秒内只提醒一次 |
| `timeoutMs` | `15000` | 通知进程超过此时长未退出就终止 |
| `testOnLoad` | `false` | 插件加载后 1.5 秒发一条带版本号的测试通知 |

## 怎么验证

```powershell
cd <插件目录>

# 1) 纯函数 + Host 半逻辑，31 条，任何操作系统上都能跑（平台是入参，用 stub 覆盖 win32/darwin/linux/未知）
node --test test/internal.test.mjs test/plugin.test.mjs

# 2) 本机活体自检：真的走 apply → 监听器 → 命令计划 → 真实通知进程 → 真弹一条通知
node test/live-windows.mjs auto
```

`live-windows.mjs` 会打印它选中的后端、可执行文件、argv、`cwd`、脚本里是否带 AppId 降级阶梯、标题/正文，以及 `next()` 是否被原样透传。第一条命令与 CI 跑的是同一条。

各项能力的验证方式、覆盖范围与实测记录见 [`docs/verification.md`](docs/verification.md)。

## 已知限制

- 需要系统里存在 `powershell.exe` 或 `pwsh.exe`；两者都没有时只记 warn。
- 「专注助手 / 勿扰模式」可能把 toast 折叠进通知中心而不弹出；`silent: true` 只是让通知不发声。
- 目前每次请求只提醒一次，不重复催办。
- 同一 profile 内所有会话共用这一份插件与配置。
- 事件名与 `plugin_manager` 行为绑定当前 Harness 版本，DSH 升级后可能需要相应调整。
- 安装/切换 bundle 时 diagnostics 里可能同时出现别的本地插件的激活失败信息；那与本插件无关，重启 DSH 会按磁盘上的当前代码重新加载。

## 卸载

```
plugin_manager(action: "remove_bundle", target: "@local/dsh-approval-notify")
```
