import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bearerToken, clearSessionCookie, SecurityStore, sessionCookie } from "../bridge/security.mjs";

test("pairing code is one-time and creates an authorized session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mobile-codex-security-"));
  try {
    let now = 1_700_000_000_000;
    const store = await new SecurityStore(directory, { pairingTtlMinutes: 10, sessionTtlDays: 30 }, () => now).init();
    const pairing = store.createPairing();
    await assert.rejects(() => store.pair("999999", "bad"), /不正确/);
    const session = await store.pair(pairing.code, "test phone");
    assert.equal(session.expiresAt - now, 30 * 86_400_000);
    assert.equal(store.authorize(session.token), true);
    assert.equal(store.authorize("not-a-token"), false);
    await assert.rejects(() => store.pair(pairing.code, "second"), /过期/);
    now = session.expiresAt - 1;
    assert.equal(store.authorize(session.token), true);
    now = session.expiresAt + 1;
    assert.equal(store.authorize(session.token), false);
    const secondPairing = store.createPairing();
    const secondSession = await store.pair(secondPairing.code, "second phone");
    assert.equal(await store.revoke(secondSession.token), true);
    assert.equal(store.authorize(secondSession.token), false);
    assert.equal(await store.revoke(secondSession.token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired sessions can be restored from a 30-day HttpOnly cookie", () => {
  const request = { headers: { cookie: "theme=dark; mobile_codex_session=session-token" }, socket: {} };
  assert.equal(bearerToken(request), "session-token");
  assert.match(sessionCookie("session-token", Date.now() + 30 * 86_400_000, request), /Max-Age=2592000/);
  assert.match(sessionCookie("session-token", Date.now() + 30 * 86_400_000, {
    headers: { "x-forwarded-proto": "https" }, socket: {},
  }), /; Secure$/);
  assert.match(clearSessionCookie(request), /Max-Age=0/);
});
