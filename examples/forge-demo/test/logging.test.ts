import { test } from "node:test";
import assert from "node:assert/strict";
import { callJson, logLines } from "./helpers.ts";

test("every request emits one structured access-log line", async () => {
  const before = logLines.length;
  await callJson("GET", "/health");
  assert.equal(logLines.length, before + 1);
  const line = JSON.parse(logLines[logLines.length - 1]);
  assert.equal(line.level, "info");
  assert.equal(line.method, "GET");
  assert.equal(line.path, "/health");
  assert.equal(line.status, 200);
});
