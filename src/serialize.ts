import type { Row } from "./minhash.js";

/** 大整数序列化为十进制字符串（JSON 不支持 64 位精度）。 */
export function rowsToStrings(rows: Row[], isEmpty: boolean): string[] | null {
  if (isEmpty) return null;
  return rows.map((v) => (v as bigint).toString(10));
}

export function stringsToRows(values: string[] | null, numRows: number): Row[] {
  if (values === null) return new Array<Row>(numRows);
  if (!Array.isArray(values) || values.length !== numRows) {
    const got = Array.isArray(values) ? values.length : typeof values;
    throw new Error(`行值数量 ${String(got)} 与行数 ${numRows} 不一致`);
  }
  return values.map((v, i) => {
    if (typeof v !== "string" || !/^\d+$/.test(v)) {
      throw new Error(`第 ${i} 行不是十进制无符号整数字符串`);
    }
    let bi: bigint;
    try {
      bi = BigInt(v);
    } catch {
      throw new Error(`第 ${i} 行不是合法整数`);
    }
    if (bi < 0n || bi > (1n << 64n) - 1n) {
      throw new Error(`第 ${i} 行超出 [0, 2^64-1]`);
    }
    return bi;
  });
}

export function bigintJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value;
}
