# 故障排查

先运行：

```powershell
.\scripts\bridge.ps1 doctor -Json
```

优先根据失败检查项的 `fix` 处理。需要日志时只读取 `data/bridge.log` 的相关尾部，并在分享前移除地址、项目名和其他私人信息；永远不要分享 `data/state.json`。

## 找不到配置文件

运行 `scripts/setup-windows.ps1`，或复制 `config.example.json` 为 `config.local.json` 后把项目占位路径改成真实目录。不要提交本机配置。

## Node.js 版本过低

安装 Node.js 20 或更高版本，关闭并重新打开 PowerShell，然后再次运行 `doctor`。本项目目前没有第三方 npm 依赖，不需要用 `npm install` 修复环境。

## Codex 运行时不可用或拒绝访问

1. 确认 Codex Desktop 已安装并登录。
2. 关闭并重新打开终端，让桌面运行时路径进入当前环境。
3. 不要为了绕过问题安装旧版全局 `@openai/codex`。
4. 再运行 `doctor` 和 `self-test`。

WindowsApps 中的可执行文件可能受 Application Protected 限制。Bridge 会自动把当前桌面版 Codex 和必要辅助程序同步到 `%CODEX_HOME%\mobile-codex-bridge-runtime` 后运行。

## Bridge 在线但 Codex 未连接

```powershell
.\scripts\bridge.ps1 stop
.\scripts\bridge.ps1 self-test
.\scripts\bridge.ps1 start
.\scripts\bridge.ps1 status
```

如果 `self-test` 失败，再检查 `data/bridge.log`。自检创建的是临时线程，只证明协议握手；真实续聊仍需要已有的持久化 Codex 线程。

## 手机打不开地址

- `127.0.0.1` 只能在电脑本机访问。
- 推荐电脑和手机加入同一 Tailscale 网络，并配置 `tailscale serve --bg 3847`。
- 把生成的 HTTPS 地址写入 `server.publicBaseUrl`，重启后重新生成配对码。
- 不要直接公开 Codex App Server 或 `data/`。

## 手机仍显示旧界面

完全关闭 PWA 或浏览器标签后重新打开。每个发布版本都会更换 Service Worker 缓存名，但已打开页面仍可能保留旧资源。

## 手机有任务，桌面侧边栏没有

确认 Bridge 与 Codex Desktop 使用同一个 Windows 用户和 `CODEX_HOME`。尝试手机任务卡中的“电脑端打开”，并在 Codex Desktop 的 Tasks 过滤菜单选择 **Chronological**，同时检查 Archived tasks。

## HTTP 429

避免同时打开多个手机标签持续轮询。关闭旧页面后等待一分钟重试。不要通过大幅提高限流掩盖重复客户端或缓存页面。
