resource "aws_backup_vault" "primary" {
  name        = local.name
  kms_key_arn = aws_kms_key.app.arn
}

resource "aws_backup_vault" "dr" {
  count       = var.enable_dr ? 1 : 0
  provider    = aws.dr
  name        = "${local.name}-dr"
  kms_key_arn = aws_kms_key.dr[0].arn
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role" "restore" {
  name               = "${local.name}-restore-test"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.restore.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "this" {
  name = local.name
  rule {
    rule_name         = "daily-rds"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 13 * * ? *)"
    start_window      = 60
    completion_window = 360
    lifecycle { delete_after = var.environment == "production" ? 35 : 14 }
    dynamic "copy_action" {
      for_each = var.enable_dr ? [1] : []
      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn
        lifecycle { delete_after = 90 }
      }
    }
    recovery_point_tags = merge(local.tags, { Backup = "daily" })
  }
}

resource "aws_backup_selection" "rds" {
  name         = "${local.name}-rds"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.this.id
  resources    = [aws_db_instance.postgres.arn]
}

resource "aws_backup_restore_testing_plan" "monthly" {
  count                        = var.environment == "production" ? 1 : 0
  name                         = replace("${local.name}_monthly", "-", "_")
  schedule_expression          = "cron(0 18 1 * ? *)"
  schedule_expression_timezone = "Australia/Sydney"
  start_window_hours           = 24
  recovery_point_selection {
    algorithm             = "LATEST_WITHIN_WINDOW"
    include_vaults        = [aws_backup_vault.primary.arn]
    recovery_point_types  = ["SNAPSHOT"]
    selection_window_days = 7
  }
}

resource "aws_backup_restore_testing_selection" "rds" {
  count                     = var.environment == "production" ? 1 : 0
  name                      = "rds"
  restore_testing_plan_name = aws_backup_restore_testing_plan.monthly[0].name
  protected_resource_type   = "RDS"
  protected_resource_arns   = [aws_db_instance.postgres.arn]
  iam_role_arn              = aws_iam_role.restore.arn
}
