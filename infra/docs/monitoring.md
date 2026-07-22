# Monitoring and log hygiene

The CloudWatch dashboard covers ALB request/5xx/latency, RDS CPU/connections, Redis CPU/memory, queue
depth, and application failure metrics. Alarms cover unhealthy API targets, 5xx, database storage/CPU,
Redis pressure, object growth, job/OCR/package/auth/integration failures, and queue depth. GuardDuty and
Security Hub severity findings publish to the same encrypted SNS topic.

Application metrics use namespace `SubmitSense/Jobs` and dimension `Environment`. Emit counts and
opaque IDs only—never filenames, document text, clause text, tokens, email addresses, or request bodies.
Until BullMQ instrumentation is wired, `QueueDepth` must be emitted by a scheduled database-ledger
poller; missing queue-depth data alarms by design.

Run `.github/workflows/simulate-alerts.yml` in staging after confirming the SNS subscription. It emits
one of each failure metric. Record notification arrival and alarm recovery. Do not simulate against
production without the incident owner's approval.

CloudTrail uses log-file validation and KMS-encrypted Sydney S3/CloudWatch storage. WAF logs retain only
blocked/counted requests and redact authorization/cookie headers. VPC Flow Logs retain rejected flows.
ECS application logs stay in Sydney and use bounded retention.
