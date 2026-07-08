-- 0006_register_status.sql
-- Submittal register, status workflow, and the human-in-the-loop approval guard (req f11, f12).
-- Physical samples + stamped shop drawings are tracked as line items (req f13), never generated files.

begin;

-- --- Submittal register items (req f10, f11) --------------------------------
create table register_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  project_id          uuid not null,
  requirement_id      uuid,                             -- link to the extracted requirement
  title               text not null,
  description         text,
  status              submittal_status not null default 'draft',   -- req f11; default is 'draft', never 'human_approved'
  due_date            date,
  responsible_user_id uuid references users(id),
  consultant_platform_ref text,                         -- external consultant register id (Aconex/Procore/etc.)
  revision            integer not null default 0,
  submitted_at        timestamptz,
  -- Human sign-off metadata (req f12). Populated ONLY by an explicit human action; see guard trigger.
  human_approved_by   uuid references users(id),
  human_approved_at   timestamptz,
  human_approval_note text,
  closed_at           timestamptz,
  created_by          uuid references users(id),
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id)     references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, requirement_id) references submittal_requirements (tenant_id, id) on delete set null,
  -- req f12: the status can only BE human_approved if human actor metadata is present.
  constraint chk_human_approved_requires_actor check (
    status <> 'human_approved'
    or (human_approved_by is not null and human_approved_at is not null)
  )
);
create index idx_register_status on register_items (tenant_id, project_id, status);
create index idx_register_due on register_items (tenant_id, due_date)
  where status not in ('closed', 'cancelled');
create index idx_register_requirement on register_items (tenant_id, requirement_id);
create index idx_register_responsible on register_items (tenant_id, responsible_user_id);

-- req f12 guard: block ANY path (app, default, trigger, system job) from reaching human_approved
-- without an explicit, active, HUMAN approver and a non-system acting principal.
-- SECURITY DEFINER so the human-vs-service check can read users regardless of the caller's RLS view.
create or replace function app.guard_human_approval() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.status = 'human_approved'
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then

    if new.human_approved_by is null or new.human_approved_at is null then
      raise exception 'register_item %: human_approved requires human_approved_by and human_approved_at (req f12)', new.id
        using errcode = 'check_violation';
    end if;

    if not exists (
      select 1 from users u
      where u.id = new.human_approved_by and u.kind = 'human' and u.status = 'active'
    ) then
      raise exception 'human_approved_by must reference an active human user, not a service account (req f12)'
        using errcode = 'check_violation';
    end if;

    if app.current_actor_type() = 'system' then
      raise exception 'a system/service principal cannot set status = human_approved (req f12)'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end$$;

create trigger trg_guard_human_approval
  before insert or update on register_items
  for each row execute function app.guard_human_approval();

-- --- Physical deliverables (req f13) — samples & stamped drawings as line items
create table physical_deliverables (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  register_item_id    uuid not null,
  kind                physical_deliverable_type not null,
  status              physical_deliverable_status not null default 'required',
  description         text,
  quantity            integer check (quantity is null or quantity >= 0),
  tracking_ref        text,
  responsible_user_id uuid references users(id),
  sent_at             timestamptz,
  received_at         timestamptz,
  returned_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (tenant_id, register_item_id) references register_items (tenant_id, id) on delete cascade
);
create index idx_physical_register on physical_deliverables (tenant_id, register_item_id);

-- --- Package assembly (req f10 package items; feature D) ---------------------
create table packages (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  project_id         uuid not null,
  name               text not null,
  status             package_status not null default 'draft',
  assembled_by       uuid references users(id),
  submitted_at       timestamptz,
  output_document_id uuid,                              -- generated package file (doc_type = generated_package)
  consultant_platform_ref text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id)         references projects  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, output_document_id) references documents (tenant_id, id) on delete set null
);
create index idx_packages_project on packages (tenant_id, project_id, status);

create table package_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  package_id       uuid not null,
  register_item_id uuid not null,
  document_id      uuid,                                -- specific file included for this item
  sequence         integer,
  created_at       timestamptz not null default now(),
  unique (package_id, register_item_id),
  foreign key (tenant_id, package_id)       references packages       (tenant_id, id) on delete cascade,
  foreign key (tenant_id, register_item_id) references register_items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id)      references documents      (tenant_id, id) on delete set null
);
create index idx_package_items_package on package_items (tenant_id, package_id);

-- --- Exports (req f3 exports; feature E) ------------------------------------
create table exports (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  project_id         uuid not null,
  package_id         uuid,
  export_type        text not null,                     -- e.g. 'consultant_pdf', 'aconex_push'
  status             export_status not null default 'pending',
  output_document_id uuid,
  destination        text,
  requested_by       uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (tenant_id, project_id)         references projects  (tenant_id, id) on delete cascade,
  foreign key (tenant_id, package_id)         references packages  (tenant_id, id) on delete set null,
  foreign key (tenant_id, output_document_id) references documents (tenant_id, id) on delete set null
);
create index idx_exports_project on exports (tenant_id, project_id);

commit;
