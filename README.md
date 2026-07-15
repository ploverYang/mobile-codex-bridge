# Mobile Codex Bridge

用手机语音或文字创建、查看和继续电脑上的 Codex 任务。手机不需要登录 ChatGPT，也不需要 OpenAI API Key；任务继续使用电脑现有的 Codex 登录、代理、项目文件和本地历史。

> [!IMPORTANT]
> 手机创建和续聊的任务默认使用完全访问与免审批策略，可以执行命令并修改电脑文件。只为自己信任的手机配对，并仅添加明确需要操作的项目目录。

## 能做什么

- 在手机 PWA 新建 Codex 任务，查看实时状态、完整多轮详情和工具活动。
- 使用手机系统键盘听写任务，不额外申请网页麦克风权限。
- 继续、中断、归档和恢复任务，并与 Codex Desktop 的任务历史联动。
- 使用项目白名单限制手机可以选择的工作目录。
- 通过 Tailscale Serve 从手机私有 HTTPS 访问，不公开暴露 Codex App Server。
- 可选微信公众号文本和语音识别结果接入。

```mermaid
flowchart LR
  Phone["手机 PWA / 微信"] -->|"配对会话"| Bridge["本机 Bridge"]
  Bridge -->|"stdio JSON-RPC"| Server["Codex App Server"]
  Server --> Codex["电脑 Codex 登录与任务历史"]
  Codex --> Project["允许的项目目录"]
```

## Windows 三步开始

要求：Windows 10/11、Node.js 20+、已安装并登录 Codex Desktop。项目当前没有第三方 npm 依赖，无需运行 `npm install`。

1. 从 GitHub Releases 下载 ZIP 并解压，或克隆仓库：

   ```powershell
   git clone https://github.com/ploverYang/mobile-codex-bridge.git
   cd mobile-codex-bridge
   ```

2. 在解压目录打开 PowerShell，运行安装向导：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
   ```

3. 按提示选择一个允许手机操作的项目、决定是否登录自启，然后在手机打开向导给出的地址并输入一次性配对码。

一次性配对码默认有效 7 天，成功配对后立即失效；已配对设备的会话默认有效 30 天。安装向导不会自动开放公网，也不会未经确认安装 Windows 登录自启任务。

如果你希望让 AI 帮你完成安装，把仓库交给 AI 并让它阅读 [AI 安装说明](docs/AI_SETUP.md)。

## 手机访问

Bridge 默认只监听 `127.0.0.1:3847`。推荐电脑和手机登录同一个 Tailscale 网络，然后在电脑执行：

```powershell
tailscale serve --bg 3847
tailscale serve status
```

把生成的 `https://...ts.net` 地址写入 `config.local.json` 的 `server.publicBaseUrl`，重启 Bridge 后重新生成配对码。不要把 Codex App Server、Bridge 管理 API 或 `data/` 目录直接暴露到公网。

同一局域网可以把 `server.host` 改成 `0.0.0.0` 后通过电脑 IP 访问，但没有自动 HTTPS，不建议长期使用。

## 日常命令

```powershell
.\scripts\bridge.ps1 doctor
.\scripts\bridge.ps1 doctor -Json
.\scripts\bridge.ps1 status
.\scripts\bridge.ps1 start
.\scripts\bridge.ps1 pair
.\scripts\bridge.ps1 stop
.\scripts\bridge.ps1 self-test
```

`doctor -Json` 提供不含会话密钥的结构化诊断，适合交给 AI 判断环境和下一步修复方式。

## 配置

首次安装会生成不会提交到 Git 的 `config.local.json`。主要字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | Bridge 监听地址 |
| `server.port` | `3847` | PWA 与 API 端口 |
| `server.publicBaseUrl` | 空 | 手机实际访问的私有 HTTPS 地址 |
| `projects[]` | 必填 | 手机可选择的项目白名单 |
| `desktop.autoOpen` | `on-complete` | 完成后在 Codex Desktop 加载任务 |
| `security.pairingTtlMinutes` | `10080` | 一次性配对码有效 7 天，使用后失效 |
| `security.sessionTtlDays` | `30` | 已配对设备会话有效期 |
| `storage.persistOutputs` | `false` | Bridge 不额外持久化完整 Codex 输出 |

完整字段参见 [config.schema.json](config.schema.json) 和 [config.example.json](config.example.json)。运行时私密状态保存在 `data/`；不要读取、复制或提交 `data/state.json`。

## Windows 登录自启

安装向导会询问是否启用。也可以手动执行：

```powershell
.\scripts\install-windows-startup.ps1
.\scripts\uninstall-windows-startup.ps1
```

自启使用当前 Windows 用户的计划任务，不保存 OpenAI 凭据。使用自定义配置时可传入 `-Config`。

## 微信公众号

当前适配器支持签名校验、文本消息和已经包含 `Recognition` 的语音消息。生产环境尚不支持公众号 AES 安全模式，不应直接作为公开公众号服务部署。详细配置和当前边界见 [安全说明](SECURITY.md)。

## 文档

- [让 AI 帮助安装](docs/AI_SETUP.md)
- [常见故障与确定性修复](docs/TROUBLESHOOTING.md)
- [安全边界](SECURITY.md)
- [开发、测试与发布](docs/DEVELOPMENT.md)
- [版本记录](CHANGELOG.md)
- [MIT License](LICENSE)

如果 Codex Desktop 升级后 Bridge 无法工作，先运行 `doctor` 和 `self-test`。Windows 版会自动发现桌面应用附带的当前 `codex.exe`，并把所需辅助运行时同步到 `%CODEX_HOME%\mobile-codex-bridge-runtime`，无需全局安装 `@openai/codex`。
