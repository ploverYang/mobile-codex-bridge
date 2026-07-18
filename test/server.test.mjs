import assert from "node:assert/strict";
import test from "node:test";
import { MIME, requestLimitClass } from "../bridge/server.mjs";

test("ES modules are served as JavaScript under nosniff", () => {
  assert.equal(MIME[".mjs"], "text/javascript; charset=utf-8");
});

test("health checks are exempt and read polling is separated from write rate limits", () => {
  assert.equal(requestLimitClass("GET", "/api/health"), "none");
  assert.equal(requestLimitClass("GET", "/api/tasks"), "read");
  assert.equal(requestLimitClass("POST", "/api/tasks"), "write");
});
