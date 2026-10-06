import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type AddressInfo } from "node:net";
import { type Server } from "node:http";
import { Store } from "../src/store.js";
import { createApp } from "../src/server.js";

let server: Server;
let base: string;
let store: Store;
let dir: string;

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const body = (await res.json()) as any;
  return { status: res.status, body };
}

before(async () => {
  dir = join(tmpdir(), `minhash-api-${Date.now()}`);
  store = new Store(join(dir, "api.db"));
  server = createApp(store);
  await new Promise<void>((resolve_) => server.listen(0, "127.0.0.1", () => resolve_()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("完整 API 流程：创建-追加-比较-合并-历史-导入导出", async () => {
  const c1 = await api("/summaries", { method: "POST", body: { seed: 5, numRows: 32, tokens: ["a", "b"] } });
  assert.equal(c1.status, 201);
  const id1 = c1.body.summary.id;
  const c2 = await api("/summaries", { method: "POST", body: { seed: 5, numRows: 32, tokens: ["b", "c"] } });
  const id2 = c2.body.summary.id;

  const app = await api(`/summaries/${id1}/append`, { method: "POST", body: { tokens: ["c"] } });
  assert.equal(app.status, 200);
  assert.equal(app.body.summary.version, 2);

  const cmp = await api("/compare", { method: "POST", body: { pairs: [{ leftId: id1, rightId: id2 }] } });
  assert.equal(cmp.status, 200);
  assert.equal(cmp.body.results[0].compatible, true);
  assert.equal(cmp.body.results[0].matchCount, cmp.body.results[0].matchedRows.length);
  assert.ok(cmp.body.results[0].estimate > 0 && cmp.body.results[0].estimate < 1);

  const c3 = await api("/summaries", { method: "POST", body: { seed: 5, numRows: 32, tokens: ["c", "b", "a", "a"] } });
  const cmpSame = await api("/compare", {
    method: "POST",
    body: { pairs: [{ leftId: id1, rightId: c3.body.summary.id }] }
  });
  assert.equal(cmpSame.body.results[0].estimate, 1);

  const merge = await api("/merge", { method: "POST", body: { sourceIds: [id1, id2] } });
  assert.equal(merge.status, 201);
  assert.equal(merge.body.summary.kind, "merge");

  const hist = await api(`/summaries/${id1}/history`);
  assert.equal(hist.body.history.length, 2);

  const exp = await api("/export", { method: "POST", body: { ids: [id1] } });
  assert.equal(exp.body.format, "minhash-summary/v1");
  const imp = await api("/import", { method: "POST", body: exp.body });
  assert.equal(imp.status, 201);
  assert.deepEqual(imp.body.imported[0].rows, exp.body.summaries[0].rows);
});

test("校验错误返回明确错误码", async () => {
  const badRows = await api("/summaries", { method: "POST", body: { seed: 0, numRows: 8, tokens: [] } });
  assert.equal(badRows.status, 400);
  assert.equal(badRows.body.error.code, "ROWS_OUT_OF_RANGE");

  const badUnicode = await api("/summaries", {
    method: "POST",
    body: { seed: 0, numRows: 16, tokens: ["\ud800"] }
  });
  assert.equal(badUnicode.body.error.code, "INVALID_UNICODE");

  const notFound = await api("/summaries/nope");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, "SUMMARY_NOT_FOUND");

  const invalidJson = await fetch(base + "/summaries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  const body = (await invalidJson.json()) as any;
  assert.equal(body.error.code, "INVALID_JSON");
});

test("不兼容比较返回具体原因而不是 500", async () => {
  const a = await api("/summaries", { method: "POST", body: { seed: 1, numRows: 32, tokens: ["a"] } });
  const b = await api("/summaries", { method: "POST", body: { seed: 2, numRows: 32, tokens: ["a"] } });
  const cmp = await api("/compare", {
    method: "POST",
    body: { pairs: [{ leftId: a.body.summary.id, rightId: b.body.summary.id }] }
  });
  assert.equal(cmp.status, 200);
  assert.equal(cmp.body.results[0].compatible, false);
  assert.equal(cmp.body.results[0].reasonCode, "SEED_MISMATCH");
});
