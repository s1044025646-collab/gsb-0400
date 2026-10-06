#!/usr/bin/env node
import { resolve } from "node:path";
import { AppError } from "./errors.js";
import { exportSummaries, importBundle } from "./io.js";
import { checkCompatible, compareRows, validateRows, validateSeed, validateToken } from "./minhash.js";
import { bigintJsonReplacer, rowsToStrings } from "./serialize.js";
import { Store, describeReason } from "./store.js";

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) flags.set(a, args[++i] ?? "true");
    else positional.push(a);
  }
  return { positional, flags };
}

function parseTokensArg(flag: string | undefined): string[] {
  if (flag === undefined) return [];
  try {
    const parsed = JSON.parse(flag) as unknown;
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    return parsed.map((t) => validateToken(t));
  } catch (err) {
    throw new AppError("VALIDATION_ERROR", `--tokens 必须是 JSON 字符串数组：${(err as Error).message}`);
  }
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, bigintJsonReplacer, 2) + "\n");
}

function view(r: ReturnType<Store["getSummaryOrThrow"]>) {
  return {
    id: r.summaryId,
    version: r.version,
    batchCount: r.batchCount,
    seed: r.seed,
    numRows: r.numRows,
    encodingRule: r.encodingRule,
    isEmpty: r.isEmpty,
    rows: rowsToStrings(r.rows, r.isEmpty),
    kind: r.kind,
    parents: r.parents,
    note: r.note,
    createdAt: r.createdAt
  };
}

async function main(): Promise<number> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional[0];
  const dbPath = resolve(flags.get("--db") ?? "data/minhash.db");
  const store = new Store(dbPath);
  try {
    switch (command) {
      case "create": {
        const seed = validateSeed(flags.has("--seed") ? Number(flags.get("--seed")) : 0);
        const numRows = validateRows(flags.has("--rows") ? Number(flags.get("--rows")) : 128);
        const tokens = parseTokensArg(flags.get("--tokens"));
        const rec = store.createSummary({ seed, numRows, tokens, note: flags.get("--note") ?? null });
        out({ summary: view(rec) });
        return 0;
      }
      case "append": {
        const id = positional[1];
        if (!id) throw new AppError("VALIDATION_ERROR", "用法: append <id> --tokens '[...]'");
        const tokens = parseTokensArg(flags.get("--tokens"));
        const rec = store.appendTokens(id, tokens, flags.get("--note") ?? null);
        out({ summary: view(rec) });
        return 0;
      }
      case "show": {
        const id = positional[1];
        if (!id) throw new AppError("VALIDATION_ERROR", "用法: show <id>");
        out({ summary: view(store.getSummaryOrThrow(id)) });
        return 0;
      }
      case "list": {
        const limit = Number(flags.get("--limit") ?? "50");
        const offset = Number(flags.get("--offset") ?? "0");
        out(store.listSummaries(limit, offset));
        return 0;
      }
      case "history": {
        const id = positional[1];
        if (!id) throw new AppError("VALIDATION_ERROR", "用法: history <id>");
        out({ history: store.history(id, Number(flags.get("--limit") ?? "100")) });
        return 0;
      }
      case "compare": {
        const a = positional[1];
        const b = positional[2];
        if (!a || !b) throw new AppError("VALIDATION_ERROR", "用法: compare <idA> <idB>");
        const left = store.getSummaryOrThrow(a);
        const right = store.getSummaryOrThrow(b);
        const compat = checkCompatible(left, right);
        if (!compat.compatible) {
          out({ compatible: false, reasonCode: compat.reason, reason: describeReason(compat.reason) });
          return 2;
        }
        out({ compatible: true, ...compareRows(left.rows, right.rows) });
        return 0;
      }
      case "merge": {
        const ids = positional.slice(1);
        if (ids.length < 2) throw new AppError("VALIDATION_ERROR", "用法: merge <idA> <idB> [idC ...]");
        out({ summary: view(store.mergeSummaries(ids, flags.get("--note") ?? null)) });
        return 0;
      }
      case "export": {
        const ids = positional.slice(1);
        if (ids.length === 0) throw new AppError("VALIDATION_ERROR", "用法: export <id...> [--file out.json]");
        const bundle = exportSummaries(store, ids);
        const json = JSON.stringify(bundle, bigintJsonReplacer, 2);
        if (flags.has("--file")) await import("node:fs/promises").then((fs) => fs.writeFile(flags.get("--file")!, json, "utf8"));
        else process.stdout.write(json + "\n");
        return 0;
      }
      case "import": {
        const file = flags.get("--file") ?? positional[1];
        if (!file) throw new AppError("VALIDATION_ERROR", "用法: import --file bundle.json");
        const { readFile } = await import("node:fs/promises");
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(file, "utf8"));
        } catch (err) {
          throw new AppError("IMPORT_INVALID", `文件不是合法 JSON：${(err as Error).message}`);
        }
        const { imported } = importBundle(store, parsed, flags.has("--keep-ids"));
        out({ imported: imported.map(view) });
        return 0;
      }
      default:
        process.stderr.write(
          [
            "MinHash 集合相似度 CLI",
            "命令:",
            "  create --seed 32 --rows 128 --tokens '[\"a\",\"\"]' [--note 备注]",
            "  append <id> --tokens '[\"x\"]'",
            "  show <id>",
            "  list [--limit 50] [--offset 0]",
            "  history <id> [--limit 100]",
            "  compare <idA> <idB>",
            "  merge <idA> <idB> ... [--note 备注]",
            "  export <id...> [--file bundle.json]",
            "  import --file bundle.json [--keep-ids]",
            `  全局: --db <path>（默认 ${dbPath}）`
          ].join("\n") + "\n"
        );
        return command === undefined ? 0 : 1;
    }
  } finally {
    store.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof AppError) {
      process.stderr.write(`错误 [${err.code}] ${err.message}\n`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
