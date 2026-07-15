import assert from "node:assert/strict";
import test from "node:test";
import { MIME } from "../bridge/server.mjs";

test("ES modules are served as JavaScript under nosniff", () => {
  assert.equal(MIME[".mjs"], "text/javascript; charset=utf-8");
});
