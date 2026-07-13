-- 0016_job_claim.down.sql — reverse 0016.
begin;
drop function if exists app.claim_next_job(text[]);
commit;
