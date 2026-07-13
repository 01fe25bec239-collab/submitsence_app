import { createHash } from "node:crypto";

// Tenant-isolated embedding generation (B6-B7). The interface is what matching/ingestion
// depend on; the implementation is swappable.
//
// ponytail: the default is a deterministic, dependency-free hashing embedder. It keeps
// ingestion, pgvector storage, and semantic search runnable and reproducible WITHOUT sending
// tenant catalogue text to any external processor. A real embedding model MUST be
// Australian-hosted/approved (compliance-security-handoff §5-6) before it replaces this -
// wiring it is a processor-approval decision, mirroring the deferred broker/Stripe SDK. Swap by
// providing another Embedder with the same `dim` (the product_embeddings column is vector(1536)).

export interface Embedder {
  model: string;
  dim: number;
  embed(text: string): Promise<number[]>;
}

export const EMBEDDING_DIM = 1536;

class HashingEmbedder implements Embedder {
  model = "local-hash-v1";
  dim = EMBEDDING_DIM;

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dim).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length < 3) continue;
      const h = createHash("sha256").update(tok).digest();
      const bucket = h.readUInt32BE(0) % this.dim;
      const sign = (h[4] & 1) === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    // L2-normalise so cosine similarity is well-behaved.
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return norm === 0 ? vec : vec.map((x) => x / norm);
  }
}

let active: Embedder = new HashingEmbedder();

export function getEmbedder(): Embedder {
  return active;
}

// Test/DI seam: let infra swap in an AU-resident model without touching call sites.
export function setEmbedder(e: Embedder): void {
  active = e;
}

// pgvector text form: '[0.1,0.2,...]'
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
