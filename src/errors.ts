export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_UNICODE"
  | "TOKEN_TOO_LONG"
  | "BATCH_TOO_LARGE"
  | "ROWS_OUT_OF_RANGE"
  | "SEED_OUT_OF_RANGE"
  | "SUMMARY_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "INCOMPATIBLE_SUMMARIES"
  | "EMPTY_SET_OPERATION"
  | "IMPORT_INVALID"
  | "EMPTY_BATCH"
  | "TOO_MANY_SOURCES"
  | "TOO_MANY_PAIRS"
  | "INVALID_JSON"
  | "BAD_REQUEST"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
