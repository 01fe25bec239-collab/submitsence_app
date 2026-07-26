output "state_bucket" { value = aws_s3_bucket.state.id }
output "deploy_role_arns" { value = { for environment, role in aws_iam_role.github_deploy : environment => role.arn } }
