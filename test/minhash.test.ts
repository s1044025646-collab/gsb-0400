import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCompatible,
  compareRows,
  emptyRows,
  isEmptyRows,
  mergeRows,
  rowHash,
  updateRows,
  validateToken
} from "../src/minhash.js";
import { ENCODING_RULE } from "../src/limits.js";
import { AppError } from "../src/errors.js";

test("手工哈希夹具：seed=1,row=0,token='abc'", () => {
  const h = rowHash(1, 16, 0, "abc");
  assert.equal(h, 0xd5595684c52382b5n);
  assert.equal(h.toString(), "15373413931249009333");
});

test("行号与种子不同则哈希不同", () => {
  assert.notEqual(rowHash(1, 16, 0, "x"), rowHash(1, 16, 1, "x"));
  assert.notEqual(rowHash(1, 16, 0, "x"), rowHash(2, 16, 0, "x"));
});

test("相同集合估计为 1；重排与重复不改变摘要", () => {
  const r1 = emptyRows(64);
  updateRows(7, 64, r1, ["a", "b", "c", ""]);
  const r2 = emptyRows(64);
  updateRows(7, 64, r2, ["", "c", "b", "a", "a", "c"]);
  assert.deepEqual(r1, r2);
  const cmp = compareRows(r1, r2);
  assert.equal(cmp.estimate, 1);
  assert.equal(cmp.matchCount, 64);
});

test("空集语义：空-空=1，空-非空=0", () => {
  const e = emptyRows(32);
  assert.ok(isEmptyRows(e));
  const e2 = emptyRows(32);
  const ne = emptyRows(32);
  updateRows(0, 32, ne, ["x"]);
  assert.equal(compareRows(e, e2).estimate, 1);
  assert.equal(compareRows(e, ne).estimate, 0);
  assert.equal(compareRows(ne, e).estimate, 0);
  assert.deepEqual(compareRows(e, e2).matchedRows, Array.from({ length: 32 }, (_, i) => i));
});

test("不相交集合估计是有限观测（允许误差，不要求必为 0）", () => {
  const a = emptyRows(256);
  updateRows(99, 256, a, ["u", "v"]);
  const b = emptyRows(256);
  updateRows(99, 256, b, ["p", "q"]);
  const cmp = compareRows(a, b);
  assert.ok(cmp.estimate !== null && cmp.estimate >= 0 && cmp.estimate <= 1);
  assert.equal(cmp.matchCount, cmp.matchedRows.length);
});

test("合并满足交换/结合/幂等，且等价于先并集再构建", () => {
  const mk = (tokens: string[]) => {
    const r = emptyRows(64);
    updateRows(5, 64, r, tokens);
    return r;
  };
  const a = mk(["a", "b", "c"]);
  const b = mk(["b", "c", "d"]);
  const c = mk(["c", "d", "e", "f"]);
  assert.deepEqual(mergeRows(a, b), mergeRows(b, a));
  assert.deepEqual(mergeRows(mergeRows(a, b), c), mergeRows(a, mergeRows(b, c)));
  assert.deepEqual(mergeRows(a, a), a);
  const direct = mk(["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(mergeRows(a, mergeRows(b, c)), direct);
  const copyA = a.map((v) => v);
  mergeRows(a, b);
  assert.deepEqual(a, copyA, "合并不修改来源");
});

test("兼容检查返回具体原因", () => {
  const base = { seed: 1, numRows: 64, encodingRule: ENCODING_RULE };
  assert.equal(checkCompatible(base, { ...base, seed: 2 }).reason, "SEED_MISMATCH");
  assert.equal(checkCompatible(base, { ...base, numRows: 32 }).reason, "ROWS_MISMATCH");
  assert.equal(
    checkCompatible(base, { ...base, encodingRule: "other" }).reason,
    "ENCODING_MISMATCH"
  );
  assert.equal(checkCompatible(base, base).compatible, true);
});

test("token 严格校验：空串合法，lone surrogate/超长被拒", () => {
  assert.equal(validateToken(""), "");
  assert.equal(validateToken("  x  "), "  x  ");
  assert.throws(() => validateToken("\ud800"), (e: Error) => e instanceof AppError && e.code === "INVALID_UNICODE");
  assert.throws(() => validateToken("a\udc00b"), (e: Error) => e instanceof AppError && e.code === "INVALID_UNICODE");
  assert.throws(
    () => validateToken("x".repeat(4097)),
    (e: Error) => e instanceof AppError && e.code === "TOKEN_TOO_LONG"
  );
});

test("64 位精度：高位值不丢失低位", () => {
  const big = "18446744073709551615";
  const r = emptyRows(16);
  r[0] = BigInt(big);
  assert.equal(r[0].toString(), big);
});
