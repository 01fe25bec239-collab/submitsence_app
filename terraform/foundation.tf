resource "random_id" "suffix" { byte_length = 4 }

module "network" {
  source             = "./modules/network"
  name               = local.name
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
  single_nat_gateway = var.single_nat_gateway
  tags               = local.tags
}

data "aws_iam_policy_document" "logs_kms" {
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.primary_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${var.primary_region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
  statement {
    sid    = "CloudTrail"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey*", "kms:DescribeKey"
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudtrail:${var.primary_region}:${data.aws_caller_identity.current.account_id}:trail/${local.name}"]
    }
  }
}

resource "aws_kms_key" "app" {
  description             = "SubmitSense ${var.environment} application data"
  enable_key_rotation     = true
  deletion_window_in_days = var.environment == "production" ? 30 : 7
  tags                    = { Name = "${local.name}-app" }
}

resource "aws_kms_alias" "app" {
  name          = "alias/${local.name}-app"
  target_key_id = aws_kms_key.app.key_id
}

resource "aws_kms_key" "logs" {
  description             = "SubmitSense ${var.environment} operational logs"
  enable_key_rotation     = true
  deletion_window_in_days = var.environment == "production" ? 30 : 7
  policy                  = data.aws_iam_policy_document.logs_kms.json
  tags                    = { Name = "${local.name}-logs" }
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${local.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

module "storage" {
  source                 = "./modules/storage"
  name                   = "${local.name}-${random_id.suffix.hex}"
  kms_key_arn            = aws_kms_key.app.arn
  force_destroy          = var.force_destroy_buckets
  object_expiration_days = var.object_expiration_days
  log_expiration_days    = var.log_expiration_days
  tags                   = local.tags
}

resource "aws_kms_key" "dr" {
  count                   = var.enable_dr ? 1 : 0
  provider                = aws.dr
  description             = "SubmitSense ${var.environment} disaster-recovery data"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Name = "${local.name}-dr" }
}

resource "aws_kms_alias" "dr" {
  count         = var.enable_dr ? 1 : 0
  provider      = aws.dr
  name          = "alias/${local.name}-dr"
  target_key_id = aws_kms_key.dr[0].key_id
}

module "storage_dr" {
  count                  = var.enable_dr ? 1 : 0
  source                 = "./modules/storage"
  providers              = { aws = aws.dr }
  name                   = "${local.name}-dr-${random_id.suffix.hex}"
  kms_key_arn            = aws_kms_key.dr[0].arn
  force_destroy          = false
  object_expiration_days = var.object_expiration_days
  log_expiration_days    = var.log_expiration_days
  tags                   = merge(local.tags, { DataRegion = var.dr_region, Purpose = "disaster-recovery" })
}

data "aws_iam_policy_document" "s3_replication_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "s3_replication" {
  count              = var.enable_dr ? 1 : 0
  name               = "${local.name}-s3-replication"
  assume_role_policy = data.aws_iam_policy_document.s3_replication_assume.json
}

data "aws_iam_policy_document" "s3_replication" {
  count = var.enable_dr ? 1 : 0
  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [for arn in values(module.storage.bucket_arns) : arn]
  }
  statement {
    actions   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
    resources = [for arn in values(module.storage.bucket_arns) : "${arn}/*"]
  }
  statement {
    actions   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
    resources = [for arn in values(module.storage_dr[0].bucket_arns) : "${arn}/*"]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn, aws_kms_key.dr[0].arn]
  }
}

resource "aws_iam_role_policy" "s3_replication" {
  count  = var.enable_dr ? 1 : 0
  role   = aws_iam_role.s3_replication[0].id
  policy = data.aws_iam_policy_document.s3_replication[0].json
}

resource "aws_s3_bucket_replication_configuration" "dr" {
  for_each = var.enable_dr ? { for key, name in module.storage.bucket_names : key => name if key != "logs" } : {}
  role     = aws_iam_role.s3_replication[0].arn
  bucket   = each.value

  rule {
    id     = "australian-dr"
    status = "Enabled"
    destination {
      bucket        = module.storage_dr[0].bucket_arns[each.key]
      storage_class = "STANDARD_IA"
      encryption_configuration { replica_kms_key_id = aws_kms_key.dr[0].arn }
    }
    source_selection_criteria {
      sse_kms_encrypted_objects { status = "Enabled" }
    }
  }
  depends_on = [aws_iam_role_policy.s3_replication]
}
