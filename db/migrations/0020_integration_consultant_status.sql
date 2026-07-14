-- Keep the platform's consultant outcome separate from SubmitSense human sign-off.
begin;

alter table register_items
  add column consultant_status text,
  add constraint chk_register_consultant_status
    check (consultant_status is null or consultant_status in ('submitted', 'approved', 'revise_and_resubmit', 'rejected'));

commit;
