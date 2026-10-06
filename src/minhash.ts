import { ENCODING, MAX_U64, rowHash } from "./hash";
import { AppError } from "./validate";

export interface SketchData {
  seed: number;
  rows: number;
  encoding: string;
  isEmpty: boolean;
  values: bigint[]; // length === rows; 当 isEmpty 时全部为 MAX_U64，以 isEmpty 标志为准
}

export function createSketch(seed: number, rows: number): SketchData {
  return { seed, rows, encoding: ENCODING, isEmpty: true, values: new Array<bigint>(rows).fill(MAX_U64) };
}

// 原地追加一批 token；重复 token 与空批次天然幂等
export function appendTokens(sketch: SketchData, tokens: string[]): void {
  if (tokens.length === 0) return;
  const encoded = tokens.map((t) => Buffer.from(t, "utf8"));
  for (let r = 0; r < sketch.rows; r++) {
    let min = sketch.values[r];
    for (const buf of encoded) {
      const v = rowHash(sketch.seed, r, buf);
      if (v < min) min = v;
    }
    sketch.values[r] = min;
  }
  sketch.isEmpty = false;
}

export function checkCompatible(a: SketchData, b: SketchData): void {
  if (a.seed !== b.seed) throw new AppError("INCOMPATIBLE_SEED", `种子不一致: ${a.seed} vs ${b.seed}`);
  if (a.rows !== b.rows) throw new AppError("INCOMPATIBLE_ROWS", `行数不一致: ${a.rows} vs ${b.rows}`);
  if (a.encoding !== b.encoding) throw new AppError("INCOMPATIBLE_ENCODING", `编码规则不一致: ${a.encoding} vs ${b.encoding}`);
}

export interface CompareResult {
  numerator: number;
  denominator: number;
  estimate: number;
  equalRows: number[];
}

export function compareSketches(a: SketchData, b: SketchData): CompareResult {
  checkCompatible(a, b);
  if (a.isEmpty && b.isEmpty) return { numerator: 1, denominator: 1, estimate: 1, equalRows: [] };
  if (a.isEmpty || b.isEmpty) return { numerator: 0, denominator: a.rows, estimate: 0, equalRows: [] };
  const equalRows: number[] = [];
  for (let r = 0; r < a.rows; r++) {
    if (a.values[r] === b.values[r]) equalRows.push(r);
  }
  return {
    numerator: equalRows.length,
    denominator: a.rows,
    estimate: equalRows.length / a.rows,
    equalRows,
  };
}

// 逐行取较小值生成新摘要；不修改来源
export function mergeSketches(a: SketchData, b: SketchData): SketchData {
  checkCompatible(a, b);
  if (a.isEmpty) return { ...b, values: [...b.values] };
  if (b.isEmpty) return { ...a, values: [...a.values] };
  const values = new Array<bigint>(a.rows);
  for (let r = 0; r < a.rows; r++) values[r] = a.values[r] < b.values[r] ? a.values[r] : b.values[r];
  return { seed: a.seed, rows: a.rows, encoding: a.encoding, isEmpty: false, values };
}

export function sketchToJSON(s: SketchData) {
  return {
    seed: s.seed,
    rows: s.rows,
    encoding: s.encoding,
    isEmpty: s.isEmpty,
    values: s.values.map((v) => v.toString(10)),
  };
}

export function sketchFromJSON(raw: unknown): SketchData {
  if (typeof raw !== "object" || raw === null) throw new AppError("CORRUPT_IMPORT", "导入数据必须是对象");
  const o = raw as Record<string, unknown>;
  if (typeof o.seed !== "number" || !Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) {
    throw new AppError("CORRUPT_IMPORT", "seed 缺失或越界");
  }
  if (typeof o.rows !== "number" || !Number.isInteger(o.rows) || o.rows < 16 || o.rows > 256) {
    throw new AppError("CORRUPT_IMPORT", "rows 缺失或超出 16..256");
  }
  if (o.encoding !== ENCODING) {
    throw new AppError("CORRUPT_IMPORT", `不支持的编码规则: ${String(o.encoding)}`);
  }
  if (typeof o.isEmpty !== "boolean") throw new AppError("CORRUPT_IMPORT", "isEmpty 必须是布尔值");
  if (!Array.isArray(o.values) || o.values.length !== o.rows) {
    throw new AppError("CORRUPT_IMPORT", `values 必须是长度为 ${o.rows} 的数组`);
  }
  const values = o.values.map((v, i) => {
    if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) {
      throw new AppError("CORRUPT_IMPORT", `values[${i}] 必须是十进制无符号整数字符串`);
    }
    const b = BigInt(v);
    if (b < 0n || b > MAX_U64) throw new AppError("CORRUPT_IMPORT", `values[${i}] 超出 uint64 范围`);
    return b;
  });
  if (o.isEmpty && values.some((v) => v !== MAX_U64)) {
    throw new AppError("CORRUPT_IMPORT", "空集摘要的所有行必须保持未初始化状态");
  }
  if (!o.isEmpty && values.every((v) => v === MAX_U64)) {
    throw new AppError("CORRUPT_IMPORT", "非空摘要不可能所有行都未命中");
  }
  return { seed: o.seed, rows: o.rows, encoding: ENCODING, isEmpty: o.isEmpty, values };
}
