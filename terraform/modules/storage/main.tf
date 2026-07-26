locals {
  buckets = toset(["uploads", "processed", "packages", "exports", "scratch", "logs"])
}

resource "aws_s3_bucket" "this" {
  for_each      = local.buckets
  bucket        = "${var.name}-${each.key}"
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = "${var.name}-${each.key}", DataClass = each.key == "logs" ? "operational" : "confidential" })
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = var.kms_key_arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each   = aws_s3_bucket.this
  bucket     = each.value.id
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
  }

  dynamic "rule" {
    for_each = each.key == "scratch" ? [1] : []
    content {
      id     = "expire-scratch"
      status = "Enabled"
      filter {}
      expiration { days = 2 }
    }
  }

  dynamic "rule" {
    for_each = each.key == "logs" ? [1] : []
    content {
      id     = "expire-logs"
      status = "Enabled"
      filter {}
      expiration { days = var.log_expiration_days }
    }
  }

  dynamic "rule" {
    for_each = each.key != "scratch" && each.key != "logs" && var.object_expiration_days > 0 ? [1] : []
    content {
      id     = "contract-retention"
      status = "Enabled"
      filter {}
      expiration { days = var.object_expiration_days }
    }
  }
}

data "aws_iam_policy_document" "https_only" {
  for_each = aws_s3_bucket.this
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "https_only" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.https_only[each.key].json
}
