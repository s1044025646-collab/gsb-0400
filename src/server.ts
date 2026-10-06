import express from "express";
import * as path from "node:path";
import { Service } from "./service";
import { Store } from "./store";
import { AppError, LIMITS } from "./validate";

export function createApp(service: Service) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const wrap = (fn: (req: express.Request) => unknown) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json({ ok: true, data: fn(req) }); } catch (e) { next(e); }
    };

  app.get("/api/limits", wrap(() => LIMITS));
  app.post("/api/sketches", wrap((req) => service.create(req.body)));
  app.get("/api/sketches", wrap(() => service.store.list()));
  app.get("/api/sketches/:id", wrap((req) => service.show(Number(req.params.id))));
  app.post("/api/sketches/:id/append", wrap((req) => service.append(Number(req.params.id), req.body)));
  app.post("/api/sketches/:id/merge", wrap((req) => service.merge(Number(req.params.id), req.body)));
  app.get("/api/sketches/:id/export", wrap((req) => service.exportOne(Number(req.params.id))));
  app.post("/api/import", wrap((req) => service.importOne(req.body)));
  app.post("/api/compare", wrap((req) => service.compare(req.body)));
  app.get("/api/history", wrap((req) =>
    service.store.history(req.query.sketchId ? Number(req.query.sketchId) : undefined)));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    } else if (err instanceof SyntaxError) {
      res.status(400).json({ ok: false, error: { code: "INVALID_PARAM", message: "请求体不是合法 JSON" } });
    } else {
      res.status(500).json({ ok: false, error: { code: "INTERNAL", message: String(err) } });
    }
  });
  return app;
}

export function startServer(dbPath: string, port: number): Promise<number> {
  const service = new Service(new Store(dbPath));
  const app = createApp(service);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`MinHash 服务已启动: http://127.0.0.1:${actual} (数据库: ${dbPath})`);
      resolve(actual);
    });
  });
}

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  const db = process.env.MINHASH_DB || path.join(process.cwd(), "data", "minhash.db");
  startServer(db, port);
}

