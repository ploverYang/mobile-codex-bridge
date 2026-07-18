# AI 安装与诊断协议

本文给能够访问本仓库和用户终端的 AI 使用。目标是在不暴露凭据、不扩大网络边界、不覆盖用户配置的前提下，让用户快速完成 Mobile Codex Bridge 安装。

## 必须遵守的边界

- 首次启动前明确告知用户：手机任务可选择与电脑端一致的访问等级，默认完全访问，可执行命令并修改电脑文件。
- 一次性配对码默认有效 7 天（`10080` 分钟），成功使用后立即失效。除非用户要求，否则不要缩短。
- 保持 `server.host: 127.0.0.1`。只有用户明确选择受保护的网络方式时才改变监听边界。
- Tailscale Serve、Windows 登录自启、项目白名单中的每个目录都需要用户明确确认。
- 不读取或输出 `data/state.json`、admin token、session token、微信密钥、私有 tailnet 信息或无关任务历史。
- 不安装全局 `@openai/codex`。Windows Bridge 会优先使用 Codex Desktop 附带的运行时。

## Windows 黄金路径

1. 确认用户已安装并登录 Codex Desktop。
2. 在仓库根目录运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
   ```

3. 向导会检查 Node.js 20+、要求用户确认完全访问、创建或保留配置、启动服务并生成一次性配对码。
4. 如果用户需要手机跨设备访问，推荐同一 tailnet 下的 Tailscale Serve；不要把 App Server 暴露到公网。
5. 完成后执行验证清单。

非交互安装仅适合用户已经明确给出全部选择的情况：

```powershell
.\scripts\setup-windows.ps1 `
  -NonInteractive `
  -AcceptFullAccess `
  -ProjectPath "D:\path\to\project" `
  -ProjectName "My Project" `
  -ProjectId "my-project"
```

按用户要求增加 `-InstallStartup` 或 `-PublicBaseUrl "https://device.example.ts.net"`。不要自行添加这些参数。

## 诊断优先流程

先运行机器可读诊断：

```powershell
.\scripts\bridge.ps1 doctor -Json
```

输出结构：

```json
{
  "ok": true,
  "version": "0.15.0",
  "checks": [
    {
      "id": "node|platform|config|codex|bridge|tailscale",
      "status": "pass|warn|fail",
      "message": "给用户看的结论",
      "fix": "可选的确定性修复"
    }
  ],
  "summary": { "pass": 5, "warn": 1, "fail": 0 }
}
```

- `fail` 必须解决后才能声称安装完成。
- `warn` 可能只是 Bridge 未启动或未安装可选的 Tailscale，不要擅自扩大操作范围。
- 修复后重新运行 `doctor -Json`，不要凭日志片段猜测成功。

## 配置策略

- `config.local.json` 已存在：默认保留，只做校验和用户要求的最小修改。
- 配置不存在：使用安装向导生成，不要直接复制带占位路径的示例后启动。
- 项目 `id` 使用字母、数字和连字符；路径必须存在且由用户明确指定。
- `storage.persistOutputs` 默认保持 `false`。
- `desktop.autoOpen` 推荐 `on-complete`，避免两个 App Server 同时加载活动线程。

## 完成标准

依次确认：

```powershell
.\scripts\bridge.ps1 doctor
.\scripts\bridge.ps1 self-test
.\scripts\bridge.ps1 status
```

然后读取 `http://127.0.0.1:3847/api/health`，确认：

- `ok=true`
- `codexReady=true`
- `version` 与 `package.json` 一致

最后让用户从手机提交一条无副作用任务，例如“只读取项目根目录 README 标题并回复，不修改文件”。手机端看到完成状态且桌面端能加载同一任务，才算闭环完成。

## 可直接给 AI 的提示词

> 请先阅读仓库根目录 `AGENTS.md` 和 `docs/AI_SETUP.md`，帮助我安装 Mobile Codex Bridge。先运行 `doctor -Json`，保留已有配置，只添加我明确指定的项目。一次性配对码保持 7 天。未经我确认，不启用登录自启、不运行 Tailscale Serve、不改变监听地址。不要读取或输出 `data/state.json`、管理令牌或会话令牌。完成后验证 doctor、self-test、status 和 health，再把手机地址与一次性配对码告诉我。
