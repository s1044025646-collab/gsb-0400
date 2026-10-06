import { appendTokens, compareSketches, createSketch, mergeSketches, sketchFromJSON, sketchToJSON } from "./minhash";
import { Store } from "./store";
import { validateRows, validateSeed, validateTokenBatch, AppError } from "./validate";

export class Service {
  constructor(public store: Store) {}

  create(body: any) {
    const seed = validateSeed(body?.seed);
    const rows = validateRows(body?.rows);
    const name = typeof body?.name === "string" && body.name ? body.name : `sketch-${Date.now()}`;
    const sketch = createSketch(seed, rows);
    const tokens = body?.tokens === undefined ? [] : validateTokenBatch(body.tokens);
    appendTokens(sketch, tokens);
    const meta = this.store.create(name, sketch);
    return { meta, sketch: sketchToJSON(sketch) };
  }

  append(id: number, body: any) {
    const tokens = validateTokenBatch(body?.tokens);
    const { sketch } = this.store.get(id);
    appendTokens(sketch, tokens);
    const meta = this.store.replaceRows(id, sketch, "append", { count: tokens.length });
    return { meta, sketch: sketchToJSON(sketch) };
  }

  show(id: number) {
    const { meta, sketch } = this.store.get(id);
    return { meta, sketch: sketchToJSON(sketch) };
  }

  compare(body: any) {
    const aId = Number(body?.a), bId = Number(body?.b);
    if (!Number.isInteger(aId) || !Number.isInteger(bId)) throw new AppError("INVALID_PARAM", "a 和 b 必须是摘要 id");
    const a = this.store.get(aId), b = this.store.get(bId);
    return { a: a.meta, b: b.meta, result: compareSketches(a.sketch, b.sketch) };
  }

  merge(id: number, body: any) {
    const otherId = Number(body?.otherId);
    if (!Number.isInteger(otherId)) throw new AppError("INVALID_PARAM", "otherId 必须是摘要 id");
    const a = this.store.get(id), b = this.store.get(otherId);
    const merged = mergeSketches(a.sketch, b.sketch);
    const name = typeof body?.name === "string" && body.name ? body.name : `merge-${id}-${otherId}`;
    const meta = this.store.create(name, merged);
    this.store.log(meta.id, "merge", { sources: [id, otherId] });
    return { meta, sketch: sketchToJSON(merged), sources: [a.meta, b.meta] };
  }

  exportOne(id: number) {
    const { meta, sketch } = this.store.get(id);
    return { format: "minhash-export-v1", meta, sketch: sketchToJSON(sketch) };
  }

  importOne(body: any) {
    if (body?.format !== "minhash-export-v1") throw new AppError("CORRUPT_IMPORT", "缺少 format: minhash-export-v1");
    const sketch = sketchFromJSON(body.sketch);
    const name = typeof body?.meta?.name === "string" ? body.meta.name : `import-${Date.now()}`;
    const meta = this.store.create(name, sketch);
    return { meta, sketch: sketchToJSON(sketch) };
  }
}

