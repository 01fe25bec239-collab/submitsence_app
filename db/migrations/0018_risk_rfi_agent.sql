-- 0018_risk_rfi_agent.sql
-- A4-A5 deterministic rejection-risk checks and review-only RFI drafts.

begin;

alter table risk_flags
  add column rule_key text,
  add column risk_score smallint,
  add column scoring_version text,
  add column generation_job_id uuid;

update risk_flags
   set rule_key = 'legacy:' || id::text,
       risk_score = case severity when 'critical' then 90 when 'high' then 75 when 'medium' then 50 else 25 end,
       scoring_version = 'legacy'
 where rule_key is null;

alter table risk_flags
  alter column rule_key set not null,
  alter column risk_score set not null,
  alter column scoring_version set not null,
  add constraint chk_risk_score_range check (risk_score between 0 and 100),
  add constraint chk_risk_evidence_array check (jsonb_typeof(evidence) = 'array'),
  add constraint fk_risk_generation_job
    foreign key (tenant_id, generation_job_id) references processing_jobs (tenant_id, id) on delete set null (generation_job_id);

create unique index uq_risk_flag_rule
  on risk_flags (tenant_id, project_id, register_item_id, rule_key)
  where register_item_id is not null;
create index idx_risk_generation_job on risk_flags (tenant_id, generation_job_id) where generation_job_id is not null;

create unique index uq_generated_checklist_flag
  on checklist_items (tenant_id, risk_flag_id)
  where risk_flag_id is not null;

alter table rfi_drafts
  add column source_risk_flag_id uuid,
  add column generation_job_id uuid,
  add column issue_summary text,
  add column question text,
  add column suggested_attachments jsonb not null default '[]'::jsonb;

update rfi_drafts
   set issue_summary = coalesce(nullif(body, ''), title),
       question = coalesce(nullif(body, ''), 'Please clarify the referenced requirement.')
 where issue_summary is null or question is null;

alter table rfi_drafts
  alter column issue_summary set not null,
  alter column question set not null,
  add constraint chk_rfi_suggested_attachments_array check (jsonb_typeof(suggested_attachments) = 'array'),
  add constraint fk_rfi_source_risk
    foreign key (tenant_id, source_risk_flag_id) references risk_flags (tenant_id, id) on delete set null (source_risk_flag_id),
  add constraint fk_rfi_generation_job
    foreign key (tenant_id, generation_job_id) references processing_jobs (tenant_id, id) on delete set null (generation_job_id),
  add constraint uq_rfi_generation_job unique (generation_job_id);

create index idx_rfi_source_risk on rfi_drafts (tenant_id, source_risk_flag_id) where source_risk_flag_id is not null;

commit;
