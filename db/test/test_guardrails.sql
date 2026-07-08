-- test_guardrails.sql
-- Runnable self-check for the compliance-critical guardrails. Run against a freshly migrated +
-- seeded database (see db/README.md). Prints PASS notices; RAISES and aborts on any FAIL.
-- Wrapped in a single transaction that ROLLS BACK at the end, so it leaves the DB unchanged.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_guardrails.sql
--
-- Fixture ids come from 0099_seed.sql.
-- NOTE: test 7 issues SET ROLE submitsense_app, so run this as a superuser or as a role that is a
-- member of submitsense_app (a dev/test superuser connection satisfies this).

\set ON_ERROR_STOP on
begin;

-- 1. human_approved WITHOUT approver metadata is rejected (req f12).
do $$
begin
  begin
    update register_items set status = 'human_approved'
     where id = '99999999-9999-9999-9999-999999999999';
    raise exception 'FAIL 1: human_approved without approver was allowed';
  exception when check_violation then
    raise notice 'PASS 1: human_approved without approver rejected';
  end;
end$$;

-- 2. human_approved by a SERVICE ACCOUNT is rejected (req f12).
do $$
begin
  begin
    perform set_config('app.actor_type', 'human', true);
    update register_items
       set status = 'human_approved',
           human_approved_by = '44444444-4444-4444-4444-444444444444',  -- service account
           human_approved_at = now()
     where id = '99999999-9999-9999-9999-999999999999';
    raise exception 'FAIL 2: service account was allowed to human_approve';
  exception when check_violation then
    raise notice 'PASS 2: service-account human_approve rejected';
  end;
end$$;

-- 3. human_approved by a SYSTEM principal is rejected even with a valid human approver (req f12).
do $$
begin
  begin
    perform set_config('app.actor_type', 'system', true);
    update register_items
       set status = 'human_approved',
           human_approved_by = '33333333-3333-3333-3333-333333333333',  -- human reviewer
           human_approved_at = now()
     where id = '99999999-9999-9999-9999-999999999999';
    raise exception 'FAIL 3: system principal was allowed to human_approve';
  exception when check_violation then
    raise notice 'PASS 3: system-principal human_approve rejected';
  end;
end$$;

-- 4. HAPPY PATH: human reviewer + non-system actor succeeds AND writes an immutable sign-off event.
do $$
declare n int;
begin
  perform set_config('app.actor_type', 'human', true);
  perform set_config('app.user_id', '33333333-3333-3333-3333-333333333333', true);
  update register_items
     set status = 'human_approved',
         human_approved_by = '33333333-3333-3333-3333-333333333333',
         human_approved_at = now()
   where id = '99999999-9999-9999-9999-999999999999';
  select count(*) into n from audit_events
   where event_type = 'human_signoff'
     and entity_id = '99999999-9999-9999-9999-999999999999';
  if n >= 1 then raise notice 'PASS 4: human sign-off succeeded and audit event recorded';
  else raise exception 'FAIL 4: sign-off did not produce an audit event';
  end if;
end$$;

-- 5. CROSS-TENANT product match is impossible (req f15). Build a 2nd tenant's product,
--    then try to match tenant A's register item to tenant B's product.
do $$
begin
  insert into tenants (id, slug, name)
    values ('20000000-0000-0000-0000-000000000002', 'other', 'Other Co');
  insert into vendors (id, tenant_id, name)
    values ('20000000-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-000000000002', 'Rival Supplies');
  insert into products (id, tenant_id, vendor_id, name)
    values ('20000000-0000-0000-0000-0000000000c2', '20000000-0000-0000-0000-000000000002',
            '20000000-0000-0000-0000-0000000000b2', 'Rival Hydrant');
  begin
    insert into product_matches (tenant_id, register_item_id, product_id, decision)
      values ('11111111-1111-1111-1111-111111111111',       -- tenant A
              '99999999-9999-9999-9999-999999999999',       -- tenant A register item
              '20000000-0000-0000-0000-0000000000c2',        -- tenant B product
              'pending');
    raise exception 'FAIL 5: cross-tenant product match was allowed';
  exception when foreign_key_violation then
    raise notice 'PASS 5: cross-tenant product match rejected';
  end;
end$$;

-- 6. audit_events is append-only: UPDATE and DELETE are blocked (req f22).
do $$
begin
  begin
    update audit_events set summary = 'tampered' where true;
    raise exception 'FAIL 6a: audit UPDATE was allowed';
  exception when sqlstate '0LP01' then
    raise notice 'PASS 6a: audit UPDATE blocked';
  end;
  begin
    delete from audit_events where true;
    raise exception 'FAIL 6b: audit DELETE was allowed';
  exception when sqlstate '0LP01' then
    raise notice 'PASS 6b: audit DELETE blocked';
  end;
end$$;

-- 7. RLS isolates tenants for the runtime role (req NFR2). Run AS submitsense_app.
set role submitsense_app;
do $$
declare visible int; other int;
begin
  perform set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into visible from projects;
  perform set_config('app.tenant_id', '20000000-0000-0000-0000-000000000002', true);
  select count(*) into other from projects;
  if visible >= 1 and other = 0 then
    raise notice 'PASS 7: RLS isolates projects (visible=% cross-tenant=%)', visible, other;
  else
    raise exception 'FAIL 7: RLS leak (visible=% cross-tenant=%)', visible, other;
  end if;
end$$;
reset role;

-- 8. Public content cannot be published while flagged as containing uncleared NATSPEC text (NFR6).
do $$
begin
  begin
    insert into knowledge_base_articles (slug, title, publication_state, contains_natspec_text, natspec_copyright_cleared, reviewer_id)
      values ('bad-article', 'Copyrighted', 'published', true, false, '33333333-3333-3333-3333-333333333333');
    raise exception 'FAIL 8: published uncleared NATSPEC content';
  exception when check_violation then
    raise notice 'PASS 8: publish of uncleared NATSPEC content rejected';
  end;
end$$;

rollback;  -- leave the database exactly as seeded
