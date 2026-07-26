output "aws_region" { value = var.primary_region }
output "launch_status" { value = local.has_domain ? "HTTPS enabled" : "Public launch blocked until domain and Route53 zone are supplied" }
output "alb_dns_name" { value = aws_lb.this.dns_name }
output "app_url" { value = local.has_domain ? "https://${local.app_domain}" : null }
output "api_url" { value = local.has_domain ? "https://${local.api_domain}/api/v1" : null }
output "ecs_cluster_name" { value = aws_ecs_cluster.this.name }
output "api_service_name" { value = aws_ecs_service.api.name }
output "frontend_service_name" { value = aws_ecs_service.frontend.name }
output "worker_service_names" { value = { for name, service in aws_ecs_service.worker : name => service.name } }
output "api_task_family" { value = aws_ecs_task_definition.api.family }
output "frontend_task_family" { value = aws_ecs_task_definition.frontend.family }
output "worker_task_families" { value = { for name, task in aws_ecs_task_definition.worker : name => task.family } }
output "ecs_service_names" {
  value = concat(
    [aws_ecs_service.frontend.name, aws_ecs_service.api.name],
    [for service in aws_ecs_service.worker : service.name]
  )
}
output "migration_task_family" { value = aws_ecs_task_definition.migrations.family }
output "db_capacity_check_task_family" { value = aws_ecs_task_definition.db_capacity_check.family }
output "private_subnet_ids" { value = module.network.private_subnet_ids }
output "worker_security_group_id" { value = aws_security_group.worker_tasks.id }
output "ecr_repository_urls" { value = { for key, repository in aws_ecr_repository.this : key => repository.repository_url } }
output "bucket_names" { value = module.storage.bucket_names }
output "database_endpoint" { value = aws_db_instance.postgres.endpoint }
output "cognito_user_pool_id" { value = aws_cognito_user_pool.this.id }
output "cognito_client_id" { value = aws_cognito_user_pool_client.web.id }
output "alarm_topic_arn" { value = aws_sns_topic.alarms.arn }
output "dashboard_name" { value = aws_cloudwatch_dashboard.this.dashboard_name }
output "pb08_connection_budget" {
  value = {
    planned_max = local.planning_max_connections
    usable      = local.usable_connections
    required    = local.required_connections
  }
}
