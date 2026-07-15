import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexLaunch } from "../bridge/codex-client.mjs";

test("Windows resolves the Codex command without a generic shell", { skip: process.platform !== "win32" }, () => {
  const resolved = resolveCodexLaunch("codex");
  assert.ok(resolved.command);
  assert.ok(resolved.argsPrefix.length > 0 || /codex\.exe$/i.test(resolved.command));
});

test("Windows prefers the desktop executable over an npm wrapper", { skip: process.platform !== "win32" }, () => {
  const desktop = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_current\\app\\resources\\codex.exe";
  const staged = "C:\\Users\\tester\\.codex\\mobile-codex-bridge-runtime\\codex.exe";
  const resolved = resolveCodexLaunch("codex", {
    locate(query) {
      if (query === "codex.exe") return [desktop];
      if (query === "codex.cmd") return ["E:\\node_global\\codex.cmd"];
      return [];
    },
    stageExecutable(source) {
      assert.equal(source, desktop);
      return staged;
    },
  });
  assert.deepEqual(resolved, { command: staged, argsPrefix: [] });
});
