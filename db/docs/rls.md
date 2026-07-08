# Row-Level Security & database-enforced guardrails

## Tenant isolation (req NFR2)

Every table with a `tenant_id` column gets an identical policy, applied by a generic loop in
`0013_rls_policies.sql` (so a new tenant table can't be forgotten):

```sql
alter table <t> enable row level security;
create policy tenant_isolation on <t>
  using      (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());
```

`app.current_tenant_id()` reads `current_setting('app.tenant_id', true)::uuid`. The app sets it per
transaction: `SET LOCAL app.tenant_id = '<uuid>'`. Reads outside the tenant return nothing; writes to
another tenant fail the `WITH CHECK`.

### ENABLE vs FORCE — the owner-bypass model

Tables use **ENABLE** (not FORCE) RLS. Consequences:

- The **table owner / superuser bypasses RLS** — this is deliberate. Migrations and seed run as the
  owner, so they work without juggling tenant context; admin/support tooling can run as owner.
- The **application must connect as `submitsense_app`** (a non-owner role with no `BYPASSRLS`). Then
  RLS fully applies. Connecting the app as the owner would silently disable isolation.
- If your deployment must run the app as the table owner, switch to `FORCE ROW LEVEL SECURITY` and
  add a `BYPASSRLS` migrator role instead. Documented here so the choice is explicit.

### Special policies

| Table | Extra policy | Why |
|---|---|---|
| `users` | `users_self_or_member`: visible if it's you or a co-member of your tenant | users has no `tenant_id`; prevents cross-tenant user enumeration |
| `tenant_memberships`, `project_memberships` | `*_self` SELECT policy on `user_id = current_user` | lets a user resolve which tenants they can enter before a tenant is set |
| `audit_events` | `audit_auditor_read` (SELECT, role `submitsense_auditor`) | read-only cross-tenant export |
| `knowledge_base_articles` | `kb_read_published` (SELECT where published) | global content; drafts hidden from the app role, authored via owner |

Global catalogs (`plans`, `permissions`, `roles`, `role_permissions`) have **no RLS** — they are
non-tenant reference data, granted read-only to the app.

## Guardrail 1 — human sign-off (req f12)

`register_items.status = 'human_approved'` is protected by **three** layers:

1. Column default is `draft` — no default can produce `human_approved`.
2. `CHECK (status <> 'human_approved' OR (human_approved_by IS NOT NULL AND human_approved_at IS NOT NULL))`.
3. `BEFORE INSERT/UPDATE` trigger `app.guard_human_approval()` (SECURITY DEFINER) rejects the
   transition unless: approver is an **active `human` user** (not a service account), and the acting
   principal `app.actor_type <> 'system'`. Default `actor_type` is `system`, so approval is
   **fail-closed** — a background job cannot approve.

An `AFTER` trigger (`app.log_register_status`) writes an immutable `human_signoff` audit event, so
the record exists even if application code forgets.

## Guardrail 2 — no cross-tenant matching (req f15)

`product_matches` has a single `tenant_id` and composite FKs
`(tenant_id, register_item_id) → register_items(tenant_id, id)` **and**
`(tenant_id, product_id) → products(tenant_id, id)`. Both parents must share that one tenant, so a
match spanning two tenants is physically unrepresentable — no trigger needed. The same
composite-FK pattern prevents orphaned/cross-tenant links across the whole schema (req f27).

## Guardrail 3 — append-only audit (req f22, NFR5)

- `REVOKE UPDATE, DELETE, TRUNCATE` from the app role (INSERT + SELECT only).
- `BEFORE UPDATE/DELETE/TRUNCATE` triggers raise `0LP01` — defence-in-depth even against the owner.
- Per-row `checksum` (SHA-256 of canonical fields) set on insert for tamper-evidence.

## Guardrail 4 — NATSPEC copyright (req f7, NFR6)

- `clauses` stores structure/heading only — **no full-text column**. Working quotes live in
  `extracted_fragments`, which is tenant-private (RLS) and never referenced by public content.
- `knowledge_base_articles` has no clause-text column and a
  `CHECK` that blocks `publication_state='published'` when `contains_natspec_text` is true and not
  `natspec_copyright_cleared`.

All four are exercised by `db/test/test_guardrails.sql`.
