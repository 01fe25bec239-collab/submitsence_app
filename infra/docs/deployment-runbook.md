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

The first pipeline run creates ECR repositories before building. For a manual first deployment, set
all desired counts to zero, apply the foundation, push images, run the migration task, then restore
desired counts. This avoids starting the API before the first schema exists.

## Normal deployment

Every pull request runs lint, tests, type checks, Terraform validation, static residency assertions,
dependency audit, and container builds. A successful `main` CI run triggers staging. Production is a
manual workflow that requires an exact tested commit SHA and GitHub environment approval.

The reusable deployment workflow:

1. assumes the environment role through GitHub OIDC;
2. builds three immutable images and pushes them to KMS-encrypted ECR repositories;
3. fails on high/critical ECR scan findings;
4. applies infrastructure and registers task definitions;
5. runs the migration task and requires exit code zero;
6. rolls ECS services to the new revision with circuit-breaker rollback;
7. waits for service stability and checks residency tags.

ECS keeps 100% healthy API/frontend capacity during rolling updates. Workers use a 50% minimum so
long-running work can drain. Job idempotency and the durable database ledger protect retries.

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
4. Wait with `aws ecs wait services-stable`, then verify ALB health, errors, and job failures.
5. Preserve the failed task logs and image digest for investigation.

## Adding a domain later

Create a Route 53 public hosted zone, then set `ROOT_DOMAIN` and `ROUTE53_ZONE_ID` in each GitHub
environment. Terraform creates `app`, `api`, DNS validation records, a Sydney ACM certificate, HTTPS
listeners, and HTTP-to-HTTPS redirect. Until then, staging/production public requests return `503`.

CloudFront is deliberately not enabled: the regional ALB/WAF meets the current protection need without
introducing global edge persistence questions. Add CloudFront only for public static assets after a
documented residency review; never cache tenant documents or authenticated responses.
