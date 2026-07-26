# Deployment runbook

## One-time setup

1. Apply `terraform/bootstrap` locally and record its state-bucket and staging/production role outputs.
2. Create protected GitHub environments named `staging` and `production`. Require a human reviewer
   for production.
3. Add environment variables `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`, `ALARM_EMAIL`,
   `TERMS_VERSION`, and `PRIVACY_VERSION`. Keep `ROOT_DOMAIN` and `ROUTE53_ZONE_ID` empty until a
   domain exists.
4. Confirm the alarm-topic email subscription in AWS.
5. Populate versioned legal inputs only after approval: `terms_version` and `privacy_version`.

The first pipeline run creates ECR repositories before building. For a manual first deployment, apply
the reviewed tfvars baseline, push images, run the in-VPC database-capacity task, run migrations, then
explicitly set desired counts within the registered Application Auto Scaling bounds. Do not edit
Terraform desired counts to chase runtime scaling: Terraform ignores them after bootstrap.

## Normal deployment

Every pull request runs lint, tests, type checks, Terraform validation, static residency assertions,
dependency audit, and container builds. A successful `main` CI run triggers staging. Production is a
manual workflow that requires an exact tested commit SHA and GitHub environment approval.

The reusable deployment workflow:

1. assumes the environment role through GitHub OIDC;
2. builds three immutable images and pushes them to KMS-encrypted ECR repositories;
3. fails on high/critical ECR scan findings;
4. applies infrastructure and registers task definitions;
5. runs `dist/ops/check-db-capacity.js` in the VPC and requires the live database to satisfy the
   20%-reserve connection budget;
6. runs the migration task and requires exit code zero;
7. records prior task definitions, rolls API and frontend with 15-minute bounds, then OCR/vendor/package
   together and scheduled last with 120-minute bounds;
8. polls deployment state, desired/running/pending counts, events, and task protection instead of using
   the unbounded standard waiter; `DEPLOYMENT_BLOCKED`, failed rollout, or timeout triggers diagnostics
   and reverse-order rollback without force-stopping protected work;
9. verifies PB-07 metrics, the eight worker scaling alarms, the freshness alarm, and residency tags.

ECS keeps 100% healthy capacity during all rolling updates and may use 200% while replacing tasks.
Workers have a 120-second stop timeout. Their task protection is renewed after every successful
database lease heartbeat; a first signal stops claims and metrics while the active handler and
heartbeat finish, and the 110-second hard deadline suppresses stale terminal writes before exit.

Application API abuse protection is process-local. It is not a strict distributed quota and does not
use Redis. Treat it as a bounded safety control; introduce a shared limiter only from measured need and
a separately reviewed architecture.

## Manual all-zero recovery

The scheduled pool has an autoscaling minimum of one, but an operator can manually set the ECS service
to zero and leave every PB-07 emitter absent. Missing metrics do not trigger worker scaling:
`QueueMetricsMissing` alarms after 30 missing one-minute periods. Restore the anchor with
`aws ecs update-service --cluster CLUSTER --service worker-scheduled --desired-count 1`, verify a
fresh global and per-`JobType` `QueueDepth` sample, and let Application Auto Scaling resume control.
Do not add `FILL` to alarms or use queue age as a scaling signal.

## Database migrations

`infra/scripts/migrate.sh` applies forward migrations once, excluding `*.down.sql`, then creates or
rotates the non-owner runtime login. Migrations run as the RDS managed master; API/workers use only
`submitsense_runtime` in role `submitsense_app`.

Production migrations must be expand/contract compatible with the currently running application.
Take a manual snapshot before a destructive change. Roll back the application first; use a reviewed
down migration only when forward repair is unsafe. Never run application traffic as the master user.

## Application rollback

1. Stop the workflow if still running.
2. Find the last healthy task-definition revision in ECS deployment history.
3. Run `aws ecs update-service --cluster CLUSTER --service SERVICE --task-definition FAMILY:REVISION`.
4. Use the bounded deployment poller from `_deploy.yml`, then verify ALB health, errors, and job failures.
5. Preserve the failed task logs and image digest for investigation.

## Adding a domain later

Create a Route 53 public hosted zone, then set `ROOT_DOMAIN` and `ROUTE53_ZONE_ID` in each GitHub
environment. Terraform creates `app`, `api`, DNS validation records, a Sydney ACM certificate, HTTPS
listeners, and HTTP-to-HTTPS redirect. Until then, staging/production public requests return `503`.

CloudFront is deliberately not enabled: the regional ALB/WAF meets the current protection need without
introducing global edge persistence questions. Add CloudFront only for public static assets after a
documented residency review; never cache tenant documents or authenticated responses.
