terraform {
  backend "s3" {}
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "aws" {
  region = "ap-southeast-2"
  default_tags {
    tags = { Project = "SubmitSense", ManagedBy = "Terraform", DataRegion = "ap-southeast-2" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
