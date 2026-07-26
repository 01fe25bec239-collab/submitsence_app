resource "aws_guardduty_detector" "this" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = { Name = "submitsense-account" }
}

resource "aws_guardduty_detector_feature" "standard" {
  for_each    = toset(["S3_DATA_EVENTS", "EBS_MALWARE_PROTECTION", "RDS_LOGIN_EVENTS"])
  detector_id = aws_guardduty_detector.this.id
  name        = each.value
  status      = "ENABLED"
}

resource "aws_guardduty_detector_feature" "runtime" {
  detector_id = aws_guardduty_detector.this.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  additional_configuration {
    name   = "ECS_FARGATE_AGENT_MANAGEMENT"
    status = "ENABLED"
  }
}

resource "aws_securityhub_account" "this" {
  enable_default_standards  = true
  control_finding_generator = "SECURITY_CONTROL"
  auto_enable_controls      = true
}
