# Australian data-residency checklist

Primary allow-list: `ap-southeast-2`; DR allow-list: `ap-southeast-4`.

- [x] Terraform variable validation rejects any other primary/DR region.
- [x] RDS, Redis, ECS, ECR, S3, Cognito, KMS, Secrets Manager, WAF, CloudWatch, GuardDuty, and Security
  Hub are provisioned in Sydney.
- [x] RDS and Redis are private and encrypted in transit/at rest.
- [x] Production RDS backup copies and S3 replicas target Melbourne only.
- [x] CloudTrail, WAF, VPC, and application logs persist in Sydney only.
- [x] OCR permissions are restricted to Sydney Textract.
- [x] Confidential-document workers have no general internet egress; they reach AWS interface/S3
  endpoints, RDS, and Redis only.
- [x] Integration egress is isolated to its own service and must remain disabled until processor review.
- [x] No CloudFront/customer-object edge cache is enabled.
- [ ] Run `infra/scripts/residency-check.sh` in each provisioned region and attach output to release evidence.
- [ ] Review every external integration/OCR/LLM processor for AU processing, DPA, retention, subprocessors,
  no-training terms, and breach SLA before enabling it.
- [ ] Confirm AWS account-level services do not export findings/logs to a non-AU organization sink.

Any failed or unknown item blocks production launch.
