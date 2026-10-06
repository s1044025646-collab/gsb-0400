import * as path from "node:path";
import * as fs from "node:fs";
import { Service } from "./service";
import { Store } from "./store";
import { startServer } from "./server";
import { AppError, LIMITS } from "./validate";

function parseArgs(argv: string[]): { cmd: string; positional: string[]; opts: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) opts[key] = rest[++i];
      else opts[key] = "true";
    } else positional.push(rest[i]);
  }
  return { cmd, positional, opts };
}

function loadTokens(opts: Record<string, string>): string[] {
  if (opts.file) return JSON.parse(fs.readFileSync(opts.file, "utf8"));
  if (opts.tokens !== undefined) return JSON.parse(opts.tokens);
  return [];
}

function print(x: unknown): void { console.log(JSON.stringify(x, null, 2)); }

async function main(): Promise<void> {
  const { cmd, positional, opts } = parseArgs(process.argv.slice(2));
  const dbPath = opts.db || path.join(process.cwd(), "data", "minhash.db");

  if (cmd === "serve") {
    await startServer(dbPath, opts.port ? Number(opts.port) : 0);
    return;
  }
  if (cmd === "help") {
    console.log([
      "用法: node dist/src/cli.js <命令> [参数] [--db 路径]",
      "命令:",
      "  serve [--port N]                      启动 API 服务（默认空闲端口）",
      "  create --seed N --rows N [--name S] [--tokens JSON数组|--file 路径]",
      "  append <id> --tokens JSON数组|--file 路径",
      "  show <id>",
      "  list",
      "  compare <idA> <idB>",
      "  merge <idA> <idB> [--name S]",
      "  export <id> [--out 路径]",
      "  import --file 路径",
      "  history [--sketch N]",
      "  limits",
    ].join("\n"));
    return;
  }

  const service = new Service(new Store(dbPath));
  try {
    switch (cmd) {
      case "create":
        print(service.create({ seed: Number(opts.seed), rows: Number(opts.rows), name: opts.name, tokens: opts.tokens || opts.file ? loadTokens(opts) : undefined }));
        break;
      case "append":
        print(service.append(Number(positional[0]), { tokens: loadTokens(opts) }));
        break;
      case "show":
        print(service.show(Number(positional[0])));
        break;
      case "list":
        print(service.store.list());
        break;
      case "compare":
        print(service.compare({ a: Number(positional[0]), b: Number(positional[1]) }));
        break;
      case "merge":
        print(service.merge(Number(positional[0]), { otherId: Number(positional[1]), name: opts.name }));
        break;
      case "export": {
        const data = service.exportOne(Number(positional[0]));
        if (opts.out) { fs.writeFileSync(opts.out, JSON.stringify(data, null, 2)); console.log(`已导出到 ${opts.out}`); }
        else print(data);
        break;
      }
      case "import":
        print(service.importOne(JSON.parse(fs.readFileSync(opts.file, "utf8"))));
        break;
      case "history":
        print(service.store.history(opts.sketch ? Number(opts.sketch) : undefined));
        break;
      case "limits":
        print(LIMITS);
        break;
      default:
        throw new AppError("INVALID_PARAM", `未知命令: ${cmd}`);
    }
  } finally {
    service.store.close();
  }
}

main().catch((e) => {
  if (e instanceof AppError) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
