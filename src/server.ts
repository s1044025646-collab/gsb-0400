import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, type ErrorCode } from "./errors.js";
import { LIMITS } from "./limits.js";
import { checkCompatible, compareRows, validateRows, validateSeed, validateToken } from "./minhash.js";
import { exportSummaries, importBundle } from "./io.js";
import { bigintJsonReplacer, rowsToStrings } from "./serialize.js";
import { Store, describeReason } from "./store.js";

export interface AppContext {
  store: Store;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, bigintJsonReplacer);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string, status: number, details?: unknown): void {
  send(res, status, { error: { code, message, details: details ?? null } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      throw new AppError("BATCH_TOO_LARGE", "请求体超过 8 MiB 上限", 413);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("BAD_REQUEST", "请求体必须为 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function parseTokens(raw: unknown, { allowEmpty = false } = {}): string[] {
  if (!Array.isArray(raw)) throw new AppError("VALIDATION_ERROR", "tokens 必须为字符串数组");
  if (!allowEmpty && raw.length === 0) {
    throw new AppError("EMPTY_BATCH", "tokens 不能为空");
  }
  if (raw.length > LIMITS.MAX_TOKENS_PER_BATCH) {
    throw new AppError("BATCH_TOO_LARGE", `单批 token 数量超过上限 ${LIMITS.MAX_TOKENS_PER_BATCH}`);
  }
  return raw.map((t) => validateToken(t));
}

function summaryView(r: ReturnType<Store["getSummaryOrThrow"]>) {
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
    parentVersion: r.parentVersion,
    note: r.note,
    createdAt: r.createdAt
  };
}

export function createApp(store: Store): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/limits") {
        return send(res, 200, { limits: LIMITS });
      }

      if (method === "POST" && path === "/summaries") {
        const b = requireObject(await readJson(req));
        const seed = validateSeed(b.seed ?? 0);
        const numRows = validateRows(b.numRows ?? 128);
        const tokens = parseTokens(b.tokens ?? [], { allowEmpty: true });
        const note = b.note === undefined ? null : (b.note as string | null);
        const rec = store.createSummary({ seed, numRows, tokens, note });
        return send(res, 201, { summary: summaryView(rec) });
      }

      if (method === "GET" && path === "/summaries") {
        const limit = clampInt(url.searchParams.get("limit"), 1, LIMITS.MAX_HISTORY_LIMIT, 50);
        const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);
        const result = store.listSummaries(limit, offset);
        return send(res, 200, { total: result.total, limit, offset, summaries: result.summaries });
      }

      let m = /^\/summaries\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        const rec = store.getSummaryOrThrow(decodeURIComponent(m[1]!));
        return send(res, 200, { summary: summaryView(rec) });
      }

      m = /^\/summaries\/([^/]+)\/append$/.exec(path);
      if (method === "POST" && m) {
        const id = decodeURIComponent(m[1]!);
        const b = requireObject(await readJson(req));
        const tokens = parseTokens(b.tokens);
        const rec = store.appendTokens(id, tokens, (b.note as string | null) ?? null);
        return send(res, 200, { summary: summaryView(rec) });
      }

      m = /^\/summaries\/([^/]+)\/history$/.exec(path);
      if (method === "GET" && m) {
        const limit = clampInt(url.searchParams.get("limit"), 1, LIMITS.MAX_HISTORY_LIMIT, 100);
        const history = store.history(decodeURIComponent(m[1]!), limit);
        return send(res, 200, { history });
      }

      if (method === "POST" && path === "/compare") {
        const b = requireObject(await readJson(req));
        const pairs = b.pairs;
        if (!Array.isArray(pairs)) throw new AppError("VALIDATION_ERROR", "pairs 必须为数组");
        if (pairs.length === 0) throw new AppError("VALIDATION_ERROR", "pairs 不能为空");
        if (pairs.length > LIMITS.MAX_COMPARE_PAIRS) {
          throw new AppError("TOO_MANY_PAIRS", `比较对数量超过上限 ${LIMITS.MAX_COMPARE_PAIRS}`);
        }
        const results = pairs.map((p, i) => {
          if (typeof p !== "object" || p === null) {
            throw new AppError("VALIDATION_ERROR", `pairs[${i}] 必须为对象`);
          }
          const leftId = String((p as Record<string, unknown>).leftId ?? "");
          const rightId = String((p as Record<string, unknown>).rightId ?? "");
          const left = store.getSummaryOrThrow(leftId);
          const right = store.getSummaryOrThrow(rightId);
          const compat = checkCompatible(left, right);
          if (!compat.compatible) {
            return {
              leftId,
              rightId,
              compatible: false,
              reasonCode: compat.reason,
              reason: describeReason(compat.reason)
            };
          }
          const cmp = compareRows(left.rows, right.rows);
          return {
            leftId,
            rightId,
            compatible: true,
            leftVersion: left.version,
            rightVersion: right.version,
            ...cmp
          };
        });
        return send(res, 200, { results });
      }

      if (method === "POST" && path === "/merge") {
        const b = requireObject(await readJson(req));
        if (!Array.isArray(b.sourceIds)) throw new AppError("VALIDATION_ERROR", "sourceIds 必须为数组");
        const sourceIds = b.sourceIds.map((x) => String(x));
        const rec = store.mergeSummaries(sourceIds, (b.note as string | null) ?? null);
        return send(res, 201, { summary: summaryView(rec) });
      }

      if (method === "POST" && path === "/export") {
        const b = requireObject(await readJson(req));
        if (!Array.isArray(b.ids)) throw new AppError("VALIDATION_ERROR", "ids 必须为数组");
        const bundle = exportSummaries(store, b.ids.map((x) => String(x)));
        return send(res, 200, bundle);
      }

      if (method === "POST" && path === "/import") {
        const body = await readJson(req);
        const keepIds = requireObject(body).keepIds === true;
        const bundle = (body as Record<string, unknown>).bundle ?? body;
        const { imported } = importBundle(store, bundle, keepIds);
        return send(res, 201, { imported: imported.map(summaryView) });
      }

      if (method === "GET" && path === "/") {
        return send(res, 200, {
          service: "minhash-sets",
          endpoints: [
            "POST /summaries",
            "GET /summaries",
            "GET /summaries/:id",
            "POST /summaries/:id/append",
            "GET /summaries/:id/history",
            "POST /compare",
            "POST /merge",
            "POST /export",
            "POST /import",
            "GET /limits"
          ]
        });
      }

      sendError(res, "NOT_FOUND", `无此路由：${method} ${path}`, 404);
    } catch (err) {
      if (err instanceof AppError) {
        return sendError(res, err.code, err.message, err.status, err.details);
      }
      console.error(err);
      sendError(res, "INTERNAL", "服务器内部错误", 500);
    }
  });
  return server;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new AppError("VALIDATION_ERROR", `参数必须为整数：${raw}`);
  if (n < min || n > max) throw new AppError("VALIDATION_ERROR", `参数须位于 [${min}, ${max}]：${raw}`);
  return n;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
    srv.on("error", reject);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let portArg: string | null = null;
  let dbPath = resolve("data/minhash.db");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") portArg = args[++i] ?? null;
    else if (args[i] === "--db") dbPath = resolve(args[++i] ?? "");
  }
  const port = portArg ? Number(portArg) : process.env.PORT ? Number(process.env.PORT) : await pickFreePort();
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AppError("VALIDATION_ERROR", `非法端口：${String(portArg)}`);
  }
  const store = new Store(dbPath);
  const server = createApp(store);
  server.listen(port, "127.0.0.1", () => {
    console.log(`MinHash 服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据库: ${dbPath}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof AppError ? `[${err.code}] ${err.message}` : err);
    process.exit(1);
  });
}
