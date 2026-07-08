# Example queries

All app queries run as `submitsense_app` after setting the transaction context:

```sql
set local app.tenant_id  = '11111111-1111-1111-1111-111111111111';
set local app.user_id    = '33333333-3333-3333-3333-333333333333';
set local app.actor_type = 'human';
```

RLS then scopes every statement automatically — you rarely need an explicit `WHERE tenant_id = …`.

## 1. Tenant isolation (implicit)

```sql
-- Returns ONLY the current tenant's projects; another tenant's rows are invisible.
select id, name, status, submission_deadline
from projects
where is_archived = false
order by submission_deadline nulls last;
```

## 2. Audit export (time range)

```sql
-- Run as submitsense_auditor for cross-tenant export, or as the app for one tenant.
select occurred_at, event_type, actor_type, actor_user_id, entity_type, entity_id, action, summary, checksum
from audit_events
where tenant_id = '11111111-1111-1111-1111-111111111111'
  and occurred_at >= now() - interval '30 days'
order by occurred_at;                       -- uses idx_audit_tenant_time
```

## 3. Register dashboard (status + due dates)

```sql
select ri.id, ri.title, ri.status, ri.due_date,
       u.full_name  as responsible,
       sr.category,
       ws.code || ' cl ' || c.clause_number as clause_ref
from register_items ri
left join users u  on u.id = ri.responsible_user_id
left join submittal_requirements sr on sr.id = ri.requirement_id
left join worksections ws on ws.id = sr.worksection_id
left join clauses c        on c.id = sr.clause_id
where ri.project_id = '55555555-5555-5555-5555-555555555555'
  and ri.status not in ('closed', 'cancelled')
order by ri.due_date nulls last, ri.status;  -- uses idx_register_status / idx_register_due
```

Status counts for a board:

```sql
select status, count(*)
from register_items
where project_id = '55555555-5555-5555-5555-555555555555'
group by status;
```

## 4. Vendor product-match search (pgvector)

```sql
-- :query_vec is a vector(1536) for the requirement. RLS already limits to this tenant;
-- keep the tenant predicate so the planner can prune, and cosine-order the nearest products.
select p.id, p.name, p.model_number, v.name as vendor,
       1 - (pe.embedding <=> :query_vec) as cosine_similarity
from product_embeddings pe
join products p on p.id = pe.product_id
join vendors  v on v.id = p.vendor_id
where pe.tenant_id = app.current_tenant_id()
  and p.is_archived = false
order by pe.embedding <=> :query_vec           -- HNSW cosine index
limit 10;
```

Keyword fallback (trigram):

```sql
select id, name, model_number
from products
where tenant_id = app.current_tenant_id()
  and name % 'hydrant dn65'                     -- pg_trgm similarity
order by similarity(name, 'hydrant dn65') desc
limit 10;
```

## 5. Recording a human sign-off (guardrail happy path)

```sql
set local app.actor_type = 'human';
set local app.user_id    = '33333333-3333-3333-3333-333333333333';   -- a human reviewer

update register_items
   set status            = 'human_approved',
       human_approved_by = '33333333-3333-3333-3333-333333333333',
       human_approved_at = now(),
       human_approval_note = 'Datasheet matches clause 3.2; approved.'
 where id = '99999999-9999-9999-9999-999999999999';
-- Trigger auto-writes a 'human_signoff' audit_events row. A 'system' actor or a service-account
-- approver would be rejected.
```
