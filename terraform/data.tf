resource "aws_security_group" "database" {
  name_prefix = "${local.name}-database-"
  description = "PostgreSQL only from ECS tasks"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-database" }
}

resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-redis-"
  description = "Redis TLS only from ECS tasks"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-redis" }
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = module.network.data_subnet_ids
  tags       = { Name = local.name }
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${local.name}-postgres17"
  family = "postgres17"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

data "aws_iam_policy_document" "rds_monitor_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitor" {
  name               = "${local.name}-rds-monitor"
  assume_role_policy = data.aws_iam_policy_document.rds_monitor_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitor" {
  role       = aws_iam_role.rds_monitor.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "postgres" {
  identifier                      = local.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = var.db_instance_class
  db_name                         = "submitsense"
  username                        = "submitsense_admin"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.app.key_id
  port                            = 5432
  allocated_storage               = var.db_allocated_storage
  max_allocated_storage           = var.db_max_allocated_storage
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.app.arn
  multi_az                        = var.environment == "production"
  publicly_accessible             = false
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.postgres.name
  backup_retention_period         = var.db_backup_retention_days
  backup_window                   = "15:00-16:00"
  maintenance_window              = "sun:16:30-sun:17:30"
  copy_tags_to_snapshot           = true
  deletion_protection             = var.environment == "production"
  skip_final_snapshot             = var.environment != "production"
  final_snapshot_identifier       = var.environment == "production" ? "${local.name}-final-${random_id.suffix.hex}" : null
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.app.arn
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitor.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  apply_immediately               = var.environment != "production"
  tags                            = { Name = local.name, DataClass = "confidential" }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = module.network.data_subnet_ids
}

resource "random_password" "redis" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = local.name
  description                = "SubmitSense BullMQ Redis"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  port                       = 6379
  num_cache_clusters         = 1 + var.redis_replicas
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  kms_key_id                 = aws_kms_key.app.arn
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  snapshot_retention_limit   = var.environment == "production" ? 7 : 1
  snapshot_window            = "14:00-15:00"
  maintenance_window         = "sun:17:30-sun:18:30"
  apply_immediately          = var.environment != "production"
  auto_minor_version_upgrade = true
  tags                       = { Name = local.name, DataClass = "confidential" }
}

resource "random_password" "app_database" {
  length  = 40
  special = false
}

resource "random_password" "auth_internal" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "app_database" {
  name                    = "${local.name}/database/app"
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "app_database" {
  secret_id = aws_secretsmanager_secret.app_database.id
  secret_string = jsonencode({
    username     = "submitsense_runtime"
    password     = random_password.app_database.result
    host         = aws_db_instance.postgres.address
    port         = aws_db_instance.postgres.port
    dbname       = aws_db_instance.postgres.db_name
    DATABASE_URL = "postgresql://submitsense_runtime:${random_password.app_database.result}@${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}/${aws_db_instance.postgres.db_name}?sslmode=require"
  })
}

resource "aws_secretsmanager_secret" "redis" {
  name                    = "${local.name}/redis"
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    auth_token = random_password.redis.result
    REDIS_URL  = "rediss://default:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  })
}

resource "aws_secretsmanager_secret" "auth" {
  name                    = "${local.name}/auth"
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "auth" {
  secret_id = aws_secretsmanager_secret.auth.id
  secret_string = jsonencode({
    AUTH_INTERNAL_SECRET = random_password.auth_internal.result
  })
}

resource "aws_secretsmanager_secret" "billing" {
  name                    = "${local.name}/billing"
  description             = "Populate STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET out of band"
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "billing" {
  secret_id     = aws_secretsmanager_secret.billing.id
  secret_string = jsonencode({ STRIPE_SECRET_KEY = "", STRIPE_WEBHOOK_SECRET = "" })
  lifecycle { ignore_changes = [secret_string] }
}

resource "aws_secretsmanager_secret" "integrations" {
  name                    = "${local.name}/integrations"
  description             = "Approved AU-pinned integration token references only"
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}
