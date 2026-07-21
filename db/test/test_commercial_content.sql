-- E13-E14 focused checks. Run after all forward migrations and 0099_seed.sql.
begin;

insert into worksections (id, tenant_id, project_id, code, title) values
  ('66666666-6666-6666-6666-666666666667','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555','0712','Test 2'),
  ('66666666-6666-6666-6666-666666666668','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555','0713','Test 3'),
  ('66666666-6666-6666-6666-666666666669','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555','0714','Test 4');

set role submitsense_app;
select set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
select set_config('app.user_id','22222222-2222-2222-2222-222222222222',true);
select set_config('app.actor_type','human',true);
select * from app.claim_trial_worksection('55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666');
select * from app.claim_trial_worksection('55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666667');
select * from app.claim_trial_worksection('55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666668');
do $$
begin
  begin
    perform * from app.claim_trial_worksection('55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666669');
    raise exception 'FAIL: fourth trial worksection was accepted';
  exception when check_violation then
    raise notice 'PASS: trial stops at three distinct worksections';
  end;
end$$;
reset role;

insert into invoices (tenant_id,number,status,subtotal_cents,tax_cents,total_cents,gst_rate,tax_label)
values ('11111111-1111-1111-1111-111111111111','TEST-GST','open',10000,1000,11000,0.1000,'GST');
do $$
begin
  if exists (select 1 from invoices where number='TEST-GST' and tax_cents=1000 and total_cents=11000 and tax_label='GST') then
    raise notice 'PASS: GST invoice metadata is retained';
  else raise exception 'FAIL: GST invoice metadata'; end if;
end$$;

insert into billing_webhook_events (tenant_id,provider,provider_event_id,event_type)
values ('11111111-1111-1111-1111-111111111111','stripe','evt_test','invoice.paid');
do $$
begin
  begin
    insert into billing_webhook_events (tenant_id,provider,provider_event_id,event_type)
    values ('11111111-1111-1111-1111-111111111111','stripe','evt_test','invoice.paid');
    raise exception 'FAIL: duplicate webhook accepted';
  exception when unique_violation then
    raise notice 'PASS: billing webhook event IDs are idempotent';
  end;
end$$;

do $$
begin
  begin
    insert into knowledge_base_articles
      (slug,title,body,publication_state,reviewer_id,contains_natspec_text,original_wording_confirmed)
    values ('unsafe-public','Unsafe','Original summary','published','33333333-3333-3333-3333-333333333333',false,false);
    raise exception 'FAIL: unconfirmed public content accepted';
  exception when check_violation then
    raise notice 'PASS: publishing requires original-wording confirmation';
  end;
end$$;

insert into knowledge_base_articles
  (slug,title,body,publication_state,reviewer_id,contains_natspec_text,original_wording_confirmed,published_at)
values
  ('safe-public','Safe','Original guidance','published','33333333-3333-3333-3333-333333333333',false,true,now()),
  ('private-draft','Draft','Not public','draft',null,false,false,null);

set role submitsense_app;
select set_config('app.user_id','',true);
do $$
declare public_count integer; private_count integer;
begin
  select count(*) into public_count from knowledge_base_articles where slug='safe-public';
  select count(*) into private_count from knowledge_base_articles where slug='private-draft';
  if public_count=1 and private_count=0 then
    raise notice 'PASS: public readers cannot see drafts';
  else raise exception 'FAIL: public/private content separation'; end if;
end$$;
reset role;

update plans set is_active=false where key='trial';
set role submitsense_app;
select set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
select set_config('app.user_id','22222222-2222-2222-2222-222222222222',true);
select set_config('app.actor_type','human',true);
do $$
begin
  if (select count(*) from tenant_subscriptions s join plans p on p.id=s.plan_id where s.tenant_id=app.current_tenant_id())=1 then
    perform * from app.claim_trial_worksection('55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666');
    raise notice 'PASS: deactivated plans remain readable to existing subscribers';
  else raise exception 'FAIL: deactivated plan broke an existing subscription'; end if;
end$$;
reset role;
update plans set is_active=true where key='trial';

insert into platform_admins (user_id,can_manage_pricing,can_manage_content)
values ('22222222-2222-2222-2222-222222222222',true,true);
set role submitsense_app;
select set_config('app.user_id','22222222-2222-2222-2222-222222222222',true);
update plans set description=description where key='starter';
insert into audit_events (event_type,actor_user_id,actor_type,entity_type,entity_id,action,summary)
values ('admin_action','22222222-2222-2222-2222-222222222222','human','plan',
        (select id from plans where key='starter'),'pricing_test','Pricing test');
do $$
begin
  if exists (select 1 from audit_events where action='pricing_test' and tenant_id is null) then
    raise notice 'PASS: platform commercial administration is explicit and auditable';
  else raise exception 'FAIL: platform commercial administration'; end if;
end$$;
reset role;

rollback;
