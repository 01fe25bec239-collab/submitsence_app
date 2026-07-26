variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "force_destroy" { type = bool }
variable "object_expiration_days" { type = number }
variable "log_expiration_days" { type = number }
variable "tags" { type = map(string) }
