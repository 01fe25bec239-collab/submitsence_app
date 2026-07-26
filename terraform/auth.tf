resource "aws_cognito_user_pool" "this" {
  name                     = local.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"
  deletion_protection      = var.environment == "production" ? "ACTIVE" : "INACTIVE"
  user_pool_tier           = var.environment == "production" ? "PLUS" : "ESSENTIALS"

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 3
  }

  software_token_mfa_configuration { enabled = true }
  user_attribute_update_settings { attributes_require_verification_before_update = ["email"] }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  dynamic "user_pool_add_ons" {
    for_each = var.environment == "production" ? [1] : []
    content { advanced_security_mode = "ENFORCED" }
  }
  tags = { Name = local.name, DataClass = "personal" }
}

resource "aws_cognito_user_pool_client" "web" {
  name                          = "${local.name}-web"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  supported_identity_providers  = ["COGNITO"]
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity         = 15
  id_token_validity             = 15
  refresh_token_validity        = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  callback_urls                        = local.has_domain ? ["https://${local.app_domain}/auth/callback"] : null
  logout_urls                          = local.has_domain ? ["https://${local.app_domain}/"] : null
  allowed_oauth_flows                  = local.has_domain ? ["code"] : null
  allowed_oauth_scopes                 = local.has_domain ? ["openid", "email", "profile"] : null
  allowed_oauth_flows_user_pool_client = local.has_domain
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${local.name}-${random_id.suffix.hex}"
  user_pool_id = aws_cognito_user_pool.this.id
}
