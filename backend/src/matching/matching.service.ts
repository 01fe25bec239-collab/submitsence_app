import type { PoolClient } from "pg";
import { assertSafeStatusLanguage } from "../compliance/language";
import { getEmbedder, toVectorLiteral, type Embedder } from "../ingestion/embedder";
import { extractStandards } from "../ingestion/extraction";
import { rankMatches, type ProductCandidate, type RequirementInput } from "./scoring";

// Requirement -> tenant-owned product matching (B6-B7). Runs inside the caller's
// withTenantClient transaction. Cross-tenant matching is impossible by construction: candidates
// are loaded with an explicit `p.tenant_id = $1` filter AND RLS scopes the connection, AND the
// product_matches composite FKs pin register_items and products to the SAME tenant_id (0007).
//
// Suggestions land as decision='pending' - only a human accept/reject/override transitions them
// (compliance-security-handoff §2). Re-running replaces prior *pending* rows only; human
// decisions are preserved (idempotent, non-destructive).

const CANDIDATE_LIMIT = 500; // ponytail: full tenant-catalogue scan; add a pgvector ANN prefilter when a tenant's catalogue exceeds a few hundred products (HNSW index already exists, 0007).

export interface MatchInput {
  tenantId: string;
  registerItemId: string;
  embedder?: Embedder;
  limit?: number;
}

export interface MatchResult {
  registerItemId: string;
  requirementId: string | null;
  matchIds: string[];
  count: number;
}

interface CandidateRow {
  id: string;
  name: string;
  model_number: string | null;
  category: string | null;
  description: string | null;
  has_datasheet: boolean;
  attributes: { key: string; value: string | null; unit: string | null }[];
  semantic_score: number | null;
}

export async function computeAndStoreMatches(client: PoolClient, input: MatchInput): Promise<MatchResult> {
  const item = await client.query<{
    id: string;
    project_id: string;
    requirement_id: string | null;
    ri_title: string;
    ri_desc: string | null;
    req_title: string | null;
    req_desc: string | null;
    category: string | null;
  }>(
    `select ri.id, ri.project_id, ri.requirement_id, ri.title as ri_title, ri.description as ri_desc,
            sr.title as req_title, sr.description as req_desc, sr.category::text as category
       from register_items ri
       left join submittal_requirements sr on sr.id = ri.requirement_id and sr.tenant_id = ri.tenant_id
      where ri.id = $1 and ri.tenant_id = $2`,
    [input.registerItemId, input.tenantId],
  );
  if (!item.rows[0]) throw new Error(`register item ${input.registerItemId} not found for tenant`);
  const row = item.rows[0];

  const requirement: RequirementInput = {
    id: row.requirement_id ?? row.id,
    title: row.req_title ?? row.ri_title,
    description: row.req_desc ?? row.ri_desc,
    category: row.category,
    standards: extractStandards(`${row.req_title ?? row.ri_title} ${row.req_desc ?? row.ri_desc ?? ""}`),
  };

  // Embed the requirement so pgvector can score semantic closeness (index-friendly `<=>`), without
  // shipping product vectors to the app.
  const embedder = input.embedder ?? getEmbedder();
  let queryVec: string | null = null;
  try {
    queryVec = toVectorLiteral(await embedder.embed(`${requirement.title} ${requirement.description ?? ""}`));
  } catch {
    queryVec = null; // semantic is optional; lexical still runs
  }

  const candidates = await client.query<CandidateRow>(
    `select p.id, p.name, p.model_number, p.category, p.description,
            exists(select 1 from product_documents pd where pd.tenant_id = p.tenant_id and pd.product_id = p.id) as has_datasheet,
            coalesce((select jsonb_agg(jsonb_build_object('key', attr_key, 'value', attr_value, 'unit', unit))
                        from product_attributes pa where pa.tenant_id = p.tenant_id and pa.product_id = p.id), '[]'::jsonb) as attributes,
            case when $3::vector is not null and pe.embedding is not null then 1 - (pe.embedding <=> $3::vector) end as semantic_score
       from products p
       left join product_embeddings pe on pe.tenant_id = p.tenant_id and pe.product_id = p.id and pe.embedding_model = $4
      where p.tenant_id = $1 and p.is_archived = false
      order by (case when $3::vector is not null and pe.embedding is not null then pe.embedding <=> $3::vector end) asc nulls last
      limit $2`,
    [input.tenantId, CANDIDATE_LIMIT, queryVec, embedder.model],
  );

  const productCandidates: ProductCandidate[] = candidates.rows.map((c) => {
    const attrs = c.attributes ?? [];
    const declaredStandards = attrs.filter((a) => /standard|cert/i.test(a.key)).map((a) => a.value ?? "").filter(Boolean);
    const textStandards = extractStandards([c.name, c.description, ...attrs.map((a) => `${a.key} ${a.value ?? ""}`)].join(" "));
    return {
      id: c.id,
      name: c.name,
      modelNumber: c.model_number,
      category: c.category,
      description: c.description,
      attributes: attrs,
      standards: [...new Set([...declaredStandards, ...textStandards])],
      hasDatasheet: c.has_datasheet,
      semanticScore: c.semantic_score,
    };
  });

  const suggestions = rankMatches(requirement, productCandidates, { limit: input.limit ?? 10 });

  // Replace prior *pending* suggestions for this item; keep human-decided rows.
  await client.query(`delete from product_matches where tenant_id = $1 and register_item_id = $2 and decision = 'pending'`, [input.tenantId, input.registerItemId]);

  const matchIds: string[] = [];
  for (const s of suggestions) {
    assertSafeStatusLanguage(s.rationale); // no certification/approval language in system copy
    const inserted = await client.query<{ id: string }>(
      `insert into product_matches (tenant_id, register_item_id, product_id, requirement_id, confidence, rationale_summary, evidence, decision)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending') returning id`,
      [
        input.tenantId,
        input.registerItemId,
        s.productId,
        row.requirement_id,
        s.confidence,
        s.rationale,
        JSON.stringify({ references: s.evidence, missingInfo: s.missingInfo }),
      ],
    );
    matchIds.push(inserted.rows[0].id);
  }

  // Audit the suggestion run (req f: record every match suggestion). No PII in payload.
  await client.query(
    `insert into audit_events (tenant_id, event_type, actor_user_id, actor_type, entity_type, entity_id, action, summary, payload)
     values ($1, 'match', nullif(current_setting('app.user_id', true), '')::uuid, coalesce(nullif(current_setting('app.actor_type', true), ''), 'system'),
             'register_item', $2, 'match_suggestions', 'Product match suggestions generated for review', $3::jsonb)`,
    [input.tenantId, input.registerItemId, JSON.stringify({ project_id: row.project_id, count: matchIds.length, matchIds })],
  );

  return { registerItemId: input.registerItemId, requirementId: row.requirement_id, matchIds, count: matchIds.length };
}
