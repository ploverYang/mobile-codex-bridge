import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BRIDGE_VERSION } from "../bridge/version.mjs";

test("release version stays aligned across runtime, plugin manifest, and PWA cache", async () => {
  const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pluginMetadata = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  const serviceWorker = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");

  assert.equal(BRIDGE_VERSION, packageMetadata.version);
  assert.equal(pluginMetadata.version.split("+")[0], packageMetadata.version);
  assert.match(serviceWorker, new RegExp(`mobile-codex-bridge-v${packageMetadata.version.replaceAll(".", "\\.")}`));
});
