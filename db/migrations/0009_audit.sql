-- 0009_audit.sql
-- Immutable, append-only audit trail (req f21, f22, NFR5).
-- Append-only is enforced at THREE layers: (1) REVOKE UPDATE/DELETE/TRUNCATE from app roles,
-- (2) block triggers that raise on UPDATE/DELETE/TRUNCATE (defence in depth vs. table owner),
-- (3) a per-row checksum for tamper-evidence.

begin;

create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete restrict,  -- null only for platform-level events
  event_type    audit_event_type not null,                       -- req f21 classes
  actor_user_id uuid references users(id),                       -- null for pure system actions
  actor_type    text not null default 'system',                  -- human | system | service
  entity_type   text,                                            -- e.g. 'register_item', 'document'
  entity_id     uuid,
  action        text,                                            -- short verb, e.g. 'human_approved'
  summary       text,
  payload       jsonb not null default '{}'::jsonb,              -- before/after, details
  ip_address    inet,                                            -- for auth_sensitive events
  user_agent    text,
  occurred_at   timestamptz not null default now(),
  checksum      text,                                            -- set by trigger; tamper-evidence
  created_at    timestamptz not null default now()
);
create index idx_audit_tenant_time on audit_events (tenant_id, occurred_at);      -- audit export (req f26)
create index idx_audit_type_time on audit_events (event_type, occurred_at);
create index idx_audit_entity on audit_events (entity_type, entity_id);
create index idx_audit_actor on audit_events (actor_user_id, occurred_at);

-- (1) checksum on insert (tamper-evidence)
create or replace function app.audit_stamp() returns trigger
  language plpgsql as $$
begin
  new.checksum := encode(sha256(convert_to(
      coalesce(new.id::text, '')       || '|' ||
      coalesce(new.tenant_id::text, '')|| '|' ||
      new.event_type::text             || '|' ||
      coalesce(new.actor_user_id::text, '') || '|' ||
      coalesce(new.entity_type, '')    || '|' ||
      coalesce(new.entity_id::text, '')|| '|' ||
      coalesce(new.occurred_at::text, '')   || '|' ||
      coalesce(new.payload::text, ''),
    'UTF8')), 'hex');
  return new;
end$$;
create trigger trg_audit_stamp before insert on audit_events
  for each row execute function app.audit_stamp();

-- (2) block mutation (append-only). app.forbid_mutation() defined in 0001.
create trigger trg_audit_no_update before update on audit_events
  for each row execute function app.forbid_mutation();
create trigger trg_audit_no_delete before delete on audit_events
  for each row execute function app.forbid_mutation();
create trigger trg_audit_no_truncate before truncate on audit_events
  for each statement execute function app.forbid_mutation();

-- (3) revoke at the permission level (grants in 0013 give app only INSERT+SELECT)
revoke update, delete, truncate on audit_events from public;

-- --- Auto-write the immutable record for status changes + human sign-off -----
-- Guarantees an audit_events row exists for every register status transition (req f21) and
-- specifically for human_approved (req f12), even if application code forgets.
create or replace function app.log_register_status() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.status is distinct from new.status then
    insert into audit_events (tenant_id, event_type, actor_user_id, actor_type,
                              entity_type, entity_id, action, summary, payload, occurred_at)
    values (new.tenant_id, 'status_change', app.current_user_id(), app.current_actor_type(),
            'register_item', new.id, new.status::text,
            format('Register item status %s -> %s', old.status, new.status),
            jsonb_build_object('from', old.status, 'to', new.status), now());
  end if;

  if new.status = 'human_approved'
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    insert into audit_events (tenant_id, event_type, actor_user_id, actor_type,
                              entity_type, entity_id, action, summary, payload, occurred_at)
    values (new.tenant_id, 'human_signoff', new.human_approved_by, 'human',
            'register_item', new.id, 'human_approved',
            'Human sign-off recorded for register item',
            jsonb_build_object('approved_by', new.human_approved_by,
                               'approved_at', new.human_approved_at,
                               'note', new.human_approval_note),
            coalesce(new.human_approved_at, now()));
  end if;
  return new;
end$$;
create trigger trg_log_register_status
  after insert or update on register_items
  for each row execute function app.log_register_status();

commit;
