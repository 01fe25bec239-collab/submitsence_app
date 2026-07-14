begin;

drop index if exists idx_rfi_source_risk;
drop index if exists uq_generated_checklist_flag;
drop index if exists idx_risk_generation_job;
drop index if exists uq_risk_flag_rule;

alter table rfi_drafts
  drop constraint if exists uq_rfi_generation_job,
  drop constraint if exists fk_rfi_generation_job,
  drop constraint if exists fk_rfi_source_risk,
  drop constraint if exists chk_rfi_suggested_attachments_array,
  drop column if exists suggested_attachments,
  drop column if exists question,
  drop column if exists issue_summary,
  drop column if exists generation_job_id,
  drop column if exists source_risk_flag_id;

alter table risk_flags
  drop constraint if exists fk_risk_generation_job,
  drop constraint if exists chk_risk_evidence_array,
  drop constraint if exists chk_risk_score_range,
  drop column if exists generation_job_id,
  drop column if exists scoring_version,
  drop column if exists risk_score,
  drop column if exists rule_key;

commit;
