export const LIMITS = {
  MIN_ROWS: 16,
  MAX_ROWS: 256,
  MIN_SEED: 0,
  MAX_SEED: 0xffffffff,
  MAX_TOKEN_BYTES: 4096,
  MAX_TOKENS_PER_BATCH: 100_000,
  MAX_COMPARE_PAIRS: 512,
  MAX_EXPORT_IDS: 2048,
  MAX_MERGE_SOURCES: 256,
  MAX_HISTORY_LIMIT: 1000,
  MAX_IDS_PER_VIEW: 1024
} as const;

export const ENCODING_RULE = "sha256-be:seed32-row32:utf8/v1" as const;
export const U64_MAX = (1n << 64n) - 1n;
export const U64_EMPTY = null;
