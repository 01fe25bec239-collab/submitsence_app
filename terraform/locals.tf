locals {
  name = "submitsense-${var.environment}"
  tags = {
    Project     = "SubmitSense"
    Environment = var.environment
    ManagedBy   = "Terraform"
    DataRegion  = var.primary_region
  }

  has_domain = var.root_domain != "" && var.route53_zone_id != ""
  app_domain = local.has_domain ? "${var.app_subdomain}.${var.root_domain}" : ""
  api_domain = local.has_domain ? "${var.api_subdomain}.${var.root_domain}" : ""

  worker_services = {
    ocr         = { cpu = var.worker_cpu, memory = var.worker_memory }
    vendor      = { cpu = var.worker_cpu, memory = var.worker_memory }
    package     = { cpu = var.worker_cpu, memory = var.worker_memory }
    integration = { cpu = 512, memory = 1024 }
    scheduled   = { cpu = 256, memory = 512 }
  }
}
