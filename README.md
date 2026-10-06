# MinHash 集合相似度摘要服务

纯本地 Windows 后端（TypeScript + Node.js + SQLite），为显式字符串 token 集合建立固定长度 MinHash 摘要，估计两集合的 Jaccard 相似度，并逐行解释哪些摘要行相等。只提供 API 与 CLI，无前端。

## 核心规则

- **行哈希**：`SHA-256(seed:uint32大端 ‖ 行号:uint32大端 ‖ token的UTF-8字节)`，取摘要前 8 字节作为无符号 64 位大端整数（编码规则标识 `sha256-be-v1`）。每行保存该集合所有元素哈希值的最小值。
- **精度**：所有 64 位行值以十进制字符串存储与传输，全程使用 `BigInt`，不经 `Number` 转换，低位不丢失。
- **估计**：两个非空摘要的估计 = 相等行数 / 总行数，同时报告分子、分母与相等行位置。这是有限哈希族下的**近似观察**，不保证达到固定误差，也**不能当作成员证明**。
- **空集**：用独立的 `isEmpty` 标志表示，不用最大整数冒充空行。空对空定义为 1，空对非空为 0。
- **兼容性**：种子、行数或编码规则不同的摘要不可比较/合并，返回具体不兼容原因（`INCOMPATIBLE_SEED` / `INCOMPATIBLE_ROWS` / `INCOMPATIBLE_ENCODING`）。
- **集合语义**：比较元素集合，不分析词频、不分词、不做语义向量；重复 token 不增加权重；追加重复项与自合并幂等。字符串区分大小写与空白，空字符串是合法元素，不 trim、不做 Unicode 归一。
- **合并**：逐行取较小值生成**新**摘要，不修改来源，不把哈希值相加，不混成频次计数。摘要合并与"先并集再构建"逐行一致（有测试保证）。
- **诚实性**：正式摘要只保存固定行值与元数据，服务端不保留原始集合，不会用精确 Jaccard 冒充估计；真实交并集值只在演示/测试中作为独立基准展示。

## 规模上限

| 项 | 上限 |
|---|---|
| 行数 rows | 16..256 |
| 单 token | 4096 字节（UTF-8），须为合法 Unicode（拒绝孤立代理项） |
| 单批 token 数 | 10000 |
| HTTP 请求体 | 2 MB |

超限返回明确错误码：`INVALID_PARAM`、`INVALID_UNICODE`、`TOKEN_TOO_LARGE`、`BATCH_TOO_LARGE`、`NOT_FOUND`、`INCOMPATIBLE_*`、`CORRUPT_IMPORT`。

## 运行（Windows 本地，无需 Docker/WSL）

要求 Node.js ≥ 22（使用内置 `node:sqlite`，当前在 Node 25 验证）。

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认选择空闲端口，PORT=8080 可指定）
npm run demo       # 运行演示（相同/重排重复/部分重叠/不相交/空集/合并）
```

数据目录为项目内 `data/`（可用环境变量 `MINHASH_DB` 或 CLI `--db` 覆盖）。SQLite 事务保证批量追加原子性：失败批次不修改任何行；重启后继续追加/比较与不中断一致。

## API

统一返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。

- `POST /api/sketches` `{ seed, rows, name?, tokens? }` 创建
- `POST /api/sketches/:id/append` `{ tokens: [...] }` 批量追加（原子）
- `GET /api/sketches/:id` 查看摘要（行值为十进制字符串）
- `GET /api/sketches` 列表
- `POST /api/compare` `{ a, b }` 两两比较，返回分子/分母/估计值/相等行
- `POST /api/sketches/:id/merge` `{ otherId, name? }` 合并为新版本（来源不变）
- `GET /api/sketches/:id/export` / `POST /api/import` 导入导出（导入校验维度、范围与空集表示）
- `GET /api/history?sketchId=` 操作历史
- `GET /api/limits` 规模上限

## CLI

```powershell
node dist/src/cli.js create --seed 42 --rows 64 --name demo --tokens "[""a"",""b"",""c""]"
node dist/src/cli.js append 1 --tokens "[""d""]"
node dist/src/cli.js show 1
node dist/src/cli.js compare 1 2
node dist/src/cli.js merge 1 2 --name union
node dist/src/cli.js export 1 --out snap.json
node dist/src/cli.js import --file snap.json
node dist/src/cli.js list / history / limits
node dist/src/cli.js serve --port 8080
```

## 限制说明

- 摘要是单向的：**无法从摘要还原元素**，只能做相似度估计。
- 估计是概率性的：不相交集合不保证每次观测必为零，相同集合必为一。
- 不同种子/行数/编码的摘要彼此无意义，必须重新构建。
- `node:sqlite` 在 Node 25 仍带 Experimental 警告，不影响功能。
