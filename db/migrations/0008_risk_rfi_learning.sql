-- 0008_risk_rfi_learning.sql
-- Rejection-risk flags + generated checklist items (req f17), RFI drafts with citations (req f18),
-- rejection-pattern learning events (req f19), and tenant consent for the learning loop (req f20).

begin;

-- --- Rejection-risk flags (req f17) -----------------------------------------
create table risk_flags (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  project_id          uuid not null,
  register_item_id    uuid,
  clause_reference_id uuid,                             -- linked clause reference (not clause text)
  risk_type           risk_type not null,
  severity            risk_severity not null,
  summary             text,
  evidence            jsonb not null default '[]'::jsonb,
  state               risk_state not null default 'open',   -- human confirm/dismiss state (req f17)
  reviewed_by         uuid references users(id),        -- reviewer (req f17)
  reviewed_at         timestamptz,
  resolution_note     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id)          references projects        (tenant_id, id) on delete cascade,
  foreign key (tenant_id, register_item_id)    references register_items  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, clause_reference_id) references clause_references (tenant_id, id) on delete set null,
  constraint chk_risk_reviewed_actor check (
    state in ('open') or reviewed_by is not null
  )
);
create index idx_risk_flags_project on risk_flags (tenant_id, project_id, state);
create index idx_risk_flags_register on risk_flags (tenant_id, register_item_id);

-- --- Checklist items (req f17 "generated checklist item") -------------------
create table checklist_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  register_item_id uuid,
  risk_flag_id     uuid,
  label            text not null,
  is_done          boolean not null default false,
  done_by          uuid references users(id),
  done_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, register_item_id) references register_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, risk_flag_id)     references risk_flags     (tenant_id, id) on delete cascade
);
create index idx_checklist_register on checklist_items (tenant_id, register_item_id);

-- --- RFI drafts (req f18) ---------------------------------------------------
create table rfi_drafts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  project_id       uuid not null,
  register_item_id uuid,
  title            text not null,
  body             text,
  conflict_type    rfi_conflict_type not null default 'ambiguity',
  review_status    rfi_review_status not null default 'draft',
  send_status      rfi_send_status   not null default 'not_sent',
  reviewed_by      uuid references users(id),
  reviewed_at      timestamptz,
  sent_at          timestamptz,
  external_ref     text,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id)       references projects       (tenant_id, id) on delete cascade,
  foreign key (tenant_id, register_item_id) references register_items (tenant_id, id) on delete set null
);
create index idx_rfi_project on rfi_drafts (tenant_id, project_id, review_status);

create table rfi_cited_clauses (
  tenant_id           uuid not null references tenants(id) on delete cascade,
  rfi_id              uuid not null,
  clause_reference_id uuid not null,
  primary key (rfi_id, clause_reference_id),
  foreign key (tenant_id, rfi_id)              references rfi_drafts        (tenant_id, id) on delete cascade,
  foreign key (tenant_id, clause_reference_id) references clause_references (tenant_id, id) on delete cascade
);

create table rfi_cited_documents (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  rfi_id      uuid not null,
  document_id uuid not null,                            -- cited drawing/spec
  note        text,
  primary key (rfi_id, document_id),
  foreign key (tenant_id, rfi_id)      references rfi_drafts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references documents  (tenant_id, id) on delete cascade
);

-- --- Rejection-pattern learning events (req f19) ----------------------------
create table rejection_learning_events (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  risk_flag_id       uuid,
  register_item_id   uuid,
  flag_generated_at  timestamptz not null default now(),
  human_decision     risk_state,                        -- confirmed | dismissed | resolved | open
  consultant_outcome consultant_outcome not null default 'unknown',
  anonymised_eligible boolean not null default false,   -- eligibility for anonymised aggregation
  consent_state      consent_state not null default 'unset',   -- snapshot of tenant consent at event time
  opted_out          boolean not null default false,
  created_at         timestamptz not null default now(),
  foreign key (tenant_id, risk_flag_id)     references risk_flags     (tenant_id, id) on delete set null,
  foreign key (tenant_id, register_item_id) references register_items (tenant_id, id) on delete set null
);
create index idx_learning_tenant on rejection_learning_events (tenant_id, created_at);
-- aggregation queries only ever read rows that are BOTH eligible and consented:
create index idx_learning_eligible on rejection_learning_events (created_at)
  where anonymised_eligible = true and opted_out = false and consent_state = 'opted_in';

-- --- Tenant consent (req f20) — current state; history lives in audit_events -
create table tenant_consents (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  learning_loop       consent_state not null default 'unset',
  data_use_preferences jsonb not null default '{}'::jsonb,
  decided_by          uuid references users(id),
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id)
);

commit;
