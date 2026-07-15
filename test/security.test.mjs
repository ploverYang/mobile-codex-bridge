import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecurityStore } from "../bridge/security.mjs";

test("pairing code is one-time and creates an authorized session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mobile-codex-security-"));
  try {
    let now = 1_700_000_000_000;
    const store = await new SecurityStore(directory, { pairingTtlMinutes: 10, sessionTtlDays: 30 }, () => now).init();
    const pairing = store.createPairing();
    await assert.rejects(() => store.pair("999999", "bad"), /不正确/);
    const session = await store.pair(pairing.code, "test phone");
    assert.equal(store.authorize(session.token), true);
    assert.equal(store.authorize("not-a-token"), false);
    assert.equal(await store.revoke(session.token), true);
    assert.equal(store.authorize(session.token), false);
    assert.equal(await store.revoke(session.token), false);
    await assert.rejects(() => store.pair(pairing.code, "second"), /过期/);
    now = session.expiresAt + 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
