import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendTokens, compareSketches, createSketch, mergeSketches, sketchFromJSON, sketchToJSON } from "../src/minhash";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { AppError } from "../src/validate";

const SEED = 20241001, ROWS = 32;

function build(tokens: string[], seed = SEED, rows = ROWS) {
  const s = createSketch(seed, rows);
  appendTokens(s, tokens);
  return s;
}

function exactJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

test("手工核对夹具：固定种子哈希行逐行一致", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/hand-checked.json"), "utf8"));
  const s = build(fx.tokens, fx.seed, fx.rows);
  assert.deepEqual(sketchToJSON(s).values, fx.expectedValues);
});

test("相同集合估计为 1，重排与重复不改变摘要", () => {
  const a = build(["x", "y", "z"]);
  const b = build(["z", "x", "y", "x", "x", "z"]);
  assert.deepEqual(sketchToJSON(a), sketchToJSON(b));
  const r = compareSketches(a, b);
  assert.equal(r.estimate, 1);
  assert.equal(r.numerator, ROWS);
});

test("追加重复项与自合并保持摘要不变（幂等）", () => {
  const a = build(["a", "b", "c"]);
  const before = sketchToJSON(a);
  appendTokens(a, ["a", "b"]);
  assert.deepEqual(sketchToJSON(a), before);
  const selfMerged = mergeSketches(a, a);
  assert.deepEqual(sketchToJSON(selfMerged), before);
});

test("部分重叠与不相交：估计与真实基准分开报告", () => {
  const A = new Set(["a", "b", "c", "d", "e"]);
  const B = new Set(["c", "d", "e", "f", "g"]);
  const r = compareSketches(build([...A]), build([...B]));
  assert.equal(r.numerator + (ROWS - r.numerator), ROWS);
  assert.ok(Math.abs(r.estimate - exactJaccard(A, B)) < 0.5, "允许误差，仅 sanity 检查");
  const dj = compareSketches(build(["a", "b"]), build(["x", "y"]));
  assert.ok(dj.estimate >= 0 && dj.estimate <= 1);
});

test("空集：空对空为 1，空对非空为 0", () => {
  const e1 = createSketch(SEED, ROWS), e2 = createSketch(SEED, ROWS);
  assert.equal(compareSketches(e1, e2).estimate, 1);
  assert.equal(compareSketches(e1, build(["a"])).estimate, 0);
  assert.equal(compareSketches(build(["a"]), e2).estimate, 0);
});

test("兼容性：种子/行数/编码不一致被拒绝并给出原因", () => {
  const a = build(["a"]);
  assert.throws(() => compareSketches(a, build(["a"], SEED + 1)), (e: AppError) => e.code === "INCOMPATIBLE_SEED");
  assert.throws(() => compareSketches(a, build(["a"], SEED, 64)), (e: AppError) => e.code === "INCOMPATIBLE_ROWS");
  const c = build(["a"]); c.encoding = "other-v9";
  assert.throws(() => mergeSketches(a, c), (e: AppError) => e.code === "INCOMPATIBLE_ENCODING");
});

test("大整数序列化：超过 2^53 的值精确保留", () => {
  const s = build(["apple"]); // 夹具证明实际值 > 2^53
  const json = sketchToJSON(s);
  assert.ok(json.values.some((v) => BigInt(v) > 2n ** 53n));
  const back = sketchFromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back.values, s.values);
});

test("导入校验：损坏数据被拒绝", () => {
  const good = sketchToJSON(build(["a"]));
  assert.throws(() => sketchFromJSON({ ...good, rows: 8 }), /16\.\.256/);
  assert.throws(() => sketchFromJSON({ ...good, values: good.values.slice(1) }), /长度/);
  assert.throws(() => sketchFromJSON({ ...good, values: ["-1", ...good.values.slice(1)] }), /十进制/);
  assert.throws(() => sketchFromJSON({ ...good, values: ["18446744073709551616", ...good.values.slice(1)] }), /uint64/);
  assert.throws(() => sketchFromJSON({ ...good, encoding: "md5-v0" }), /编码/);
  const fakeEmpty = { ...good, isEmpty: true };
  assert.throws(() => sketchFromJSON(fakeEmpty), /空集/);
});

test("合并：交换律、结合律、幂等", () => {
  const a = build(["a", "b"]), b = build(["c"]), c = build(["d", "e"]);
  const eq = (x: any, y: any) => assert.deepEqual(sketchToJSON(x).values, sketchToJSON(y).values);
  eq(mergeSketches(a, b), mergeSketches(b, a));
  eq(mergeSketches(mergeSketches(a, b), c), mergeSketches(a, mergeSketches(b, c)));
  eq(mergeSketches(a, a), a);
});

test("先合并集合再构建 == 摘要逐行合并", () => {
  const A = ["alpha", "beta", "gamma"], B = ["gamma", "delta", ""];
  const merged = mergeSketches(build(A), build(B));
  const direct = build([...new Set([...A, ...B])]);
  assert.deepEqual(sketchToJSON(merged).values, sketchToJSON(direct).values);
});

test("空字符串与大小写/空白敏感", () => {
  const a = build(["", "A", "a ", "a"]);
  const b = build(["", "A", "a ", "a"]);
  assert.equal(compareSketches(a, b).estimate, 1);
  const c = build(["a"]); // 不含 "" 等
  assert.ok(compareSketches(a, c).estimate < 1);
});

test("持久化：重启（重开数据库）后追加与比较一致", () => {
  const dbPath = path.join(__dirname, "../../data/test-persist.db");
  fs.rmSync(dbPath, { force: true });
  const s1 = new Service(new Store(dbPath));
  const { meta } = s1.create({ seed: SEED, rows: ROWS, name: "p", tokens: ["a", "b"] });
  s1.store.close();
  const s2 = new Service(new Store(dbPath));
  s2.append(meta.id, { tokens: ["c"] });
  const mem = build(["a", "b", "c"]);
  assert.deepEqual(s2.show(meta.id).sketch.values, sketchToJSON(mem).values);
  s2.store.close();
  fs.rmSync(dbPath, { force: true });
});

test("失败批次原子性：非法 token 导致整批不生效", () => {
  const svc = new Service(new Store(":memory:"));
  const { meta } = svc.create({ seed: SEED, rows: ROWS, name: "t", tokens: ["a"] });
  const before = svc.show(meta.id).sketch;
  const bad = "x".repeat(5000);
  assert.throws(() => svc.append(meta.id, { tokens: ["ok1", bad, "ok2"] }), (e: AppError) => e.code === "TOKEN_TOO_LARGE");
  assert.deepEqual(svc.show(meta.id).sketch, before);
  assert.throws(() => svc.append(meta.id, { tokens: ["\uD800"] }), (e: AppError) => e.code === "INVALID_UNICODE");
  assert.deepEqual(svc.show(meta.id).sketch, before);
});

test("合并生成新版本且不修改来源，历史可查", () => {
  const svc = new Service(new Store(":memory:"));
  const a = svc.create({ seed: SEED, rows: ROWS, name: "a", tokens: ["a"] });
  const b = svc.create({ seed: SEED, rows: ROWS, name: "b", tokens: ["b"] });
  const aBefore = svc.show(a.meta.id).sketch;
  const m = svc.merge(a.meta.id, { otherId: b.meta.id, name: "m" });
  assert.deepEqual(svc.show(a.meta.id).sketch, aBefore, "来源不被修改");
  const direct = build(["a", "b"]);
  assert.deepEqual(m.sketch.values, sketchToJSON(direct).values);
  const hist = svc.store.history();
  assert.ok(hist.some((h) => h.op === "merge"));
});

test("导出导入往返一致，旧快照不受后续追加影响", () => {
  const svc = new Service(new Store(":memory:"));
  const a = svc.create({ seed: SEED, rows: ROWS, name: "a", tokens: ["a", "b"] });
  const snap = svc.exportOne(a.meta.id);
  svc.append(a.meta.id, { tokens: ["c", "d"] });
  const imported = svc.importOne(snap);
  assert.deepEqual(imported.sketch, snap.sketch, "导入的是旧快照");
  assert.notDeepEqual(svc.show(a.meta.id).sketch, snap.sketch);
});

test("参数校验：行数范围与批量上限", () => {
  const svc = new Service(new Store(":memory:"));
  assert.throws(() => svc.create({ seed: 1, rows: 15 }), (e: AppError) => e.code === "INVALID_PARAM");
  assert.throws(() => svc.create({ seed: 1, rows: 257 }), (e: AppError) => e.code === "INVALID_PARAM");
  assert.throws(() => svc.create({ seed: -1, rows: 16 }), (e: AppError) => e.code === "INVALID_PARAM");
  assert.throws(
    () => svc.create({ seed: 1, rows: 16, tokens: new Array(10001).fill("x") }),
    (e: AppError) => e.code === "BATCH_TOO_LARGE"
  );
});
