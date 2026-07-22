# Monitoring and log hygiene

The CloudWatch dashboard covers ALB request/5xx/latency, RDS CPU/connections, PostgreSQL queue depth
and age, and application failure metrics. GuardDuty and Security Hub severity findings publish to the
same encrypted SNS topic.

## PostgreSQL queue emitter

Every persistent worker runs the same emitter, but exactly one session per database becomes active by
acquiring the non-blocking session advisory lock `pg_try_advisory_lock(1398096461, 7)` on a pinned
PostgreSQL client. Non-leaders release their probe client and retry after 10 seconds. The leader emits
immediately and every 60 seconds. A connection failure releases the PostgreSQL session lock
automatically, allowing another worker to take over.

`app.processing_queue_metrics(text[])` is a `STABLE SECURITY DEFINER` function with a fixed search
path. Runtime calls bind the 11 asynchronous types from the application job registry and execute in a
read-only transaction. The result contains only job type, queue depth, oldest eligible creation time,
and one database observation timestamp—never tenant, project, job, document, error, or lease data.

Eligibility mirrors `app.claim_next_job`: due queued and retrying work plus expired running leases are
included only below `max_attempts`; future retries, live leases, terminal states, unsupported types,
and `package_draft` are excluded. An expired running job whose artifact is already complete can appear
briefly in this read-only snapshot before the claimer reconciles it to succeeded. The emitter performs
no reconciliation writes.

## Metric contract

Both gauges use namespace `SubmitSense/Jobs`, the database `observed_at` timestamp, and standard
resolution:

- `QueueDepth` (`Count`): eligible work count.
- `OldestJobAgeSeconds` (`Seconds`): age of the oldest eligible item, clamped to zero for clock skew.

Each cycle sends one request containing two global datapoints with dimension `Environment`, plus two
datapoints for each asynchronous type with dimensions `Environment` and `JobType` (24 total). Empty
queues and empty job types emit explicit zero values. No customer-specific or worker-specific
dimensions are allowed. Dashboard gauges use `Maximum`.

## Alarms

`QueueDepthHigh` is the backlog alarm. It retains the environment-specific queue thresholds and treats
missing telemetry as `notBreaching`. `QueueMetricsMissing` is the separate dead-man's switch: when
workers are configured, 30 consecutive missing one-minute `QueueDepth` periods alarm because missing
data is breaching while every real value is non-negative. Development configures zero workers, so it
does not create the freshness alarm.

`OldestJobAgeSeconds` is emitted and dashboard-visible. `OldestJobAgeHigh` is intentionally deferred.
It may be added only after staging observations, an owner-approved queue-age SLO, and a threshold
derived from observed data. PB-08 worker autoscaling remains deferred.

## Networking, failure, and rollback

Private subnets have a NAT gateway route, but the worker security group does not permit that path.
Workers therefore reach `PutMetricData` through the private-DNS CloudWatch Monitoring interface
endpoint using the existing endpoint security group and HTTPS egress. The CloudWatch Logs endpoint is
separate and does not serve `PutMetricData`.

Database failures relinquish leadership and suppress only metrics; job processing continues.
CloudWatch calls use the worker's shared abort signal and a 10-second timeout, and failures remain
non-fatal. Shutdown aborts publication and waits for the database read, unlock, client release, and
complete emitter teardown before destroying CloudWatch and closing the pool. During a database or
CloudWatch outage, `QueueMetricsMissing` eventually alarms while `QueueDepthHigh` does not misreport a
backlog. On the first deployment, apply migration 0023 before starting the new workers; the elected
leader publishes its first snapshot immediately. Roll back the worker and migration together; dropping
the function is safe only after old emitters have stopped. A rollback removes telemetry, so the
freshness alarm should be expected to fire
until workers emitting PB-07 are restored or deliberately scaled to zero.

## Staging validation

After the migration and workers deploy, confirm one global and 11 per-type series for each metric,
60-second timestamps, explicit zeros on an empty queue, and `QueueMetricsMissing` in `OK`. Run
`.github/workflows/simulate-alerts.yml` with `staging`: it publishes existing synthetic failure metrics,
creates an isolated temporary freshness alarm on a synthetic environment, verifies missing data moves
it to `ALARM`, publishes a valid zero, verifies recovery to `OK`, and deletes the alarm through a trap.
The script refuses production and does not simulate an age alarm.

CloudTrail uses log-file validation and KMS-encrypted Sydney S3/CloudWatch storage. WAF logs retain only
blocked/counted requests and redact authorization/cookie headers. VPC Flow Logs retain rejected flows.
ECS application logs stay in Sydney and use bounded retention.
