# Cost controls

- Dev uses one NAT gateway, small RDS, zero always-on workers, and short logs.
- Staging uses one NAT gateway and Fargate Spot workers; production uses one NAT per AZ and on-demand
  Fargate for availability.
- ECR keeps 30 immutable deploys. S3 aborts incomplete multipart uploads and expires scratch after two
  days; customer-object expiry remains disabled until retention periods are approved.
- RDS storage autoscaling has a hard maximum. ECS API autoscaling is capped at 3 outside production
  and 10 in production.
- Per-environment AWS Budgets notify at forecasted 80% and actual 100%; adjust USD limits after the
  first month of measured use.

Largest baseline costs are NAT gateways, production Multi-AZ RDS, WAF rules, GuardDuty, and VPC
endpoints. Do not remove encryption, private networking, backups, WAF, or security monitoring
to save cost. First reduce idle non-production desired counts and schedule non-production uptime.
