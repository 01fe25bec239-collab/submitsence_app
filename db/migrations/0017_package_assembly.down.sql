begin;

drop trigger if exists trg_requirement_register on submittal_requirements;
drop function if exists app.populate_register_item();
drop index if exists uq_register_requirement;
drop index if exists idx_physical_deliverables_due;
drop index if exists idx_package_item_documents_item;
drop index if exists idx_package_versions_package;

alter table exports
  drop constraint if exists chk_export_metadata_object,
  drop constraint if exists fk_export_package_version,
  drop column if exists error_message,
  drop column if exists metadata,
  drop column if exists package_version_id;

drop table if exists package_item_documents;
drop table if exists package_versions;

alter table processing_jobs drop constraint if exists uq_processing_jobs_tenant_id;

alter table register_items
  drop column if exists consultant_response_at,
  drop column if exists consultant_response_ref;

alter table physical_deliverables
  drop constraint if exists fk_physical_attachment,
  drop column if exists attachment_document_id,
  drop column if exists notes,
  drop column if exists due_date;

alter table package_items
  drop constraint if exists uq_package_items_tenant_id,
  drop column if exists manual_notes,
  drop column if exists included;

alter table packages
  drop constraint if exists chk_package_cover_sheet_object,
  drop column if exists current_version,
  drop column if exists manual_notes,
  drop column if exists cover_sheet;

alter table tenants
  drop constraint if exists chk_tenant_branding_object,
  drop column if exists branding;

-- Restore the 0016 claimer without the package-worker lease recovery added by 0017.
create or replace function app.claim_next_job(p_job_types text[] default null)
  returns table (id uuid, tenant_id uuid, job_type text, document_id uuid, worker_output jsonb)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  return query
  update processing_jobs j
     set status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
   where j.id = (
     select jj.id
       from processing_jobs jj
      where jj.status in ('queued', 'retrying')
        and jj.attempts < jj.max_attempts
        and (p_job_types is null or jj.job_type = any (p_job_types))
      order by jj.created_at
      for update skip locked
      limit 1
   )
  returning j.id, j.tenant_id, j.job_type, j.document_id, j.worker_output;
end$$;

commit;
