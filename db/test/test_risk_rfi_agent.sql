begin;

insert into risk_flags (id, tenant_id, project_id, register_item_id, risk_type, severity, summary, evidence, rule_key, risk_score, scoring_version)
values ('f1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', '99999999-9999-9999-9999-999999999999',
        'missing_evidence', 'medium', 'Likely risk: evidence needs reviewer confirmation.',
        '[{"kind":"register_item","id":"99999999-9999-9999-9999-999999999999","label":"Seed register item"}]',
        'test_missing_evidence', 55, 'a4-rules-v1');

do $$
begin
  begin
    insert into risk_flags (tenant_id, project_id, register_item_id, risk_type, severity, evidence, rule_key, risk_score, scoring_version)
    values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
            '99999999-9999-9999-9999-999999999999', 'other', 'low', '[]', 'invalid_score', 101, 'a4-rules-v1');
    raise exception 'FAIL risk 1: score above 100 was accepted';
  exception when check_violation then
    raise notice 'PASS risk 1: risk score is constrained to 0..100';
  end;
end$$;

do $$
begin
  begin
    insert into risk_flags (tenant_id, project_id, register_item_id, risk_type, severity, evidence, rule_key, risk_score, scoring_version)
    values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
            '99999999-9999-9999-9999-999999999999', 'other', 'low', '{}', 'invalid_evidence', 20, 'a4-rules-v1');
    raise exception 'FAIL risk 2: object evidence was accepted';
  exception when check_violation then
    raise notice 'PASS risk 2: risk evidence must be a source-reference array';
  end;
end$$;

do $$
begin
  begin
    insert into risk_flags (tenant_id, project_id, register_item_id, risk_type, severity, evidence, rule_key, risk_score, scoring_version)
    values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
            '99999999-9999-9999-9999-999999999999', 'missing_evidence', 'medium', '[]', 'test_missing_evidence', 55, 'a4-rules-v1');
    raise exception 'FAIL risk 3: duplicate rule flag was accepted';
  exception when unique_violation then
    raise notice 'PASS risk 3: one stable flag exists per item and rule';
  end;
end$$;

insert into checklist_items (tenant_id, register_item_id, risk_flag_id, label)
values ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999',
        'f1000000-0000-4000-8000-000000000001', 'Review source evidence.');

do $$
begin
  begin
    insert into checklist_items (tenant_id, register_item_id, risk_flag_id, label)
    values ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999',
            'f1000000-0000-4000-8000-000000000001', 'Duplicate generated task');
    raise exception 'FAIL risk 4: duplicate generated checklist was accepted';
  exception when unique_violation then
    raise notice 'PASS risk 4: generated checklist is idempotent per flag';
  end;
end$$;

insert into rfi_drafts (id, tenant_id, project_id, register_item_id, source_risk_flag_id, title, body,
                        conflict_type, issue_summary, question, suggested_attachments, created_by)
values ('f2000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555', '99999999-9999-9999-9999-999999999999',
        'f1000000-0000-4000-8000-000000000001', 'Draft RFI - evidence clarification',
        'Prepared for human review.', 'missing_information', 'Evidence is not linked.',
        'Please identify the applicable source document.', '[]', '22222222-2222-2222-2222-222222222222');

do $$
begin
  begin
    insert into rfi_drafts (tenant_id, project_id, title, conflict_type, issue_summary, question, suggested_attachments)
    values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
            'Invalid structured RFI', 'ambiguity', 'Issue', 'Question', '{}');
    raise exception 'FAIL risk 5: object attachment metadata was accepted';
  exception when check_violation then
    raise notice 'PASS risk 5: RFI suggested attachments must be an array';
  end;
end$$;

do $$
declare
  count_rows integer;
begin
  select count(*) into count_rows from rfi_drafts where id = 'f2000000-0000-4000-8000-000000000001'
    and review_status = 'draft' and send_status = 'not_sent' and issue_summary <> '' and question <> '';
  if count_rows <> 1 then raise exception 'FAIL risk 6: generated RFI is not a structured unsent draft'; end if;
  raise notice 'PASS risk 6: RFI remains a structured, unsent human-review draft';
end$$;

rollback;
