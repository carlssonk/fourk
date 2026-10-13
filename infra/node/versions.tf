terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.70"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Tokens come from the environment, never from tfvars:
#   HCLOUD_TOKEN          Hetzner Cloud project token (read/write)
#   CLOUDFLARE_API_TOKEN  Account: Cloudflare Tunnel Edit; Zone (fourk.io): DNS Edit
provider "hcloud" {}
provider "cloudflare" {}
