import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { ENCODING_RULE, LIMITS } from "./limits.js";
import {
  checkCompatible,
  emptyRows,
  isEmptyRows,
  mergeRows,
  type Row,
  type SummaryMeta,
  updateRows,
  validateToken
} from "./minhash.js";

export interface VersionRecord {
  summaryId: string;
  version: number;
  parentVersion: number | null;
  kind: "initial" | "append" | "merge" | "import";
  parents: string[];
  seed: number;
  numRows: number;
  encodingRule: string;
  isEmpty: boolean;
  rows: Row[];
  note: string | null;
  createdAt: string;
}

export interface SummaryRecord extends VersionRecord {
  batchCount: number;
}

export interface HistoryEntry {
  version: number;
  parentVersion: number | null;
  kind: string;
  parents: string[];
  isEmpty: boolean;
  note: string | null;
  createdAt: string;
}

function encodeRows(rows: Row[]): Buffer | null {
  if (isEmptyRows(rows)) return null;
  const buf = Buffer.alloc(rows.length * 8);
  rows.forEach((v, i) => buf.writeBigUInt64BE(v as bigint, i * 8));
  return buf;
}

function decodeRows(blob: Buffer | Uint8Array | null, numRows: number): Row[] {
  if (!blob) return emptyRows(numRows);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length !== numRows * 8) {
    throw new AppError(
      "IMPORT_INVALID",
      `行值字节长度 ${buf.length} 与行数 ${numRows} 不匹配（应为 ${numRows * 8}）`
    );
  }
  const rows = emptyRows(numRows);
  for (let i = 0; i < numRows; i++) rows[i] = buf.readBigUInt64BE(i * 8);
  return rows;
}

interface SummaryRow {
  id: string;
  seed: number;
  num_rows: number;
  encoding_rule: string;
  current_version: number;
  created_at: string;
}

interface VersionRow {
  version: number;
  parent_version: number | null;
  kind: string;
  parents: string;
  is_empty: number;
  rows: Buffer | null;
  note: string | null;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        seed INTEGER NOT NULL,
        num_rows INTEGER NOT NULL,
        encoding_rule TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        summary_id TEXT NOT NULL REFERENCES summaries(id),
        version INTEGER NOT NULL,
        parent_version INTEGER,
        kind TEXT NOT NULL,
        parents TEXT NOT NULL DEFAULT '[]',
        is_empty INTEGER NOT NULL,
        rows BLOB,
        note TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (summary_id, version)
      );
    `);
  }

  private static validateBatch(tokens: string[]): string[] {
    if (tokens.length > LIMITS.MAX_TOKENS_PER_BATCH) {
      throw new AppError("BATCH_TOO_LARGE", `单批 token 数量超过上限 ${LIMITS.MAX_TOKENS_PER_BATCH}`);
    }
    tokens.forEach((t) => validateToken(t));
    return tokens;
  }

  private static validateAppend(tokens: string[]): string[] {
    if (tokens.length === 0) {
      throw new AppError("EMPTY_BATCH", "追加批次不能为空（至少一个 token）");
    }
    return Store.validateBatch(tokens);
  }

  close(): void {
    this.db.close();
  }

  createSummary(opts: {
    seed: number;
    numRows: number;
    tokens: string[];
    note?: string | null;
    id?: string;
    importedRows?: Row[] | null;
    kind?: "initial" | "import";
  }): SummaryRecord {
    const id = opts.id ?? randomUUID();
    const isImport = opts.importedRows !== undefined && opts.importedRows !== null;
    if (!isImport) Store.validateBatch(opts.tokens);
    const rows =
      opts.importedRows !== undefined && opts.importedRows !== null
        ? opts.importedRows
        : (() => {
            const r = emptyRows(opts.numRows);
            updateRows(opts.seed, opts.numRows, r, opts.tokens);
            return r;
          })();
    const now = new Date().toISOString();
    const kind = opts.kind ?? "initial";
    const tx = this.db.prepare(`
      INSERT INTO summaries (id, seed, num_rows, encoding_rule, current_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    const tv = this.db.prepare(`
      INSERT INTO versions (summary_id, version, parent_version, kind, parents, is_empty, rows, note, created_at)
      VALUES (?, 1, NULL, ?, '[]', ?, ?, ?, ?)
    `);
    const save = this.db.prepare("SAVEPOINT create_summary");
    const release = this.db.prepare("RELEASE create_summary");
    const rollback = this.db.prepare("ROLLBACK TO create_summary");
    save.run();
    try {
      tx.run(id, opts.seed, opts.numRows, ENCODING_RULE, now, now);
      tv.run(
        id,
        kind,
        isEmptyRows(rows) ? 1 : 0,
        encodeRows(rows),
        opts.note ?? null,
        now
      );
      release.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
    return this.getSummaryOrThrow(id);
  }

  appendTokens(id: string, tokens: string[], note?: string | null): SummaryRecord {
    const current = this.getSummaryOrThrow(id);
    Store.validateAppend(tokens);
    const nextRows = current.rows.map((v) => v) as Row[];
    updateRows(current.seed, current.numRows, nextRows, tokens);
    const nextVersion = current.version + 1;
    const now = new Date().toISOString();
    const save = this.db.prepare("SAVEPOINT append_tokens");
    const release = this.db.prepare("RELEASE append_tokens");
    const rollback = this.db.prepare("ROLLBACK TO append_tokens");
    save.run();
    try {
      this.db
        .prepare(
          `INSERT INTO versions (summary_id, version, parent_version, kind, parents, is_empty, rows, note, created_at)
           VALUES (?, ?, ?, 'append', '[]', ?, ?, ?, ?)`
        )
        .run(
          id,
          nextVersion,
          current.version,
          isEmptyRows(nextRows) ? 1 : 0,
          encodeRows(nextRows),
          note ?? null,
          now
        );
      this.db
        .prepare("UPDATE summaries SET current_version = ?, updated_at = ? WHERE id = ?")
        .run(nextVersion, now, id);
      release.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
    return this.getSummaryOrThrow(id);
  }

  /** 逐行取最小值合并兼容摘要，生成新摘要（来源不变）。 */
  mergeSummaries(sourceIds: string[], note?: string | null): SummaryRecord {
    if (sourceIds.length < 2) {
      throw new AppError("VALIDATION_ERROR", "合并至少需要两个来源摘要");
    }
    if (sourceIds.length > LIMITS.MAX_MERGE_SOURCES) {
      throw new AppError("TOO_MANY_SOURCES", `合并来源数超过上限 ${LIMITS.MAX_MERGE_SOURCES}`);
    }
    const sources = sourceIds.map((sid) => this.getSummaryOrThrow(sid));
    const base: SummaryMeta = sources[0]!;
    for (const s of sources.slice(1)) {
      const c = checkCompatible(base, s);
      if (!c.compatible) {
        throw new AppError(
          "INCOMPATIBLE_SUMMARIES",
          `摘要不兼容：${describeReason(c.reason)}（${base.seed}/${base.numRows} vs ${s.seed}/${s.numRows}）`,
          422,
          { reason: c.reason, left: base, right: s }
        );
      }
    }
    let merged = sources[0]!.rows;
    for (const s of sources.slice(1)) merged = mergeRows(merged, s.rows);
    const id = randomUUID();
    const now = new Date().toISOString();
    const save = this.db.prepare("SAVEPOINT merge");
    const release = this.db.prepare("RELEASE merge");
    const rollback = this.db.prepare("ROLLBACK TO merge");
    save.run();
    try {
      this.db
        .prepare(
          `INSERT INTO summaries (id, seed, num_rows, encoding_rule, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`
        )
        .run(id, base.seed, base.numRows, ENCODING_RULE, now, now);
      this.db
        .prepare(
          `INSERT INTO versions (summary_id, version, parent_version, kind, parents, is_empty, rows, note, created_at)
           VALUES (?, 1, NULL, 'merge', ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          JSON.stringify(sourceIds),
          isEmptyRows(merged) ? 1 : 0,
          encodeRows(merged),
          note ?? null,
          now
        );
      release.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
    return this.getSummaryOrThrow(id);
  }

  private getSummaryRow(id: string): SummaryRow | undefined {
    return this.db.prepare("SELECT * FROM summaries WHERE id = ?").get(id) as
      | SummaryRow
      | undefined;
  }

  private getVersionRow(id: string, version: number): VersionRow | undefined {
    return this.db
      .prepare("SELECT * FROM versions WHERE summary_id = ? AND version = ?")
      .get(id, version) as VersionRow | undefined;
  }

  getSummaryOrThrow(id: string, version?: number): SummaryRecord {
    const s = this.getSummaryRow(id);
    if (!s) throw new AppError("SUMMARY_NOT_FOUND", `摘要不存在：${id}`, 404);
    const v = version ?? s.current_version;
    const vr = this.getVersionRow(id, v);
    if (!vr) throw new AppError("VERSION_NOT_FOUND", `版本不存在：${id}@v${v}`, 404);
    const batchCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM versions WHERE summary_id = ?")
        .get(id) as { c: number }
    ).c;
    return {
      summaryId: s.id,
      version: v,
      parentVersion: vr.parent_version,
      kind: vr.kind as VersionRecord["kind"],
      parents: JSON.parse(vr.parents) as string[],
      seed: s.seed,
      numRows: s.num_rows,
      encodingRule: s.encoding_rule,
      isEmpty: vr.is_empty === 1,
      rows: decodeRows(vr.rows, s.num_rows),
      note: vr.note,
      createdAt: vr.created_at,
      batchCount
    } as SummaryRecord;
  }

  listSummaries(limit: number, offset: number): { summaries: Array<SummaryRow & { isEmpty: boolean }>; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM summaries").get() as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT s.*, v.is_empty FROM summaries s
         JOIN versions v ON v.summary_id = s.id AND v.version = s.current_version
         ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as unknown as Array<SummaryRow & { is_empty: number }>;
    return {
      total,
      summaries: rows.map((r) => ({ ...r, isEmpty: r.is_empty === 1 }))
    };
  }

  history(id: string, limit: number): HistoryEntry[] {
    if (!this.getSummaryRow(id)) throw new AppError("SUMMARY_NOT_FOUND", `摘要不存在：${id}`, 404);
    const rows = this.db
      .prepare(
        `SELECT version, parent_version, kind, parents, is_empty, note, created_at
         FROM versions WHERE summary_id = ? ORDER BY version DESC LIMIT ?`
      )
      .all(id, limit) as Array<{
      version: number;
      parent_version: number | null;
      kind: string;
      parents: string;
      is_empty: number;
      note: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      version: r.version,
      parentVersion: r.parent_version,
      kind: r.kind,
      parents: JSON.parse(r.parents),
      isEmpty: r.is_empty === 1,
      note: r.note,
      createdAt: r.created_at
    }));
  }
}

export function describeReason(reason?: string): string {
  switch (reason) {
    case "SEED_MISMATCH":
      return "种子（seed）不同";
    case "ROWS_MISMATCH":
      return "行数（numRows）不同";
    case "ENCODING_MISMATCH":
      return "编码规则（encodingRule）不同";
    default:
      return "摘要维度不一致";
  }
}
