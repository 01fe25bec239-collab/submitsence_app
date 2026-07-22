-- Package assembly migration checks. Runs after 0001..0017 + 0099 seed and always rolls back.
\set ON_ERROR_STOP on
begin;

-- Requirement inserts automatically create exactly one draft register row.
insert into submittal_requirements (id, tenant_id, project_id, worksection_id, clause_id, category, title)
values (
  '10101010-1010-4010-8010-101010101010', '11111111-1111-1111-1111-111111111111',
  '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666',
  '77777777-7777-7777-7777-777777777777', 'test_report', 'Submit synthetic test report'
);

do $$
declare n integer;
begin
  select count(*) into n from register_items
   where tenant_id = '11111111-1111-1111-1111-111111111111'
     and requirement_id = '10101010-1010-4010-8010-101010101010'
     and status = 'draft';
  if n <> 1 then raise exception 'FAIL package 1: expected one automatic register row, got %', n; end if;
  raise notice 'PASS package 1: extracted requirement auto-populated one draft register row';
end$$;

insert into packages (id, tenant_id, project_id, name, cover_sheet)
values ('20202020-2020-4020-8020-202020202020', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', 'Synthetic package', '{"companyName":"Test","projectName":"Test","trade":"other"}');
insert into package_items (id, tenant_id, package_id, register_item_id, sequence)
values ('30303030-3030-4030-8030-303030303030', '11111111-1111-1111-1111-111111111111',
        '20202020-2020-4020-8020-202020202020', '99999999-9999-9999-9999-999999999999', 1);
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('40404040-4040-4040-8040-404040404040', '11111111-1111-1111-1111-111111111111', 'package_generation', 'package-sql-test');
insert into package_versions (id, tenant_id, package_id, version_number, generation_job_id)
values ('50505050-5050-4050-8050-505050505050', '11111111-1111-1111-1111-111111111111',
        '20202020-2020-4020-8020-202020202020', 1, '40404040-4040-4040-8040-404040404040');

-- A ready version cannot be published without a generated document and checksum.
do $$
begin
  begin
    update package_versions set status = 'ready' where id = '50505050-5050-4050-8050-505050505050';
    raise exception 'FAIL package 2: ready version accepted without output';
  exception when check_violation then
    raise notice 'PASS package 2: ready version requires output document and checksum';
  end;
end$$;

-- A document from another tenant cannot be attached to a tenant-one package item.
insert into tenants (id, slug, name) values ('60606060-6060-4060-8060-606060606060', 'package-test-other', 'Other tenant');
insert into projects (id, tenant_id, name) values ('70707070-7070-4070-8070-707070707070', '60606060-6060-4060-8060-606060606060', 'Other project');
insert into documents (id, tenant_id, project_id, doc_type, title, storage_bucket, object_key)
values ('80808080-8080-4080-8080-808080808080', '60606060-6060-4060-8060-606060606060',
        '70707070-7070-4070-8070-707070707070', 'attachment', 'Other tenant file', 'test-ap-southeast-2', 'other/file.pdf');

do $$
begin
  begin
    insert into package_item_documents (tenant_id, package_item_id, document_id)
    values ('11111111-1111-1111-1111-111111111111', '30303030-3030-4030-8030-303030303030', '80808080-8080-4080-8080-808080808080');
    raise exception 'FAIL package 3: cross-tenant package attachment accepted';
  exception when foreign_key_violation then
    raise notice 'PASS package 3: cross-tenant package attachment rejected';
  end;
end$$;

insert into packages (id, tenant_id, project_id, name)
values ('90909090-9090-4090-8090-909090909090', '60606060-6060-4060-8060-606060606060',
        '70707070-7070-4070-8070-707070707070', 'Other package');
insert into processing_jobs (id, tenant_id, job_type, idempotency_key)
values ('a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0', '60606060-6060-4060-8060-606060606060', 'package_generation', 'other-package-sql-test');
insert into package_versions (id, tenant_id, package_id, version_number, generation_job_id)
values ('b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0', '60606060-6060-4060-8060-606060606060',
        '90909090-9090-4090-8090-909090909090', 1, 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0');

set local role submitsense_app;
select set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true);
select set_config('app.actor_type', 'human', true);

do $$
declare visible integer; cross_tenant integer;
begin
  select count(*) into visible from package_versions
   where id in ('50505050-5050-4050-8050-505050505050', 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0');
  select count(*) into cross_tenant from package_versions
   where id = 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0';
  if visible <> 1 or cross_tenant <> 0 then
    raise exception 'FAIL package 4: package version RLS visible=% cross_tenant=%', visible, cross_tenant;
  end if;
  raise notice 'PASS package 4: package version RLS isolates tenants';
end$$;

reset role;

-- Composite SET NULL actions clear only the nullable reference, never tenant_id.
insert into documents (id, tenant_id, project_id, doc_type, title, storage_bucket, object_key)
values ('c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', 'attachment', 'Disposable physical reference',
        'test-ap-southeast-2', 'package-test/disposable.pdf');
insert into physical_deliverables (id, tenant_id, register_item_id, kind, attachment_document_id)
values ('d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0', '11111111-1111-1111-1111-111111111111',
        '99999999-9999-9999-9999-999999999999', 'stamped_shop_drawing', 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0');
insert into exports (id, tenant_id, project_id, package_id, export_type, package_version_id)
values ('e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', '20202020-2020-4020-8020-202020202020',
        'consultant_pdf', '50505050-5050-4050-8050-505050505050');

delete from documents where id = 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0';
delete from processing_jobs where id = '40404040-4040-4040-8040-404040404040';
delete from package_versions where id = '50505050-5050-4050-8050-505050505050';

do $$
declare physical_ok boolean; export_ok boolean;
begin
  select tenant_id = '11111111-1111-1111-1111-111111111111' and attachment_document_id is null
    into physical_ok from physical_deliverables where id = 'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0';
  select tenant_id = '11111111-1111-1111-1111-111111111111' and package_version_id is null
    into export_ok from exports where id = 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0';
  if physical_ok is not true or export_ok is not true then
    raise exception 'FAIL package 5: nullable composite references did not clear cleanly';
  end if;
  raise notice 'PASS package 5: nullable composite references preserve tenant_id on delete';
end$$;

-- A job abandoned by a crashed worker is reclaimed under the same idempotency key/version.
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, started_at, lease_token, lease_expires_at)
values ('f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0', '11111111-1111-1111-1111-111111111111',
        'package_generation_recovery_test', 'running', 1, 3, 'stale-package-job-test', now() - interval '16 minutes',
        'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1', now() - interval '1 minute');

do $$
declare claimed uuid; claimed_attempts integer; claimed_status job_status;
begin
  select id into claimed from app.claim_next_job(array['package_generation_recovery_test'], 900);
  select attempts, status into claimed_attempts, claimed_status from processing_jobs where id = claimed;
  if claimed <> 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0' or claimed_attempts <> 2 or claimed_status <> 'running' then
    raise exception 'FAIL package 6: stale package job was not reclaimed safely';
  end if;
  raise notice 'PASS package 6: stale package job is reclaimed for idempotent retry';
end$$;

-- Project deadlines become register due dates in the product's Australian default timezone.
set local timezone = 'UTC';
update projects set submission_deadline = '2030-01-02 00:30:00+11'
 where id = '55555555-5555-5555-5555-555555555555';
insert into submittal_requirements (id, tenant_id, project_id, worksection_id, clause_id, category, title)
values ('12121212-1212-4212-8212-121212121212', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666',
        '77777777-7777-7777-7777-777777777777', 'product_data', 'Timezone boundary requirement');

do $$
declare actual_due date;
begin
  select due_date into actual_due from register_items where requirement_id = '12121212-1212-4212-8212-121212121212';
  if actual_due <> date '2030-01-02' then
    raise exception 'FAIL package 7: Australian deadline became %', actual_due;
  end if;
  raise notice 'PASS package 7: Australian deadline date is stable under a UTC database session';
end$$;

-- A final-attempt crash closes package/export state instead of leaving it generating forever.
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, started_at, worker_output, lease_token, lease_expires_at)
values ('13131313-1313-4313-8313-131313131313', '11111111-1111-1111-1111-111111111111',
        'export_aconex_bundle', 'running', 3, 3, 'exhausted-package-job-test', now() - interval '16 minutes',
        '{"projectId":"55555555-5555-5555-5555-555555555555","packageId":"20202020-2020-4020-8020-202020202020","exportId":"14141414-1414-4414-8414-141414141414"}',
        '13231313-1313-4313-8313-131313131313', now() - interval '1 minute');
insert into package_versions (id, tenant_id, package_id, version_number, generation_job_id)
values ('15151515-1515-4515-8515-151515151515', '11111111-1111-1111-1111-111111111111',
        '20202020-2020-4020-8020-202020202020', 2, '13131313-1313-4313-8313-131313131313');
insert into exports (id, tenant_id, project_id, package_id, export_type)
values ('14141414-1414-4414-8414-141414141414', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', '20202020-2020-4020-8020-202020202020', 'aconex_bundle');
update packages set status = 'assembling' where id = '20202020-2020-4020-8020-202020202020';
select id from app.claim_next_job(array['no_matching_test_job'], 900);

do $$
declare job_state job_status; version_state export_status; export_state export_status; package_state package_status;
begin
  select status into job_state from processing_jobs where id = '13131313-1313-4313-8313-131313131313';
  select status into version_state from package_versions where id = '15151515-1515-4515-8515-151515151515';
  select status into export_state from exports where id = '14141414-1414-4414-8414-141414141414';
  select status into package_state from packages where id = '20202020-2020-4020-8020-202020202020';
  if job_state <> 'failed' or version_state <> 'failed' or export_state <> 'failed' or package_state <> 'draft' then
    raise exception 'FAIL package 8: exhausted lease cleanup job=% version=% export=% package=%', job_state, version_state, export_state, package_state;
  end if;
  raise notice 'PASS package 8: exhausted worker lease closes package and export state';
end$$;

-- A crash after the artifact commit is reconciled as success, not a false failure.
insert into documents (id, tenant_id, project_id, doc_type, title, storage_bucket, object_key, checksum_sha256)
values ('16161616-1616-4616-8616-161616161616', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', 'generated_package', 'Committed package output',
        'test-ap-southeast-2', 'package-test/committed.pdf', repeat('a', 64));
insert into processing_jobs (id, tenant_id, job_type, status, attempts, max_attempts, idempotency_key, started_at, worker_output, lease_token, lease_expires_at)
values ('17171717-1717-4717-8717-171717171717', '11111111-1111-1111-1111-111111111111',
        'package_generation', 'running', 3, 3, 'committed-package-job-test', now() - interval '16 minutes',
        '{"projectId":"55555555-5555-5555-5555-555555555555","packageId":"20202020-2020-4020-8020-202020202020"}',
        '17271717-1717-4717-8717-171717171717', now() - interval '1 minute');
insert into package_versions (id, tenant_id, package_id, version_number, generation_job_id, status, output_document_id, checksum_sha256)
values ('18181818-1818-4818-8818-181818181818', '11111111-1111-1111-1111-111111111111',
        '20202020-2020-4020-8020-202020202020', 3, '17171717-1717-4717-8717-171717171717',
        'ready', '16161616-1616-4616-8616-161616161616', repeat('a', 64));
update packages set status = 'ready', output_document_id = '16161616-1616-4616-8616-161616161616'
 where id = '20202020-2020-4020-8020-202020202020';
select id from app.claim_next_job(array['no_matching_test_job'], 900);

do $$
declare job_state job_status; version_state export_status; package_state package_status;
begin
  select status into job_state from processing_jobs where id = '17171717-1717-4717-8717-171717171717';
  select status into version_state from package_versions where id = '18181818-1818-4818-8818-181818181818';
  select status into package_state from packages where id = '20202020-2020-4020-8020-202020202020';
  if job_state <> 'succeeded' or version_state <> 'ready' or package_state <> 'ready' then
    raise exception 'FAIL package 9: committed artifact reconciliation job=% version=% package=%', job_state, version_state, package_state;
  end if;
  raise notice 'PASS package 9: committed artifact reconciles an abandoned job to succeeded';
end$$;

rollback;
