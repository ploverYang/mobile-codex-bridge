import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../bridge/config.mjs";

test("configuration validates and normalizes allowlisted projects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mobile-codex-config-"));
  try {
    const project = path.join(directory, "project");
    await mkdir(project);
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      projects: [{ id: "demo", name: "Demo", path: project }],
      server: { port: 3847 },
      wechat: { defaultProjectId: "demo" },
    }));
    const config = await loadConfig(configPath);
    assert.equal(config.projects[0].path, path.resolve(project));
    assert.equal(config.server.host, "127.0.0.1");
    assert.equal(config.wechat.defaultProjectId, "demo");
    assert.equal(config.storage.persistTaskHistory, true);
    assert.equal(config.storage.persistOutputs, false);
    assert.equal(config.storage.maxTasks, 100);
    assert.equal(config.desktop.autoOpen, "never");
    assert.equal(config.security.pairingTtlMinutes, 10_080);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
