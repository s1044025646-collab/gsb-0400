# MinHash 集合相似度摘要服务（仅后端 / API + CLI）

使用 TypeScript、Node.js（内置 `node:sqlite`，无原生模块）从零实现的 **MinHash 集合相似度** 实验服务。

- 仅适用于 **Windows 本地运行**，不依赖 Docker、WSL、付费服务或任何在线 API。
- 只做后端：HTTP JSON API + 命令行工具，没有前端页面。
- 比较的是**元素集合**：不做文本分词、不统计词频、不做语义向量或文档搜索。
- 重复元素不增加权重（集合语义）；字符串区分大小写与空白；`""` 是合法元素；不做 trim 或 Unicode 归一化。

## 环境要求

- Node.js ≥ 22（开发与验证使用 v25.5.0，需要内置 `node:sqlite`）
- npm

## 快速开始

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 运行 19 个内置测试（node --test + tsx）
npm start          # 启动 HTTP 服务，默认自动选择空闲端口
npm run demo       # 运行演示：相同集合 / 部分重叠 / 不相交 / 空集 / 合并
```

启动后会打印实际监听地址，例如 `http://127.0.0.1:56513`。

可选参数：

```powershell
npm start -- --port 8080 --db data/minhash.db
# 或环境变量
$env:PORT="8080"; npm start
```

数据库文件默认位于项目内 `data/minhash.db`（自动创建，WAL 模式）。

## 哈希与摘要规则

固定行数 `numRows`（16–256），每个集合保存每行一个 64 位无符号最小值。

第 `i` 行对 token `t` 的哈希为：

```
SHA-256( seed 的 4 字节大端 || 行号 i 的 4 字节大端 || t 的 UTF-8 字节 )
```

取摘要前 8 字节，按**大端无符号 64 位整数**解释。摘要更新、比较、兼容检查均自行实现，不使用任何现成相似度/MinHash 库。行值在 SQLite 中以 8 字节 BLOB 原子保存，全程使用 `BigInt`，**不经过 `Number` 转换，低位不丢失**；JSON 中序列化为十进制字符串。

编码规则标识：`sha256-be:seed32-row32:utf8/v1`。

### 相似度估计

两个**非空**兼容摘要：`相同行数 / 总行数`，返回 `matchCount`、`totalRows`、`estimate` 以及全部相等行位置 `matchedRows`（0 起）。

空集是**独立状态**（数据库中行 BLOB 为 `NULL`，绝不用 `2^64-1` 冒充空行）：

- 空集对空集：定义为 `1`（所有行位置都视为“相等”）
- 空集对非空集：`0`

### 重要语义限制（请务必阅读）

- MinHash 估计是**有限哈希族下的近似观测**：不保证每次都达到某个固定误差界；演示中 64 行的部分重叠集合可能估计为 0.547，而精确 Jaccard 为 0.429。
- 某行相等是**哈希碰撞观察，不是成员证明**；不相交集合也**不保证每次观测都恰为 0**（小行号/小集合可能碰巧碰撞，也可能为 0）。
- 摘要**不能还原元素**：只保存固定行值与元数据（种子、行数、编码规则、版本、空集标志），系统不保存、也无法从行值恢复原始 token 集合。
- 系统**不会**保存完整集合后计算精确 Jaccard 冒充估计；`npm run demo` 中的精确 Jaccard 来自独立基准（测试/演示局部 `Set` 计算），与摘要结果分开展示。

### 追加与合并

- `append` 批量追加 token，逐行取更小值；重复 token 与重复批次不改变摘要（幂等）。
- `merge` 对**兼容**摘要逐行取最小值生成**新摘要（新版本实体）**，不相加、不计数、不修改任何来源。
- 合并与“先取集合并集再构建摘要”逐行完全一致；满足交换律、结合律、幂等（测试覆盖）。
- 种子、行数或编码规则不同的摘要**不可比较/合并**，返回具体原因：`SEED_MISMATCH` / `ROWS_MISMATCH` / `ENCODING_MISMATCH`。

所有写操作在 SQLite 事务（SAVEPOINT）中完成，**失败批次不会修改任何行**；每次追加/合并生成新版本，旧快照不可变，之后继续追加不影响旧版本，重启后行为一致。

## 规模上限

| 项目 | 上限 |
| --- | --- |
| 行数 `numRows` | 16 – 256 |
| 种子 `seed` | 0 – 4294967295 |
| 单个 token UTF-8 字节数 | 4096 |
| 单批 token 数 | 100,000 |
| 单次比较对数 | 512 |
| 合并来源数 | 256 |
| 导入/导出摘要数 | 2048 |
| HTTP 请求体 | 8 MiB |

非法 Unicode（孤立代理项）返回 `INVALID_UNICODE`；超长 token 返回 `TOKEN_TOO_LONG`；超限批次返回 `BATCH_TOO_LARGE`。

## HTTP API

所有请求/响应均为 JSON；错误统一形如：

```json
{ "error": { "code": "ROWS_OUT_OF_RANGE", "message": "行数必须位于 [16, 256]，收到 7", "details": null } }
```

| 方法与路径 | 说明 |
| --- | --- |
`POST /summaries` | 创建摘要：`{seed?, numRows?, tokens: string[], note?}`（`tokens: []` 创建空集摘要） |
| `GET /summaries?limit=&offset=` | 列出摘要 |
| `GET /summaries/:id` | 查看当前摘要（含十进制字符串行值） |
| `POST /summaries/:id/append` | 批量追加：`{tokens: string[], note?}`，生成新版本 |
| `GET /summaries/:id/history?limit=` | 查询版本历史 |
| `POST /compare` | `{pairs:[{leftId,rightId}, ...]}`，不兼容时返回 `compatible:false` 与原因 |
| `POST /merge` | `{sourceIds:[...], note?}`，生成合并后的新摘要 |
| `POST /export` | `{ids:[...]}`，导出可移植快照（行值为十进制字符串） |
| `POST /import` | 导入快照（可包在 `{bundle: ..., keepIds?: bool}` 中），严格校验维度/范围/空集表示 |
| `GET /limits` | 查看全部规模上限 |
| `GET /health` | 健康检查 |

### PowerShell 调用示例

```powershell
Invoke-RestMethod "http://127.0.0.1:<port>/summaries" -Method Post `
  -ContentType 'application/json' `
  -Body '{"seed":123,"numRows":64,"tokens":["alpha","beta",""]}'
```

## CLI

```powershell
node dist/cli.js create --seed 123 --rows 64 --tokens '["a","b",""]'
node dist/cli.js list
node dist/cli.js show   <id>
node dist/cli.js append <id> --tokens '["c","d"]'
node dist/cli.js history <id>
node dist/cli.js compare <idA> <idB>
node dist/cli.js merge   <idA> <idB> [idC ...]
node dist/cli.js export  <id...> --file bundle.json
node dist/cli.js import  --file bundle.json
# 所有命令支持 --db data/minhash.db 指定数据库
```
`compare` 不兼容时退出码为 2 并输出原因。

## 导入/导出格式

```json
{
  "format": "minhash-summary/v1",
  "exportedAt": "2026-10-06T00:00:00.000Z",
  "summaries": [{
    "id": "...", "seed": 123, "numRows": 64,
    "encodingRule": "sha256-be:seed32-row32:utf8/v1",
    "version": 1, "isEmpty": false,
    "rows": ["1477782696288606411", "..."],
    "note": null, "createdAt": "..."
  }]
}
```

导入时重新生成 id（`keepIds` 可保留），并校验：种子/行数范围、编码规则、行数量等于 `numRows`、每个值在 `[0, 2^64-1]`、空集 `isEmpty:true` 时 `rows` 必须为 `null`。导入是快照副本，之后的追加不会影响它。

## 测试与演示

```powershell
npm test
npm run demo
```

测试覆盖（19 个）：手工核对的哈希夹具（`seed=1,row=0,token="abc"` → `d5595684c52382b5`）、相同集合估计为 1、重排/重复不变、空集两种情况、兼容拒绝原因、合并交换/结合/幂等及“先并集再构建”一致、失败批次原子性、64 位大整数序列化、导出导入往返与多种损坏输入、重启持久化、HTTP 全流程与错误码。

## 项目结构

```
src/
  limits.ts    规模上限与编码规则常量
  errors.ts    错误码与 AppError
  minhash.ts   哈希、更新、比较、兼容、合并（全部自行实现）
  store.ts     SQLite 存储、版本化、事务原子性
  io.ts        导入/导出校验
  serialize.ts 64 位值的十进制字符串序列化
  server.ts    HTTP API、空闲端口选择
  cli.ts       命令行
  demo.ts      演示 + 独立精确 Jaccard 基准
test/          node:test 测试
data/          SQLite 数据目录
```
