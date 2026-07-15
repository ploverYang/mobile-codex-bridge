import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, runDoctor } from "../bridge/doctor.mjs";

test("doctor exposes stable machine-readable checks without treating optional services as failures", async () => {
  const report = await runDoctor({
    nodeVersion: "22.0.0",
    platform: "win32",
    configPath: "C:/bridge/config.local.json",
    load: async () => ({
      configPath: "C:/bridge/config.local.json",
      projects: [{ id: "demo" }],
      codex: { binary: "codex" },
      server: { port: 3847 },
      security: { pairingTtlMinutes: 10_080 },
    }),
    resolveLaunch: () => ({ command: "codex.exe", argsPrefix: [] }),
    codexVersion: async () => "codex-cli 1.0.0",
    bridgeHealth: async () => { throw new Error("connect ECONNREFUSED"); },
    findTailscale: async () => null,
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.checks.find((check) => check.id === "bridge").status, "warn");
  assert.equal(report.checks.find((check) => check.id === "config").details.pairingTtlMinutes, 10_080);
  assert.match(formatDoctorReport(report), /0 失败/);
});

test("doctor fails when required configuration is invalid", async () => {
  const report = await runDoctor({
    nodeVersion: "22.0.0",
    platform: "win32",
    load: async () => { throw new Error("找不到配置文件"); },
    resolveLaunch: () => ({ command: "codex.exe", argsPrefix: [] }),
    codexVersion: async () => "codex-cli 1.0.0",
    findTailscale: async () => "tailscale.exe",
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "config").status, "fail");
});
