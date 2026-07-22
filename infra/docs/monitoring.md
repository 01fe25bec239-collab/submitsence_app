# Monitoring and log hygiene

The CloudWatch dashboard covers ALB request/5xx/latency, RDS CPU/connections, queue depth, and
application failure metrics. Alarms cover unhealthy API targets, 5xx, database storage/CPU, object
growth, job/OCR/package/auth/integration failures, and queue depth. GuardDuty and Security Hub severity
findings publish to the same encrypted SNS topic.

Application metrics use namespace `SubmitSense/Jobs` and dimension `Environment`. Emit counts and
opaque IDs only—never filenames, document text, clause text, tokens, email addresses, or request bodies.
PostgreSQL `processing_jobs` is the authoritative queue. Implementing its `QueueDepth` emission is
deferred to PB-07; worker autoscaling from that metric is deferred to PB-08. Missing queue-depth data
alarms by design until PB-07 is complete.

Run `.github/workflows/simulate-alerts.yml` in staging after confirming the SNS subscription. It emits
one of each failure metric. Record notification arrival and alarm recovery. Do not simulate against
production without the incident owner's approval.

CloudTrail uses log-file validation and KMS-encrypted Sydney S3/CloudWatch storage. WAF logs retain only
blocked/counted requests and redact authorization/cookie headers. VPC Flow Logs retain rejected flows.
ECS application logs stay in Sydney and use bounded retention.
