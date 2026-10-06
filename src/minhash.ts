import { createHash } from "node:crypto";
import { ENCODING_RULE, LIMITS, U64_MAX } from "./limits.js";
import { AppError } from "./errors.js";

export type Row = bigint | undefined;

export function validateSeed(seed: unknown): number {
  if (typeof seed !== "number" || !Number.isInteger(seed)) {
    throw new AppError("VALIDATION_ERROR", "seed 必须为 32 位无符号整数", 400, { seed });
  }
  if (seed < LIMITS.MIN_SEED || seed > LIMITS.MAX_SEED) {
    throw new AppError("SEED_OUT_OF_RANGE", `seed 必须位于 [0, 4294967295]，收到 ${seed}`);
  }
  return seed;
}

export function validateRows(rows: unknown): number {
  if (typeof rows !== "number" || !Number.isInteger(rows)) {
    throw new AppError("VALIDATION_ERROR", "numRows 必须为整数", 400, { rows });
  }
  if (rows < LIMITS.MIN_ROWS || rows > LIMITS.MAX_ROWS) {
    throw new AppError(
      "ROWS_OUT_OF_RANGE",
      `行数必须位于 [${LIMITS.MIN_ROWS}, ${LIMITS.MAX_ROWS}]，收到 ${rows}`
    );
  }
  return rows;
}

/**
 * 严格校验 token：必须为字符串，不允许 lone surrogate，
 * 不做 trim / Unicode 归一；空串合法；区分大小写与空白。
 */
export function validateToken(token: unknown): string {
  if (typeof token !== "string") {
    throw new AppError("VALIDATION_ERROR", "每个 token 必须为字符串", 400, { token: String(token) });
  }
  if (!isWellFormedUtf8(token)) {
    throw new AppError("INVALID_UNICODE", "token 含不合法 Unicode（孤立代理项）", 400);
  }
  const byteLen = Buffer.byteLength(token, "utf8");
  if (byteLen > LIMITS.MAX_TOKEN_BYTES) {
    throw new AppError(
      "TOKEN_TOO_LONG",
      `token UTF-8 字节数 ${byteLen} 超过上限 ${LIMITS.MAX_TOKEN_BYTES}`
    );
  }
  return token;
}

export function isWellFormedUtf8(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * 第 rowIndex 行对单个 token 的确定哈希：
 * seed(4B 大端) || rowIndex(4B 大端) || token 的 UTF-8 字节，
 * 计算 SHA-256，取前 8 字节作为无符号 64 位大端整数。
 */
export function rowHash(seed: number, numRows: number, rowIndex: number, token: string): bigint {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(seed >>> 0, 0);
  prefix.writeUInt32BE(rowIndex >>> 0, 4);
  const body = Buffer.concat([prefix, Buffer.from(token, "utf8")]);
  const digest = createHash("sha256").update(body).digest();
  return digest.readBigUInt64BE(0);
}

/** 用一批 token 更新摘要行（逐行取最小值），原地修改 rows。 */
export function updateRows(seed: number, numRows: number, rows: Row[], tokens: string[]): void {
  for (const token of tokens) {
    for (let r = 0; r < numRows; r++) {
      const h = rowHash(seed, numRows, r, token);
      const cur = rows[r];
      if (cur === undefined || h < cur) rows[r] = h;
    }
  }
}

export function emptyRows(numRows: number): Row[] {
  return new Array<Row>(numRows);
}

export function isEmptyRows(rows: Row[]): boolean {
  return rows.every((v) => v === undefined);
}

/** 逐行取较小值，生成并集摘要；不修改输入。 */
export function mergeRows(a: Row[], b: Row[]): Row[] {
  const out = new Array<Row>(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) out[i] = y;
    else if (y === undefined) out[i] = x;
    else out[i] = x < y ? x : y;
  }
  return out;
}

export interface Compatibility {
  compatible: boolean;
  reason?: "SEED_MISMATCH" | "ROWS_MISMATCH" | "ENCODING_MISMATCH";
}

export interface SummaryMeta {
  seed: number;
  numRows: number;
  encodingRule: string;
}

export function checkCompatible(a: SummaryMeta, b: SummaryMeta): Compatibility {
  if (a.seed !== b.seed) {
    return { compatible: false, reason: "SEED_MISMATCH" };
  }
  if (a.numRows !== b.numRows) {
    return { compatible: false, reason: "ROWS_MISMATCH" };
  }
  if (a.encodingRule !== b.encodingRule || a.encodingRule !== ENCODING_RULE) {
    return { compatible: false, reason: "ENCODING_MISMATCH" };
  }
  return { compatible: true };
}

export interface CompareResult {
  matchCount: number;
  totalRows: number;
  estimate: number | null;
  matchedRows: number[];
  leftEmpty: boolean;
  rightEmpty: boolean;
}

/**
 * 比较两个摘要。
 * 空-空 => 1；空-非空 => 0；非空 => 相同行数 / 总行数。
 */
export function compareRows(a: Row[], b: Row[]): CompareResult {
  const leftEmpty = isEmptyRows(a);
  const rightEmpty = isEmptyRows(b);
  const totalRows = a.length;
  if (leftEmpty && rightEmpty) {
    return { matchCount: totalRows, totalRows, estimate: 1, matchedRows: allIndices(totalRows), leftEmpty, rightEmpty };
  }
  if (leftEmpty || rightEmpty) {
    return { matchCount: 0, totalRows, estimate: 0, matchedRows: [], leftEmpty, rightEmpty };
  }
  const matchedRows: number[] = [];
  for (let i = 0; i < totalRows; i++) {
    if (a[i] === b[i]) matchedRows.push(i);
  }
  return {
    matchCount: matchedRows.length,
    totalRows,
    estimate: matchedRows.length / totalRows,
    matchedRows,
    leftEmpty,
    rightEmpty
  };
}

function allIndices(n: number): number[] {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/** 校验一个 64 位无符号整数值（导入场景）。 */
export function validateU64(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new AppError("IMPORT_INVALID", `行值必须为 [0, 2^64-1] 的无符号 64 位整数`, 400);
  }
  return value;
}
