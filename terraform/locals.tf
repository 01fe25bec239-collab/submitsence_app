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

  worker_pool_registry = jsondecode(file("${path.module}/../backend/src/worker-pools.json"))
  worker_services = {
    for name, pool in local.worker_pool_registry : name => {
      cpu       = name == "scheduled" ? 256 : var.worker_cpu
      memory    = name == "scheduled" ? 512 : var.worker_memory
      anchor    = try(pool.anchor, false)
      job_types = pool.jobTypes
    } if pool.enabled
  }

  supported_worker_job_types = [
    "product_rematch",
    "ingest_vendor_catalogue",
    "ingest_past_submittal",
    "package_generation",
    "risk_flag_generation",
    "rfi_generation",
    "export_consultant_pdf",
    "export_aconex_bundle",
    "export_register_csv",
    "export_register_xlsx",
    "export_register_pdf",
  ]
  assigned_worker_job_types     = flatten([for pool in values(local.worker_services) : pool.job_types])
  planning_max_connections      = { dev = 112, staging = 450, production = 1802 }[var.environment]
  expected_required_connections = { dev = 61, staging = 115, production = 297 }[var.environment]
  required_connections = (
    var.api_capacity.max * 2 * var.api_capacity.pool_max +
    sum([for capacity in values(var.worker_capacities) : capacity.max * 2 * 3]) +
    1
  )
  usable_connections = floor(local.planning_max_connections * 0.80)
}

resource "terraform_data" "pb08_contract" {
  input = local.required_connections

  lifecycle {
    precondition {
      condition     = toset(keys(local.worker_services)) == toset(["ocr", "vendor", "package", "scheduled"])
      error_message = "The canonical worker registry must contain exactly ocr, vendor, package, and scheduled."
    }
    precondition {
      condition     = length([for pool in values(local.worker_services) : pool if pool.anchor]) == 1
      error_message = "The canonical worker registry must contain exactly one enabled anchor."
    }
    precondition {
      condition = (
        length(local.assigned_worker_job_types) == length(distinct(local.assigned_worker_job_types)) &&
        toset(local.assigned_worker_job_types) == toset(local.supported_worker_job_types)
      )
      error_message = "The canonical worker registry must assign every supported job type exactly once."
    }
    precondition {
      condition     = local.required_connections == local.expected_required_connections
      error_message = "The PB-08 connection budget does not equal the reviewed environment total."
    }
    precondition {
      condition     = local.required_connections <= local.usable_connections
      error_message = "The PB-08 connection budget exceeds 80 percent of planned max_connections."
    }
  }
}
