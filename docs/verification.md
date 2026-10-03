# 验证记录

本文件记录每项能力**怎么验证、验证到什么程度**。第 1 节是任何机器都能复现的检查；第 2 节是一次性的人工实测记录；第 3 节明确尚未验证的部分。

## 1. 可复现的检查

```powershell
cd <插件目录>
node --test test/internal.test.mjs test/plugin.test.mjs   # 31 条，不需要 DSH 运行时
node test/live-windows.mjs auto                           # Windows：真弹一条通知并打印所选的命令计划
```

| 检查 | 覆盖内容 |
| --- | --- |
| `test/internal.test.mjs` | 配置校验与归一化（含越界钳制）、`locale: auto` 解析、按平台生成命令（win32 / darwin / linux / 未知平台）、PowerShell 脚本与 AppUserModelID 三级降级阶梯、PowerShell 与 AppleScript 转义、UTF-16LE base64 编码往返、通知文案与截断 |
| `test/plugin.test.mjs` | 监听器注册与 `{ prepend: true, global: true }` 选项、`next()` 同步透传且 waterfall 返回值不变、按平台的 argv 与 stdio、去重、超时看门狗、失败只记日志不抛错、未知平台只注册不发送 |
| `.github/workflows/test.yml` | 同一套测试在 ubuntu / windows / macos × node 20、22 上运行（矩阵与上面的命令一致） |

**与操作系统无关**：每条依赖平台的断言都用 `withPlatform()` 把 `process.platform` 固定成目标系统，测试不会因为"跑在哪台机器上"而改变结论。已用 `--import` 注入的 platform shim 在 **linux / darwin / freebsd / aix** 四种模拟宿主下各跑一遍，连同原生 Windows 全部 **31/31 通过**。

## 2. 人工实测记录（Windows）

| 项目 | 结果 |
| --- | --- |
| Windows 通知真的弹出 | 执行 `node test/live-windows.mjs auto`，观察到系统通知（标题「DSH 需要你的确认」，正文含工具名与原因），插件日志为 `已发送通知（windows-toast）` |
| 审批链路 | 同一份代码注册的 `approval/request` 监听器被真实驱动：通知发出，且 waterfall 返回值与 `next()` 委托均未改变 |
| 语言自动识别 | `locale: auto` 在中文系统上解析为 `zh` |
| 真实 DSH 事件 | 在真实运行的 DSH 会话中，`user-questions/request` 触发时捕获到通知进程 `powershell.exe -NoProfile -NonInteractive -EncodedCommand …`，解码后与预期脚本一致 |
| 插件激活 | profile 中该 bundle 条目为启用且已激活，注册的两个监听器选项为 `{ prepend: true, global: true }` |

## 3. 尚未验证 / 受限

| 项目 | 说明 |
| --- | --- |
| macOS / Linux 弹窗 | 未在真实系统上人工验证；只有命令组装的单测与 CI 覆盖 |
| 未知平台 | 只验证了「注册监听 + 记 warn + 不 spawn」的行为（单测） |
| `remove_bundle` 卸载 | README 给出的卸载命令未实测 |
| 专注助手 / 勿扰模式 | 未验证系统折叠通知时的表现 |
| 未来 Harness 版本 | 事件名与 `plugin_manager` 行为绑定当前版本，升级后需重新核对 |
