import { AppError } from "./errors.js";
import { ENCODING_RULE, LIMITS } from "./limits.js";
import { isEmptyRows, type Row } from "./minhash.js";
import { stringsToRows, rowsToStrings } from "./serialize.js";
import type { Store, SummaryRecord } from "./store.js";

export interface ExportBundle {
  format: "minhash-summary/v1";
  exportedAt: string;
  summaries: Array<{
    id: string;
    seed: number;
    numRows: number;
    encodingRule: string;
    version: number;
    isEmpty: boolean;
    rows: string[] | null;
    note: string | null;
    createdAt: string;
  }>;
}

export function exportSummaries(store: Store, ids: string[], versionBy?: Map<string, number>): ExportBundle {
  if (ids.length === 0) throw new AppError("VALIDATION_ERROR", "导出至少需要一个 id");
  if (ids.length > LIMITS.MAX_EXPORT_IDS) {
    throw new AppError("BATCH_TOO_LARGE", `导出数量超过上限 ${LIMITS.MAX_EXPORT_IDS}`);
  }
  const records = ids.map((id) => store.getSummaryOrThrow(id, versionBy?.get(id)));
  return {
    format: "minhash-summary/v1",
    exportedAt: new Date().toISOString(),
    summaries: records.map((r) => ({
      id: r.summaryId,
      seed: r.seed,
      numRows: r.numRows,
      encodingRule: r.encodingRule,
      version: r.version,
      isEmpty: r.isEmpty,
      rows: rowsToStrings(r.rows, r.isEmpty),
      note: r.note,
      createdAt: r.createdAt
    }))
  };
}

/** 导入快照：重新生成 id（避免覆盖），严格校验维度/范围/空集表示。旧快照是不可变副本。 */
export function importBundle(
  store: Store,
  bundle: unknown,
  keepIds = false
): { imported: SummaryRecord[] } {
  if (typeof bundle !== "object" || bundle === null) {
    throw new AppError("IMPORT_INVALID", "导入内容必须是对象");
  }
  const b = bundle as Partial<ExportBundle>;
  if (b.format !== "minhash-summary/v1") {
    throw new AppError("IMPORT_INVALID", `不支持的导出格式：${String(b.format)}`);
  }
  if (!Array.isArray(b.summaries) || b.summaries.length === 0) {
    throw new AppError("IMPORT_INVALID", "summaries 必须是非空数组");
  }
  if (b.summaries.length > LIMITS.MAX_EXPORT_IDS) {
    throw new AppError("BATCH_TOO_LARGE", `导入数量超过上限 ${LIMITS.MAX_EXPORT_IDS}`);
  }
  const imported: SummaryRecord[] = [];
  for (const [idx, s] of b.summaries.entries()) {
    const at = `summaries[${idx}]`;
    try {
      if (typeof s !== "object" || s === null) throw new Error("条目不是对象");
      if (
        typeof s.seed !== "number" ||
        !Number.isInteger(s.seed) ||
        s.seed < 0 ||
        s.seed > LIMITS.MAX_SEED
      ) {
        throw new Error("seed 超出 [0, 4294967295]");
      }
      if (
        typeof s.numRows !== "number" ||
        !Number.isInteger(s.numRows) ||
        s.numRows < LIMITS.MIN_ROWS ||
        s.numRows > LIMITS.MAX_ROWS
      ) {
        throw new Error(`numRows 超出 [${LIMITS.MIN_ROWS}, ${LIMITS.MAX_ROWS}]`);
      }
      if (s.encodingRule !== ENCODING_RULE) {
        throw new Error(`encodingRule 不匹配：${String(s.encodingRule)}`);
      }
      if (typeof s.isEmpty !== "boolean") throw new Error("isEmpty 必须为布尔值");
      let rows: Row[];
      if (s.isEmpty) {
        if (s.rows !== null) throw new Error("空集摘要 rows 必须为 null（不得用最大整数填充）");
        rows = new Array<Row>(s.numRows);
      } else {
        if (s.rows === null) throw new Error("非空摘要 rows 不能为 null");
        rows = stringsToRows(s.rows, s.numRows);
        if (isEmptyRows(rows)) throw new Error("非空摘要不能所有行都缺失");
      }
      const id =
        keepIds && typeof s.id === "string" && s.id.length > 0 ? s.id : undefined;
      const rec = store.createSummary({
        seed: s.seed,
        numRows: s.numRows,
        tokens: [],
        importedRows: rows,
        kind: "import",
        note: typeof s.note === "string" ? s.note : null,
        id
      });
      imported.push(rec);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("IMPORT_INVALID", `${at}：${(err as Error).message}`);
    }
  }
  return { imported };
}
