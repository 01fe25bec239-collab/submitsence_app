# Infrastructure operations

| Document | Purpose |
|---|---|
| [deployment-runbook.md](docs/deployment-runbook.md) | Bootstrap, deploy, migrate, roll back, and add DNS |
| [backup-restore-runbook.md](docs/backup-restore-runbook.md) | Backup policy, automated restore tests, and recovery |
| [incident-response-runbook.md](docs/incident-response-runbook.md) | Breach, failed deploy, backlog, and secret compromise |
| [iam.md](docs/iam.md) | Runtime, CI, and human access boundaries |
| [monitoring.md](docs/monitoring.md) | Dashboards, alerts, simulations, and log hygiene |
| [data-residency-checklist.md](docs/data-residency-checklist.md) | Australian-region validation evidence |
| [cost-controls.md](docs/cost-controls.md) | Cost defaults and scaling decisions |
| [qa-compliance-handoff.md](docs/qa-compliance-handoff.md) | Release checks, known gaps, and acceptance evidence |

Scripts are fail-closed and require explicit `AWS_REGION`/`ENVIRONMENT` inputs. None prints secret
values or document content.
