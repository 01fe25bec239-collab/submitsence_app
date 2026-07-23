resource "random_id" "suffix" { byte_length = 4 }

resource "aws_kms_key" "state" {
  description             = "SubmitSense Terraform state"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "state" {
  name          = "alias/submitsense-terraform-state"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  bucket = "submitsense-terraform-state-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.state.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  deploy_environments = toset(["staging", "production"])
}

data "aws_iam_policy_document" "github_assume" {
  for_each = local.deploy_environments
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${each.key}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  for_each           = local.deploy_environments
  name               = "submitsense-${each.key}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume[each.key].json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid = "SubmitSenseInfrastructure"
    actions = [
      "acm:*", "application-autoscaling:*", "backup:*", "budgets:*", "cloudtrail:*",
      "cognito-idp:*", "ec2:*", "ecr:*", "ecs:*", "elasticloadbalancing:*",
      "events:*", "kms:*", "logs:*", "rds:*", "route53:*", "s3:*",
      "secretsmanager:*", "servicediscovery:*", "sns:*", "wafv2:*"
    ]
    resources = ["*"]
  }
  statement {
    sid = "TerraformCloudWatchManagement"
    actions = [
      "cloudwatch:DeleteAlarms", "cloudwatch:DeleteDashboards", "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmsForMetric", "cloudwatch:GetDashboard", "cloudwatch:ListDashboards",
      "cloudwatch:ListTagsForResource", "cloudwatch:PutDashboard", "cloudwatch:PutMetricAlarm",
      "cloudwatch:SetAlarmState", "cloudwatch:TagResource", "cloudwatch:UntagResource"
    ]
    resources = ["*"]
  }
  statement {
    sid       = "DeploymentMetricVerification"
    actions   = ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"]
    resources = ["*"]
  }
  statement {
    sid = "SubmitSenseRolesOnly"
    actions = [
      "iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRole", "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy", "iam:GetRole", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:PassRole", "iam:PutRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy"
    ]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/submitsense-*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  for_each = local.deploy_environments
  name     = "submitsense-terraform"
  role     = aws_iam_role.github_deploy[each.key].id
  policy   = data.aws_iam_policy_document.github_deploy.json
}

data "aws_iam_policy_document" "github_state" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/submitsense/*"]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.state.arn]
  }
}

resource "aws_iam_role_policy" "github_state" {
  for_each = local.deploy_environments
  name     = "terraform-state"
  role     = aws_iam_role.github_deploy[each.key].id
  policy   = data.aws_iam_policy_document.github_state.json
}
