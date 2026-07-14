begin;

alter table register_items
  drop constraint if exists chk_register_consultant_status,
  drop column if exists consultant_status;

commit;
