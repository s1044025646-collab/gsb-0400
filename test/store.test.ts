import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { AppError } from "../src/errors.js";
import { importBundle, exportSummaries } from "../src/io.js";
import { bigintJsonReplacer, stringsToRows } from "../src/serialize.js";
import { checkCompatible, compareRows } from "../src/minhash.js";

let dir: string;
let dbPath: string;
let store: Store;

before(() => {
  dir = join(tmpdir(), `minhash-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(dir, "t.db");
  store = new Store(dbPath);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("创建/追加/版本历史与原子性：失败批次不修改行", () => {
  const s = store.createSummary({ seed: 42, numRows: 32, tokens: ["a", "b"] });
  const v1 = JSON.stringify(s.rows, bigintJsonReplacer);
  const app = store.appendTokens(s.summaryId, ["c", "d"]);
  assert.equal(app.version, 2);
  assert.throws(
    () => store.appendTokens(s.summaryId, ["ok", "\ud800bad"]),
    (e: Error) => e instanceof AppError && e.code === "INVALID_UNICODE"
  );
  const still = store.getSummaryOrThrow(s.summaryId);
  assert.equal(still.version, 2, "失败批次未产生新版本");
  assert.equal(JSON.stringify(still.rows, bigintJsonReplacer), JSON.stringify(app.rows, bigintJsonReplacer));
  assert.notEqual(v1, JSON.stringify(app.rows, bigintJsonReplacer));
  const hist = store.history(s.summaryId, 10);
  assert.deepEqual(hist.map((h) => h.version), [2, 1]);
  assert.equal(hist[0]!.kind, "append");
  const old = store.getSummaryOrThrow(s.summaryId, 1);
  assert.equal(JSON.stringify(old.rows, bigintJsonReplacer), v1, "旧版本快照不受追加影响");
});

test("合并生成新版本摘要，来源不变", () => {
  const a = store.createSummary({ seed: 7, numRows: 48, tokens: ["a", "b"] });
  const b = store.createSummary({ seed: 7, numRows: 48, tokens: ["b", "c"] });
  const aRows = JSON.stringify(store.getSummaryOrThrow(a.summaryId).rows, bigintJsonReplacer);
  const m = store.mergeSummaries([a.summaryId, b.summaryId]);
  assert.equal(m.kind, "merge");
  assert.deepEqual(m.parents, [a.summaryId, b.summaryId]);
  const direct = store.createSummary({ seed: 7, numRows: 48, tokens: ["a", "b", "c"] });
  assert.deepEqual(m.rows, direct.rows);
  assert.equal(
    JSON.stringify(store.getSummaryOrThrow(a.summaryId).rows, bigintJsonReplacer),
    aRows
  );
});

test("不兼容合并不允许并给出原因", () => {
  const a = store.createSummary({ seed: 1, numRows: 32, tokens: ["a"] });
  const b = store.createSummary({ seed: 2, numRows: 32, tokens: ["a"] });
  assert.throws(
    () => store.mergeSummaries([a.summaryId, b.summaryId]),
    (e: Error) => e instanceof AppError && e.code === "INCOMPATIBLE_SUMMARIES"
  );
});

test("空集持久化：不以最大整数填充", () => {
  const e = store.createSummary({ seed: 1, numRows: 16, tokens: [] });
  assert.ok(e.isEmpty);
  const blob = store.db
    .prepare("SELECT rows FROM versions WHERE summary_id = ? AND version = 1")
    .get(e.summaryId) as { rows: Buffer | null };
  assert.equal(blob.rows, null);
  const reloaded = store.getSummaryOrThrow(e.summaryId);
  assert.equal(compareRows(reloaded.rows, reloaded.rows).estimate, 1);
});

test("导出/导入往返一致；导入损坏被拒", () => {
  const s = store.createSummary({ seed: 3, numRows: 24, tokens: ["x", "y", ""] });
  const bundle = exportSummaries(store, [s.summaryId]);
  const { imported } = importBundle(store, bundle);
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0]!.rows, s.rows);
  assert.equal(imported[0]!.kind, "import");

  const badDim = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  badDim.summaries[0]!.numRows = 23;
  assert.throws(
    () => importBundle(store, badDim),
    (e: Error) => e instanceof AppError && e.code === "IMPORT_INVALID"
  );

  const badRange = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  badRange.summaries[0]!.rows![0] = "18446744073709551616";
  assert.throws(() => importBundle(store, badRange), (e: Error) => e instanceof AppError);

  const badEmpty = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  badEmpty.summaries[0]!.isEmpty = true;
  badEmpty.summaries[0]!.rows = [];
  assert.throws(() => importBundle(store, badEmpty), (e: Error) => e instanceof AppError);

  const badFormat = { format: "nope", summaries: [] };
  assert.throws(() => importBundle(store, badFormat), (e: Error) => e instanceof AppError);
});

test("大整数序列化往返保留低位", () => {
  const vals = ["0", "18446744073709551615", "15373413931249009333"];
  const rows = stringsToRows(vals, 3);
  assert.deepEqual(rows.map((r) => (r as bigint).toString()), vals);
});

test("重启后继续追加与比较一致", () => {
  store.close();
  const reopened = new Store(dbPath);
  const s = reopened.createSummary({ seed: 11, numRows: 32, tokens: ["r1"] });
  const app = reopened.appendTokens(s.summaryId, ["r2"]);
  const other = reopened.createSummary({ seed: 11, numRows: 32, tokens: ["r1", "r2"] });
  const cmp = compareRows(app.rows, other.rows);
  assert.equal(cmp.estimate, 1);
  assert.equal(checkCompatible(app, other).compatible, true);
  reopened.close();
  store = new Store(dbPath);
});
