export const LIMITS = {
  MIN_ROWS: 16,
  MAX_ROWS: 256,
  MAX_TOKEN_BYTES: 4096,
  MAX_BATCH_TOKENS: 10000,
  MAX_SEED: 0xffffffff,
} as const;

export type ErrorCode =
  | "INVALID_PARAM"
  | "INVALID_UNICODE"
  | "TOKEN_TOO_LARGE"
  | "BATCH_TOO_LARGE"
  | "NOT_FOUND"
  | "INCOMPATIBLE_SEED"
  | "INCOMPATIBLE_ROWS"
  | "INCOMPATIBLE_ENCODING"
  | "CORRUPT_IMPORT"
  | "INTERNAL";

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400) {
    super(message);
  }
}

export function validateSeed(seed: unknown): number {
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > LIMITS.MAX_SEED) {
    throw new AppError("INVALID_PARAM", `seed 必须是 0..${LIMITS.MAX_SEED} 的整数`);
  }
  return seed;
}

export function validateRows(rows: unknown): number {
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows < LIMITS.MIN_ROWS || rows > LIMITS.MAX_ROWS) {
    throw new AppError("INVALID_PARAM", `rows 必须是 ${LIMITS.MIN_ROWS}..${LIMITS.MAX_ROWS} 的整数`);
  }
  return rows;
}

export function validateToken(token: unknown, index: number): string {
  if (typeof token !== "string") {
    throw new AppError("INVALID_PARAM", `token[${index}] 必须是字符串`);
  }
  if (!token.isWellFormed()) {
    throw new AppError("INVALID_UNICODE", `token[${index}] 含不合法 Unicode（孤立代理项）`);
  }
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes > LIMITS.MAX_TOKEN_BYTES) {
    throw new AppError("TOKEN_TOO_LARGE", `token[${index}] 为 ${bytes} 字节，超过上限 ${LIMITS.MAX_TOKEN_BYTES}`);
  }
  return token;
}

export function validateTokenBatch(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) {
    throw new AppError("INVALID_PARAM", "tokens 必须是字符串数组");
  }
  if (tokens.length > LIMITS.MAX_BATCH_TOKENS) {
    throw new AppError("BATCH_TOO_LARGE", `单批最多 ${LIMITS.MAX_BATCH_TOKENS} 个 token，收到 ${tokens.length}`);
  }
  return tokens.map((t, i) => validateToken(t, i));
}
