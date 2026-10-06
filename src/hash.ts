import { createHash } from "node:crypto";

export const ENCODING = "sha256-be-v1";
export const MAX_U64 = (1n << 64n) - 1n;

// seed(4B BE) || rowIndex(4B BE) || token utf8 bytes -> sha256 -> first 8 bytes as u64 BE
export function rowHash(seed: number, rowIndex: number, tokenUtf8: Buffer): bigint {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(seed >>> 0, 0);
  head.writeUInt32BE(rowIndex >>> 0, 4);
  const digest = createHash("sha256").update(head).update(tokenUtf8).digest();
  return digest.readBigUInt64BE(0);
}
