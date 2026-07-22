resource "aws_ecr_repository" "this" {
  for_each             = toset(["backend", "frontend", "migrations"])
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.app.arn
  }
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({ rules = [{
    rulePriority = 1
    description  = "Keep the latest 30 immutable deploys"
    selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
    action       = { type = "expire" }
  }] })
}

resource "aws_cloudwatch_log_group" "ecs" {
  for_each          = toset(concat(["frontend", "api", "migrations"], [for key in keys(local.worker_services) : "worker-${key}"]))
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.environment == "production" ? 90 : 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "Public web entrypoint"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = local.has_domain ? 1 : 0
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.app_tasks.id
}

resource "aws_security_group" "app_tasks" {
  name_prefix = "${local.name}-app-"
  description = "Frontend and API Fargate tasks"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.app_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "tasks_internal_api" {
  security_group_id            = aws_security_group.app_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.app_tasks.id
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.app_tasks.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "tasks_internal_api" {
  security_group_id            = aws_security_group.app_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.app_tasks.id
}

resource "aws_security_group" "worker_tasks" {
  name_prefix = "${local.name}-workers-"
  description = "Document workers restricted to AU AWS endpoints and data stores"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-workers" }
}

resource "aws_vpc_security_group_egress_rule" "workers_endpoints" {
  security_group_id            = aws_security_group.worker_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = module.network.endpoint_security_group_id
}

data "aws_prefix_list" "s3" { name = "com.amazonaws.${var.primary_region}.s3" }

resource "aws_vpc_security_group_egress_rule" "workers_s3" {
  security_group_id = aws_security_group.worker_tasks.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_prefix_list.s3.id
}

resource "aws_vpc_security_group_egress_rule" "workers_dns_udp" {
  security_group_id = aws_security_group.worker_tasks.id
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "workers_dns_tcp" {
  security_group_id = aws_security_group.worker_tasks.id
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "app_database" {
  security_group_id            = aws_security_group.app_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_vpc_security_group_egress_rule" "worker_database" {
  security_group_id            = aws_security_group.worker_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_vpc_security_group_ingress_rule" "database_app" {
  security_group_id            = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.app_tasks.id
}

resource "aws_vpc_security_group_ingress_rule" "database_workers" {
  security_group_id            = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.worker_tasks.id
}

resource "aws_vpc_security_group_egress_rule" "app_redis" {
  security_group_id            = aws_security_group.app_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.redis.id
}

resource "aws_vpc_security_group_egress_rule" "worker_redis" {
  security_group_id            = aws_security_group.worker_tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.redis.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_app" {
  security_group_id            = aws_security_group.redis.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.app_tasks.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_workers" {
  security_group_id            = aws_security_group.redis.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.worker_tasks.id
}

resource "aws_lb" "this" {
  name                       = substr(local.name, 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = module.network.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"
  tags                       = { Name = local.name }
}

resource "aws_lb_target_group" "frontend" {
  name                 = substr("${local.name}-web", 0, 32)
  port                 = 3001
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "api" {
  name                 = substr("${local.name}-api", 0, 32)
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/api/v1/openapi.json"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_acm_certificate" "this" {
  count                     = local.has_domain ? 1 : 0
  domain_name               = local.app_domain
  subject_alternative_names = [local.api_domain]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "certificate" {
  for_each = local.has_domain ? {
    for option in aws_acm_certificate.this[0].domain_validation_options : option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  } : {}
  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "this" {
  count                   = local.has_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate : record.fqdn]
}

resource "aws_lb_listener" "http" {
  load_balancer_arn                                         = aws_lb.this.arn
  port                                                      = 80
  protocol                                                  = "HTTP"
  routing_http_response_server_enabled                      = false
  routing_http_response_x_content_type_options_header_value = "nosniff"
  routing_http_response_x_frame_options_header_value        = "DENY"

  dynamic "default_action" {
    for_each = local.has_domain ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
  dynamic "default_action" {
    for_each = !local.has_domain && var.allow_insecure_http ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.frontend.arn
    }
  }
  dynamic "default_action" {
    for_each = !local.has_domain && !var.allow_insecure_http ? [1] : []
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "text/plain"
        message_body = "Domain and TLS configuration required"
        status_code  = "503"
      }
    }
  }
}

resource "aws_lb_listener_rule" "http_api" {
  count        = !local.has_domain && var.allow_insecure_http ? 1 : 0
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}

resource "aws_lb_listener" "https" {
  count                                                        = local.has_domain ? 1 : 0
  load_balancer_arn                                            = aws_lb.this.arn
  port                                                         = 443
  protocol                                                     = "HTTPS"
  ssl_policy                                                   = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn                                              = aws_acm_certificate_validation.this[0].certificate_arn
  routing_http_response_server_enabled                         = false
  routing_http_response_strict_transport_security_header_value = "max-age=63072000; includeSubDomains; preload"
  routing_http_response_content_security_policy_header_value   = "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'"
  routing_http_response_x_content_type_options_header_value    = "nosniff"
  routing_http_response_x_frame_options_header_value           = "DENY"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener_rule" "https_api" {
  count        = local.has_domain ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    host_header { values = [local.api_domain] }
  }
}

resource "aws_route53_record" "app" {
  count   = local.has_domain ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.app_domain
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api" {
  count   = local.has_domain ? 1 : 0
  zone_id = var.route53_zone_id
  name    = local.api_domain
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${local.name}.internal"
  vpc  = module.network.vpc_id
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
}

resource "aws_iam_role" "frontend_task" {
  name               = "${local.name}-frontend-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

locals {
  common_environment = [
    { name = "AWS_REGION", value = var.primary_region },
    { name = "PGSSLMODE", value = "require" },
    { name = "NODE_ENV", value = "production" },
    { name = "S3_UPLOAD_BUCKET", value = module.storage.bucket_names.uploads },
    { name = "S3_OUTPUT_BUCKET", value = module.storage.bucket_names.packages },
    { name = "S3_KMS_KEY_ARN", value = aws_kms_key.app.arn },
    { name = "S3_UPLOAD_EXPIRES_SECONDS", value = "900" },
    { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.this.id },
    { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
    { name = "TERMS_VERSION", value = var.terms_version },
    { name = "PRIVACY_VERSION", value = var.privacy_version },
    { name = "APP_URL", value = local.has_domain ? "https://${local.app_domain}" : "" },
  ]
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app_database.arn}:DATABASE_URL::" },
    { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.redis.arn}:REDIS_URL::" },
    { name = "AUTH_INTERNAL_SECRET", valueFrom = "${aws_secretsmanager_secret.auth.arn}:AUTH_INTERNAL_SECRET::" },
    { name = "STRIPE_SECRET_KEY", valueFrom = "${aws_secretsmanager_secret.billing.arn}:STRIPE_SECRET_KEY::" },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.billing.arn}:STRIPE_WEBHOOK_SECRET::" },
  ]
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${local.name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.frontend_task.arn
  container_definitions = jsonencode([{
    name         = "frontend"
    image        = "${aws_ecr_repository.this["frontend"].repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]
    environment = [
      { name = "API_BASE_URL", value = "http://api.${aws_service_discovery_private_dns_namespace.this.name}:3000/api/v1" },
      { name = "DEV_AUTH", value = "0" },
      { name = "NODE_ENV", value = "production" },
    ]
    healthCheck      = { command = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3001/ >/dev/null || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.ecs["frontend"].name, "awslogs-region" = var.primary_region, "awslogs-stream-prefix" = "app" } }
  }])
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  container_definitions = jsonencode([{
    name             = "api"
    image            = "${aws_ecr_repository.this["backend"].repository_url}:${var.image_tag}"
    essential        = true
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    environment      = concat(local.common_environment, [{ name = "PORT", value = "3000" }])
    secrets          = local.common_secrets
    healthCheck      = { command = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/v1/openapi.json >/dev/null || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.ecs["api"].name, "awslogs-region" = var.primary_region, "awslogs-stream-prefix" = "app" } }
  }])
}

locals {
  worker_job_types = {
    ocr         = "ingest_past_submittal"
    vendor      = "ingest_vendor_catalogue,product_rematch"
    package     = "package_generation,export_consultant_pdf,export_aconex_bundle,export_register_csv,export_register_xlsx,export_register_pdf"
    integration = "__integration_adapter_pending__"
    scheduled   = "risk_flag_generation,rfi_generation"
  }
}

resource "aws_ecs_task_definition" "worker" {
  for_each                 = local.worker_services
  family                   = "${local.name}-worker-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.worker_task[each.key].arn
  container_definitions = jsonencode([{
    name      = "worker-${each.key}"
    image     = "${aws_ecr_repository.this["backend"].repository_url}:${var.image_tag}"
    essential = true
    command   = ["npm", "run", "worker"]
    environment = concat(local.common_environment, [
      { name = "WORKER_KIND", value = each.key },
      { name = "WORKER_JOB_TYPES", value = local.worker_job_types[each.key] },
    ])
    secrets          = local.common_secrets
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.ecs["worker-${each.key}"].name, "awslogs-region" = var.primary_region, "awslogs-stream-prefix" = "worker" } }
  }])
}

resource "aws_ecs_task_definition" "migrations" {
  family                   = "${local.name}-migrations"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migration_execution.arn
  container_definitions = jsonencode([{
    name      = "migrations"
    image     = "${aws_ecr_repository.this["migrations"].repository_url}:${var.image_tag}"
    essential = true
    environment = [
      { name = "PGDATABASE", value = aws_db_instance.postgres.db_name },
      { name = "PGPORT", value = tostring(aws_db_instance.postgres.port) },
      { name = "PGSSLMODE", value = "require" },
    ]
    secrets = [
      { name = "PGHOST", valueFrom = "${aws_db_instance.postgres.master_user_secret[0].secret_arn}:host::" },
      { name = "PGUSER", valueFrom = "${aws_db_instance.postgres.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_db_instance.postgres.master_user_secret[0].secret_arn}:password::" },
      { name = "APP_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.app_database.arn}:password::" },
    ]
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.ecs["migrations"].name, "awslogs-region" = var.primary_region, "awslogs-stream-prefix" = "migration" } }
  }])
}

resource "aws_ecs_service" "frontend" {
  name                               = "frontend"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.frontend.arn
  desired_count                      = var.frontend_desired_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  enable_execute_command             = var.environment != "production"
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    assign_public_ip = false
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.app_tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 3001
  }
  lifecycle { ignore_changes = [task_definition] }
  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  enable_execute_command             = var.environment != "production"
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    assign_public_ip = false
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.app_tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  service_registries {
    registry_arn = aws_service_discovery_service.api.arn
  }
  lifecycle { ignore_changes = [task_definition] }
  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "worker" {
  for_each                           = local.worker_services
  name                               = "worker-${each.key}"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.worker[each.key].arn
  desired_count                      = var.worker_desired_count
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = var.environment != "production"
  capacity_provider_strategy {
    capacity_provider = var.environment == "production" ? "FARGATE" : "FARGATE_SPOT"
    weight            = 1
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    assign_public_ip = false
    subnets          = module.network.private_subnet_ids
    security_groups  = [each.key == "integration" ? aws_security_group.app_tasks.id : aws_security_group.worker_tasks.id]
  }
  lifecycle { ignore_changes = [task_definition] }
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = var.environment == "production" ? 10 : 3
  min_capacity       = max(1, var.api_desired_count)
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
