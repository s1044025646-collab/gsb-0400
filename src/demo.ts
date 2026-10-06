// 演示脚本：相同集合、重排/重复、部分重叠、不相交；真实 Jaccard 仅作基准对照
import { appendTokens, compareSketches, createSketch, mergeSketches } from "./minhash";

function exactJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function build(seed: number, rows: number, tokens: string[]) {
  const s = createSketch(seed, rows);
  appendTokens(s, tokens);
  return s;
}

function show(label: string, a: Set<string>, b: Set<string>, seed: number, rows: number) {
  const sa = build(seed, rows, [...a]);
  const sb = build(seed, rows, [...b]);
  const r = compareSketches(sa, sb);
  console.log(`\n== ${label} ==`);
  console.log(`估计: ${r.numerator}/${r.denominator} = ${r.estimate.toFixed(4)}  真实Jaccard(基准): ${exactJaccard(a, b).toFixed(4)}`);
  console.log(`相等行: [${r.equalRows.join(", ")}]`);
}

const seed = 20241001, rows = 64;

// 1. 相同集合
const s1 = new Set(["alpha", "beta", "gamma", "delta", "epsilon"]);
show("相同集合", s1, new Set(s1), seed, rows);

// 2. 重排与重复输入 -> 摘要逐行一致
const base = ["alpha", "beta", "gamma", "delta", "epsilon"];
const shuffled = build(seed, rows, ["epsilon", "gamma", "alpha", "delta", "beta", "alpha", "alpha", "beta"]);
const original = build(seed, rows, base);
const same = original.values.every((v, i) => v === shuffled.values[i]);
console.log(`\n== 重排+重复输入 ==\n摘要逐行一致: ${same}`);

// 3. 部分重叠
show("部分重叠", new Set(["a", "b", "c", "d", "e"]), new Set(["c", "d", "e", "f", "g"]), seed, rows);

// 4. 不相交（估计不保证为零）
show("不相交", new Set(["a", "b", "c"]), new Set(["x", "y", "z"]), seed, rows);

// 5. 空集
const e1 = createSketch(seed, rows), e2 = createSketch(seed, rows);
console.log(`\n== 空集 ==\n空 vs 空: ${compareSketches(e1, e2).estimate}  空 vs 非空: ${compareSketches(e1, original).estimate}`);

// 6. 合并 = 先并集再构建
const unionSet = new Set([..."abcde".split(""), ..."cdefg".split("")]);
const merged = mergeSketches(build(seed, rows, [..."abcde"]), build(seed, rows, [..."cdefg"]));
const direct = build(seed, rows, [...unionSet]);
console.log(`\n== 合并一致性 ==\n摘要合并 == 并集直接构建: ${merged.values.every((v, i) => v === direct.values[i])}`);
