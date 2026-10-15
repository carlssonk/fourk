variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  description = "Zone id of fourk.io"
  type        = string
}

variable "hostname" {
  description = "Public name of the node's wRPC endpoint; the app pins wss://<hostname>"
  type        = string
  default     = "node.fourk.io"
}

variable "ssh_public_key" {
  description = "Admin key for the server (Terraform provisions over SSH with your agent)"
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "Who may reach port 22. Narrow this to your own address if you can."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "location" {
  type    = string
  default = "fsn1"
}

variable "server_type" {
  description = "Kaspa's stated testnet-10 minimum is 8 cores, 16 GB RAM, 256 GB SSD; cpx52 leaves headroom over it"
  type        = string
  default     = "cpx52"
}

variable "kaspad_version" {
  description = "kaspanet/rusty-kaspad image tag"
  type        = string
  default     = "v2.1.0"
}

variable "cloudflared_version" {
  description = "cloudflare/cloudflared image tag"
  type        = string
  default     = "2026.10.0"
}

variable "node_version" {
  description = "node image tag the sweeper runs on"
  type        = string
  default     = "24.7.0-alpine"
}

variable "rpc_max_clients" {
  description = "kaspad --rpcmaxclients: every open fourk tab holds one wRPC socket"
  type        = number
  default     = 1000
}
