variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging, or production."
  }
}

variable "primary_region" {
  type    = string
  default = "ap-southeast-2"
  validation {
    condition     = var.primary_region == "ap-southeast-2"
    error_message = "SubmitSense primary resources must stay in ap-southeast-2."
  }
}

variable "dr_region" {
  type    = string
  default = "ap-southeast-4"
  validation {
    condition     = contains(["ap-southeast-2", "ap-southeast-4"], var.dr_region)
    error_message = "DR must stay in an Australian AWS region."
  }
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-southeast-2a", "ap-southeast-2b"]
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "single_nat_gateway" {
  type    = bool
  default = true
}
variable "enable_dr" {
  type    = bool
  default = false
}
variable "force_destroy_buckets" {
  type    = bool
  default = false
}
variable "object_expiration_days" {
  type    = number
  default = 0
}
variable "log_expiration_days" {
  type    = number
  default = 365
}

variable "root_domain" {
  description = "Owned DNS name. Leave empty until a domain is purchased."
  type        = string
  default     = ""
}
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "app_subdomain" {
  type    = string
  default = "app"
}
variable "api_subdomain" {
  type    = string
  default = "api"
}
variable "allow_insecure_http" {
  description = "Development-only ALB forwarding without a certificate. Production is rejected."
  type        = bool
  default     = false
  validation {
    condition     = !(var.environment == "production" && var.allow_insecure_http)
    error_message = "Production cannot expose plaintext HTTP. Supply a domain or keep launch blocked."
  }
}

variable "image_tag" {
  type    = string
  default = "bootstrap"
}
variable "api_cpu" {
  type    = number
  default = 512
}
variable "api_memory" {
  type    = number
  default = 1024
}
variable "worker_cpu" {
  type    = number
  default = 1024
}
variable "worker_memory" {
  type    = number
  default = 2048
}
variable "api_capacity" {
  type = object({
    initial  = number
    min      = number
    max      = number
    pool_max = number
  })
  validation {
    condition = (
      var.api_capacity.min >= 1 &&
      var.api_capacity.initial >= var.api_capacity.min &&
      var.api_capacity.initial <= var.api_capacity.max &&
      contains([5, 10], var.api_capacity.pool_max)
    )
    error_message = "api_capacity initial must be within min/max, min must be at least one, and pool_max must be 5 or 10."
  }
}

variable "frontend_capacity" {
  type = object({
    initial = number
    min     = number
    max     = number
  })
  validation {
    condition = (
      var.frontend_capacity.min >= 1 &&
      var.frontend_capacity.initial >= var.frontend_capacity.min &&
      var.frontend_capacity.initial <= var.frontend_capacity.max
    )
    error_message = "frontend_capacity initial must be within min/max and min must be at least one."
  }
}

variable "worker_capacities" {
  type = map(object({
    initial = number
    min     = number
    max     = number
  }))
  validation {
    condition = (
      toset(keys(var.worker_capacities)) == toset(["ocr", "vendor", "package", "scheduled"]) &&
      alltrue([
        for name, capacity in var.worker_capacities :
        capacity.min >= 0 &&
        capacity.initial >= capacity.min &&
        capacity.initial <= capacity.max &&
        (name == "scheduled" ? capacity.min == 1 : capacity.min == 0)
      ])
    )
    error_message = "worker_capacities must define ocr, vendor, package, and scheduled; initial must be within bounds; only scheduled has min 1."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "db_allocated_storage" {
  type    = number
  default = 50
}
variable "db_max_allocated_storage" {
  type    = number
  default = 500
}
variable "db_backup_retention_days" {
  type    = number
  default = 14
}
variable "alarm_email" {
  description = "Optional operational email. Subscription must be confirmed by the recipient."
  type        = string
  default     = ""
}
variable "monthly_budget_usd" {
  type    = number
  default = 350
}
variable "github_repository" {
  description = "Optional owner/repository allowed to assume the deployment role through GitHub OIDC."
  type        = string
  default     = ""
}

variable "terms_version" {
  type    = string
  default = ""
}
variable "privacy_version" {
  type    = string
  default = ""
}
variable "retention_schedule" {
  description = "Scheduled-jobs expression. The task remains infrastructure-only until legal sets purge rules."
  type        = string
  default     = "cron(0 16 * * ? *)"
}
