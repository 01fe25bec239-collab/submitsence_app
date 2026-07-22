data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.app_database.arn,
      aws_secretsmanager_secret.redis.arn,
      aws_secretsmanager_secret.auth.arn,
      aws_secretsmanager_secret.billing.arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name   = "runtime-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution_secrets.json
}

resource "aws_iam_role" "migration_execution" {
  name               = "${local.name}-migration-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "migration_execution" {
  role       = aws_iam_role.migration_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "migration_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_db_instance.postgres.master_user_secret[0].secret_arn,
      aws_secretsmanager_secret.app_database.arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }
}

resource "aws_iam_role_policy" "migration_secrets" {
  name   = "migration-secrets"
  role   = aws_iam_role.migration_execution.id
  policy = data.aws_iam_policy_document.migration_secrets.json
}

resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "ListApplicationBuckets"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [module.storage.bucket_arns.uploads, module.storage.bucket_arns.packages, module.storage.bucket_arns.exports]
  }
  statement {
    sid       = "UploadAndGeneratedObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${module.storage.bucket_arns.uploads}/*", "${module.storage.bucket_arns.packages}/*", "${module.storage.bucket_arns.exports}/*"]
  }
  statement {
    sid       = "ApplicationKms"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.app.arn]
  }
  statement {
    sid       = "OperationalMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["SubmitSense/Jobs"]
    }
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "application-runtime"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

resource "aws_iam_role" "worker_task" {
  for_each           = local.worker_services
  name               = "${local.name}-${each.key}-worker"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  for_each = local.worker_services
  statement {
    sid       = "ApplicationBucketList"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = values(module.storage.bucket_arns)
  }
  statement {
    sid       = "ApplicationObjects"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:AbortMultipartUpload"]
    resources = [for arn in values(module.storage.bucket_arns) : "${arn}/*"]
  }
  statement {
    sid       = "ApplicationKms"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.app.arn]
  }
  statement {
    sid       = "OperationalMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["SubmitSense/Jobs"]
    }
  }
  dynamic "statement" {
    for_each = contains(["ocr", "vendor"], each.key) ? [1] : []
    content {
      sid       = "AustralianTextract"
      actions   = ["textract:AnalyzeDocument", "textract:DetectDocumentText", "textract:GetDocumentAnalysis", "textract:StartDocumentAnalysis"]
      resources = ["*"]
      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.primary_region]
      }
    }
  }
  dynamic "statement" {
    for_each = each.key == "integration" ? [1] : []
    content {
      sid       = "ApprovedIntegrationSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [aws_secretsmanager_secret.integrations.arn]
    }
  }
}

resource "aws_iam_role_policy" "worker_task" {
  for_each = local.worker_services
  name     = "${each.key}-runtime"
  role     = aws_iam_role.worker_task[each.key].id
  policy   = data.aws_iam_policy_document.worker_task[each.key].json
}
