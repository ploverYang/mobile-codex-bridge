# Mobile Codex Bridge development rules

## End-user AI setup contract

When the user asks to install, configure, update, or diagnose this repository:

1. Read `docs/AI_SETUP.md` before changing files or starting services.
2. Prefer `scripts/setup-windows.ps1` for first-time Windows setup and `scripts/bridge.ps1 doctor -Json` for diagnostics.
3. Preserve an existing `config.local.json` unless the user explicitly asks to replace it.
4. Keep `server.host` on `127.0.0.1` unless the user deliberately chooses another protected network boundary.
5. Explain before first start that phone-created tasks currently use full filesystem/command access and no routine approvals.
6. Do not install login startup, run `tailscale serve`, expose a port, or add a project without explicit user confirmation.
7. Never read or reveal `data/state.json`, admin tokens, session tokens, WeChat secrets, private tailnet names, or unrelated task history. A newly generated one-time pairing code may be shown only to the requesting user.
8. The one-time pairing code intentionally defaults to 7 days (`10080` minutes) and becomes invalid immediately after successful use. Do not shorten it unless the user asks.
9. Complete setup only after `doctor`, `status`, `/api/health`, and a harmless first task have been verified in proportion to the environment.

Repository facts and commands belong in `docs/AI_SETUP.md`; do not duplicate a drifting installation procedure in model-specific instruction files.

## Mandatory release discipline

- Every code change must use a new, previously unused base version. Never finish a code update while retaining an existing version.
- Use a MINOR version increment for backward-compatible features, UI changes, fixes, refactors, and operational improvements.
- Use a MAJOR version increment for incompatible API, configuration, storage, authentication, or Codex protocol changes.
- Keep the base version aligned across `package.json` and `.codex-plugin/plugin.json`. After setting the new base version, run the plugin cachebuster helper so the manifest becomes `<base>+codex.<timestamp>`.
- Change the PWA cache namespace in `public/service-worker.js` for every code release. Prefer a namespace containing the new base version.

## Mandatory restart and verification

After every code update, all of the following are required before reporting completion:

1. Run the relevant syntax checks and `npm test`.
2. Validate the plugin manifest.
3. Restart Bridge with `npm run stop`, then `npm run daemon:start`.
4. Run `npm run status` and confirm that Bridge is online, Codex is connected, and the reported version is the new base version.
5. Verify `/api/health` reports the same new version. A code update is incomplete if Bridge was not restarted or still reports an older version.

Documentation-only edits do not require a version increment or Bridge restart unless they accompany code changes.
