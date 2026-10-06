import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { SketchData, sketchFromJSON, sketchToJSON } from "./minhash";
import { AppError } from "./validate";

export interface SketchMeta {
  id: number;
  name: string;
  seed: number;
  rows: number;
  encoding: string;
  isEmpty: boolean;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sketches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        seed INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        encoding TEXT NOT NULL,
        is_empty INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sketch_rows (
        sketch_id INTEGER NOT NULL REFERENCES sketches(id),
        row_index INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (sketch_id, row_index)
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sketch_id INTEGER NOT NULL,
        op TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  create(name: string, sketch: SketchData): SketchMeta {
    return this.tx(() => {
      const info = this.db.prepare(
        "INSERT INTO sketches (name, seed, rows, encoding, is_empty) VALUES (?, ?, ?, ?, ?)"
      ).run(name, sketch.seed, sketch.rows, sketch.encoding, sketch.isEmpty ? 1 : 0);
      const id = Number(info.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO sketch_rows (sketch_id, row_index, value) VALUES (?, ?, ?)");
      sketch.values.forEach((v, i) => ins.run(id, i, v.toString(10)));
      this.log(id, "create", { name, rows: sketch.rows, seed: sketch.seed });
      return this.meta(id)!;
    });
  }

  // 整批原子替换行值；任何一步失败都会回滚，不产生部分行更新
  replaceRows(id: number, sketch: SketchData, op: string, detail: object): SketchMeta {
    return this.tx(() => {
      this.mustMeta(id);
      this.db.prepare("DELETE FROM sketch_rows WHERE sketch_id = ?").run(id);
      const ins = this.db.prepare("INSERT INTO sketch_rows (sketch_id, row_index, value) VALUES (?, ?, ?)");
      sketch.values.forEach((v, i) => ins.run(id, i, v.toString(10)));
      this.db.prepare("UPDATE sketches SET is_empty = ?, updated_at = datetime('now') WHERE id = ?")
        .run(sketch.isEmpty ? 1 : 0, id);
      this.log(id, op, detail);
      return this.meta(id)!;
    });
  }

  get(id: number): { meta: SketchMeta; sketch: SketchData } {
    const meta = this.mustMeta(id);
    const rows = this.db.prepare("SELECT row_index, value FROM sketch_rows WHERE sketch_id = ? ORDER BY row_index")
      .all(id) as { row_index: number; value: string }[];
    const sketch = sketchFromJSON({
      seed: meta.seed, rows: meta.rows, encoding: meta.encoding,
      isEmpty: meta.isEmpty, values: rows.map((r) => r.value),
    });
    return { meta, sketch };
  }

  list(): SketchMeta[] {
    return (this.db.prepare("SELECT * FROM sketches ORDER BY id").all() as any[]).map(rowToMeta);
  }

  history(sketchId?: number) {
    const rows = sketchId == null
      ? this.db.prepare("SELECT * FROM history ORDER BY id").all()
      : this.db.prepare("SELECT * FROM history WHERE sketch_id = ? ORDER BY id").all(sketchId);
    return (rows as any[]).map((r) => ({ id: r.id, sketchId: r.sketch_id, op: r.op, detail: JSON.parse(r.detail), at: r.created_at }));
  }

  log(sketchId: number, op: string, detail: object): void {
    this.db.prepare("INSERT INTO history (sketch_id, op, detail) VALUES (?, ?, ?)")
      .run(sketchId, op, JSON.stringify(detail));
  }

  private meta(id: number): SketchMeta | null {
    const r = this.db.prepare("SELECT * FROM sketches WHERE id = ?").get(id) as any;
    return r ? rowToMeta(r) : null;
  }

  private mustMeta(id: number): SketchMeta {
    const m = this.meta(id);
    if (!m) throw new AppError("NOT_FOUND", `摘要 ${id} 不存在`, 404);
    return m;
  }
}

function rowToMeta(r: any): SketchMeta {
  return {
    id: r.id, name: r.name, seed: r.seed, rows: r.rows, encoding: r.encoding,
    isEmpty: !!r.is_empty, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export { sketchToJSON };

