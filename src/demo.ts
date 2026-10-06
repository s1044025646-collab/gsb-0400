import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { compareRows, rowHash, updateRows, emptyRows } from "./minhash.js";
import { bigintJsonReplacer } from "./serialize.js";

/** 独立精确基准：直接用 Set 计算真实 Jaccard（与摘要完全分离）。 */
function exactJaccard(a: string[], b: string[]): { jaccard: number; intersection: number; union: number } {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return { jaccard: union === 0 ? 1 : inter / union, intersection: inter, union };
}

function build(seed: number, rows: number, tokens: string[]) {
  const r = emptyRows(rows);
  updateRows(seed, rows, r, tokens);
  return r;
}

function line(label: string, value: unknown): void {
  console.log(`- ${label}: ${typeof value === "object" ? JSON.stringify(value, bigintJsonReplacer) : String(value)}`);
}

function main(): void {
  const dir = join(tmpdir(), `minhash-demo-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "demo.db"));
  const SEED = 0x12345678;
  const ROWS = 64;

  console.log("== 1. 相同集合：估计为 1 ==");
  const base = ["alpha", "beta", "gamma", "", "带空格 token "];
  const s1 = store.createSummary({ seed: SEED, numRows: ROWS, tokens: base });
  const s1b = store.createSummary({ seed: SEED, numRows: ROWS, tokens: ["gamma", "", "beta", "alpha", "带空格 token "] });
  const same = compareRows(s1.rows, s1b.rows);
  line("重排后 matchCount/rows", `${same.matchCount}/${same.totalRows}`);
  line("估计值", same.estimate);

  console.log("\n== 2. 重复 token 不改变摘要（幂等） ==");
  const before = JSON.stringify(s1.rows, bigintJsonReplacer);
  const s1app = store.appendTokens(s1.summaryId, ["alpha", "alpha", "beta", ""]);
  const after = JSON.stringify(s1app.rows, bigintJsonReplacer);
  line("追加重复项后摘要不变", before === after);

  console.log("\n== 3. 部分重叠：估计 vs 精确 Jaccard（独立基准） ==");
  const setA = ["a", "b", "c", "d", "e"];
  const setB = ["c", "d", "e", "f", "g"];
  const sa = store.createSummary({ seed: SEED, numRows: ROWS, tokens: setA });
  const sb = store.createSummary({ seed: SEED, numRows: ROWS, tokens: setB });
  const cmp = compareRows(sa.rows, sb.rows);
  const exact = exactJaccard(setA, setB);
  line("匹配行数", `${cmp.matchCount}/${cmp.totalRows}`);
  line("MinHash 估计", cmp.estimate);
  line("精确 Jaccard（基准）", exact.jaccard);
  line("相等行位置（前10）", cmp.matchedRows.slice(0, 10));

  console.log("\n== 4. 不相交短集合：估计通常为 0，但有限哈希族不保证每次为 0 ==");
  const sx = store.createSummary({ seed: SEED, numRows: ROWS, tokens: ["x1", "x2"] });
  const sy = store.createSummary({ seed: SEED, numRows: ROWS, tokens: ["y1", "y2"] });
  const cmpDisjoint = compareRows(sx.rows, sy.rows);
  line("MinHash 估计", cmpDisjoint.estimate);
  line("精确 Jaccard（基准）", 0);

  console.log("\n== 5. 空集：空-空 = 1，空-非空 = 0 ==");
  const empty1 = store.createSummary({ seed: SEED, numRows: ROWS, tokens: [] });
  const empty2 = store.createSummary({ seed: SEED, numRows: ROWS, tokens: [] });
  line("空-空", compareRows(empty1.rows, empty2.rows).estimate);
  line("空-非空", compareRows(empty1.rows, sa.rows).estimate);

  console.log("\n== 6. 合并（逐行最小值）不修改来源 ==");
  const mergedStore = store.mergeSummaries([sa.summaryId, sb.summaryId]);
  const direct = build(SEED, ROWS, [...new Set([...setA, ...setB])]);
  line("与直接构建并集摘要逐行一致", JSON.stringify(direct, bigintJsonReplacer) === JSON.stringify(mergedStore.rows, bigintJsonReplacer));
  const saAgain = store.getSummaryOrThrow(sa.summaryId);
  line("来源摘要版本未被修改", saAgain.version === sa.version);

  console.log("\n== 7. 手工核对的哈希夹具（seed=1, row=0, token='abc'） ==");
  line("h(1,0,'abc') =", rowHash(1, 16, 0, "abc").toString(16).padStart(16, "0"));

  console.log("\n演示完成。");
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

main();
