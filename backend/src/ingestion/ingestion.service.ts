import type { PoolClient } from "pg";
import { getEmbedder, toVectorLiteral, type Embedder } from "./embedder";
import { getExtractor, type CatalogueSource, type ExtractedProduct } from "./extraction";

// Catalogue ingestion (B6-B7): extract -> persist vendors/products/attributes/document links/
// extracted-data rows/embeddings, all tenant-scoped inside the caller's withTenantClient
// transaction (RLS + composite FKs make cross-tenant writes unrepresentable). Idempotent:
// re-ingesting the same catalogue updates existing products rather than duplicating them.

export interface IngestInput {
  tenantId: string;
  documentId: string | null;
  projectId: string | null;
  catalogueId: string | null;
  source: CatalogueSource;
  extractionJobId?: string | null;
  embedder?: Embedder;
}

export interface IngestSummary {
  vendors: number;
  productsCreated: number;
  productsUpdated: number; // duplicates detected within the tenant -> updated in place
  embeddings: number;
  unsupportedReason?: string;
}

export async function ingestCatalogue(client: PoolClient, input: IngestInput): Promise<IngestSummary> {
  const { products, unsupportedReason } = await getExtractor().extract(input.source);
  const embedder = input.embedder ?? getEmbedder();
  const summary: IngestSummary = { vendors: 0, productsCreated: 0, productsUpdated: 0, embeddings: 0, unsupportedReason };

  const vendorIds = new Map<string, string>();
  for (const p of products) {
    const vendorId = await upsertVendor(client, input.tenantId, p.vendorName, vendorIds);
    const { productId, created } = await upsertProduct(client, input, vendorId, p);
    created ? summary.productsCreated++ : summary.productsUpdated++;

    await replaceAttributes(client, input.tenantId, productId, p);
    if (input.documentId) await linkDocument(client, input.tenantId, productId, input.documentId);
    await recordExtractedData(client, input, productId, p);

    const embedding = await embedder.embed(productText(p));
    await client.query(
      `insert into product_embeddings (tenant_id, product_id, embedding_model, embedding, content_hash)
       values ($1, $2, $3, $4::vector, $5)
       on conflict (product_id, embedding_model)
         do update set embedding = excluded.embedding, content_hash = excluded.content_hash, created_at = now()`,
      [input.tenantId, productId, embedder.model, toVectorLiteral(embedding), hash(productText(p))],
    );
    summary.embeddings++;
  }
  summary.vendors = vendorIds.size;
  return summary;
}

function productText(p: ExtractedProduct): string {
  return [p.name, p.modelNumber, p.category, p.description, ...p.attributes.map((a) => `${a.key} ${a.value ?? ""}`), ...p.standards]
    .filter(Boolean)
    .join(" ");
}

function hash(s: string): string {
  // small stable content hash for embedding cache invalidation
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

async function upsertVendor(client: PoolClient, tenantId: string, name: string, cache: Map<string, string>): Promise<string> {
  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const existing = await client.query<{ id: string }>(`select id from vendors where tenant_id = $1 and lower(name) = $2 limit 1`, [tenantId, key]);
  const id = existing.rows[0]?.id
    ?? (await client.query<{ id: string }>(`insert into vendors (tenant_id, name) values ($1, $2) returning id`, [tenantId, name])).rows[0].id;
  cache.set(key, id);
  return id;
}

// Duplicate detection within the tenant (req f): same vendor + model_number (or name when no
// model) is treated as the same product and updated in place, keeping ingestion idempotent.
async function upsertProduct(client: PoolClient, input: IngestInput, vendorId: string, p: ExtractedProduct): Promise<{ productId: string; created: boolean }> {
  const dup = await client.query<{ id: string }>(
    `select id from products
      where tenant_id = $1 and vendor_id = $2
        and ($3::text is not null and lower(model_number) = lower($3)
             or $3::text is null and lower(name) = lower($4))
      limit 1`,
    [input.tenantId, vendorId, p.modelNumber ?? null, p.name],
  );
  if (dup.rows[0]) {
    await client.query(
      `update products set name = $2, category = coalesce($3, category), description = coalesce($4, description),
              catalogue_id = coalesce($5, catalogue_id), is_archived = false, updated_at = now()
        where id = $1`,
      [dup.rows[0].id, p.name, p.category, p.description, input.catalogueId],
    );
    return { productId: dup.rows[0].id, created: false };
  }
  const inserted = await client.query<{ id: string }>(
    `insert into products (tenant_id, vendor_id, catalogue_id, name, model_number, category, description, datasheet_document_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [input.tenantId, vendorId, input.catalogueId, p.name, p.modelNumber, p.category, p.description, input.documentId],
  );
  return { productId: inserted.rows[0].id, created: true };
}

async function replaceAttributes(client: PoolClient, tenantId: string, productId: string, p: ExtractedProduct): Promise<void> {
  await client.query(`delete from product_attributes where tenant_id = $1 and product_id = $2 and source is distinct from 'manual_entry'`, [tenantId, productId]);
  const rows = [...p.attributes];
  for (const std of p.standards) rows.push({ key: "standard", value: std, source: "extracted" });
  for (const a of rows) {
    await client.query(
      `insert into product_attributes (tenant_id, product_id, attr_key, attr_value, unit, source)
       values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, productId, a.key, a.value ?? null, a.unit ?? null, a.source ?? "extracted"],
    );
  }
}

async function linkDocument(client: PoolClient, tenantId: string, productId: string, documentId: string): Promise<void> {
  await client.query(
    `insert into product_documents (tenant_id, product_id, document_id, doc_role)
     values ($1, $2, $3, 'datasheet') on conflict (product_id, document_id, doc_role) do nothing`,
    [tenantId, productId, documentId],
  );
}

async function recordExtractedData(client: PoolClient, input: IngestInput, productId: string, p: ExtractedProduct): Promise<void> {
  await client.query(
    `insert into extracted_product_data (tenant_id, product_id, source_document_id, extraction_job_id, data, confidence)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [input.tenantId, productId, input.documentId, input.extractionJobId ?? null, JSON.stringify(p), 1.0],
  );
}
