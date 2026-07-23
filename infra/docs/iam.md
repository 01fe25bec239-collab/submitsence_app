# IAM boundaries

| Principal | Allowed surface |
|---|---|
| ECS execution | Pull ECR images, write its log group, decrypt only injected runtime secrets |
| Migration execution | Pull migration image; read RDS master and app-login secrets only |
| API task | Upload/generated S3 objects, application KMS use, SubmitSense custom metrics; no task-protection access |
| OCR/vendor worker | Application S3/KMS, Sydney Textract, custom metrics, and ECS get/update task protection |
| Package/scheduled worker | Application S3/KMS, custom metrics, and ECS get/update task protection |
| GitHub staging/production | OIDC-bound to the exact repository environment; Terraform service actions and `submitsense-*` roles |

No application task receives static AWS access keys. The database allows traffic only from ECS
security groups and is not public. Production ECS Exec is disabled.

Human access should use AWS IAM Identity Center with separate read-only, incident-response, deploy
approval, and break-glass permission sets. Terraform intentionally creates no IAM users or permanent
human keys. Break-glass access requires MFA, dual approval, a short session, and post-use review.

The bootstrap deployment policy is broad across only the AWS services Terraform manages because it
must create and destroy infrastructure. CloudWatch management actions are enumerated; deployment
verification adds only `GetMetricData` and `ListMetrics`. Its trust is narrower: GitHub OIDC, exact
repository, exact environment. Apply an organization permissions boundary/SCP if supplied.
