---
name: mobile-codex-bridge
description: Start, stop, pair, configure, diagnose, persist, resume, cancel, or test the local Mobile Codex Bridge that manages Codex tasks from a phone PWA or WeChat callback. Use when the user asks to control Codex from a phone, create a mobile pairing code, continue a mobile task, add an allowed project, set up Windows startup, check the bridge, or configure the WeChat adapter.
---

# Mobile Codex Bridge

This plugin packages a local bridge daemon and phone PWA. The daemon uses the official Codex App Server protocol to create threads with the computer's existing Codex login, proxy environment, configuration, sandbox, and approval policy.

## Safety boundaries

- Keep `server.host` on `127.0.0.1` unless the user deliberately chose another protected network boundary.
- Prefer private HTTPS exposure through Tailscale Serve. Never expose the App Server itself to the public internet.
- Treat every pairing code like a short-lived password. Never print or reveal `data/state.json` or its admin token.
- Only offer project ids declared in `config.local.json`; do not accept arbitrary phone-supplied paths.
- Phone-created and resumed tasks can select the permission profiles advertised by the local Codex App Server; the default remains full access. Explain this before first use and do not claim full access is sandboxed.
- Keep `storage.persistOutputs` false unless the user explicitly accepts storing agent output in local bridge history.
- For a public WeChat callback, expose only `/wechat/callback` through the reverse proxy. The MVP supports plaintext callback mode, not AES safe mode.

## Locate and run the plugin

Resolve the plugin root as two directories above this `SKILL.md`. On Windows, use the included wrapper:

```powershell
& <plugin-root>\scripts\bridge.ps1 status
& <plugin-root>\scripts\bridge.ps1 start
& <plugin-root>\scripts\bridge.ps1 pair
& <plugin-root>\scripts\bridge.ps1 stop
& <plugin-root>\scripts\bridge.ps1 self-test
```

Use `serve` instead of `start` when the user wants foreground logs.

## First-time setup

1. Read `docs/AI_SETUP.md` from the plugin root.
2. On Windows, prefer `scripts/setup-windows.ps1`; it preserves an existing configuration and creates a new one interactively when needed.
3. Run `scripts/bridge.ps1 doctor -Json` and resolve required failures.
4. Run `self-test`. It starts an ephemeral thread only and does not run a Codex turn.
5. Run `start`, then `pair`. The one-time code defaults to 7 days and becomes invalid after successful use.
6. Verify `/api/health`, then ask the user to submit a harmless read-only task first.

## Long-running use

- Completed, failed, cancelled, or interrupted tasks can be continued from the phone. The bridge resumes the existing `threadId` before starting a new turn.
- Active tasks can be interrupted from the phone. Explain that interruption does not roll back file changes already made.
- Phone logout calls the server revoke endpoint; it is not only a local browser logout.
- Task metadata is stored in `data/tasks.json` when `storage.persistTaskHistory` is enabled. Full agent output is omitted by default.
- On Windows, install per-user login startup with `scripts/install-windows-startup.ps1`. Do not run it unless the user asks for persistent startup because it creates a Scheduled Task.

## Diagnostics

- `status` checks HTTP and App Server readiness.
- On Windows, the bridge prefers the current desktop-bundled `codex.exe` and syncs it into `%CODEX_HOME%\mobile-codex-bridge-runtime` before launch. Do not install a global `@openai/codex` merely to run this bridge.
- `desktop.autoOpen: on-complete` loads a finished bridge thread in the Codex desktop app through its registered `codex://threads/<thread-id>` protocol. The phone task card also exposes a manual desktop-open action.
- `data/bridge.log` contains daemon output; redact credentials before quoting it.
- `data/tasks.json` contains local task titles and thread ids. Treat it as private even when full output persistence is disabled.
- If App Server initialization fails, run `codex --version` and `codex login status`, then verify the fixed proxy environment is present in the daemon process.
- If the phone loads the PWA but speech recognition is unavailable, use the phone keyboard's dictation microphone. Browser speech APIs vary by OS and embedded browser.
- If a task is visible on the phone but not in the desktop app, confirm the bridge and desktop use the same OS user and `CODEX_HOME`, then refresh or start a new desktop task view.

## WeChat routing

When enabled, text and recognized voice messages create tasks. Route to a project with:

```text
#project-id 任务描述
```

Messages without a prefix use `wechat.defaultProjectId`. Configure the callback token through the environment variable named by `wechat.tokenEnv`; never put the token in the JSON file.
