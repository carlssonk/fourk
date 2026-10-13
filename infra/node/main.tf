# One testnet-10 kaspad with the UTXO index, reachable by browsers only as
# wss://<hostname> through a Cloudflare Tunnel. The server's sole open
# ports are P2P (so other nodes can sync from it) and SSH; wRPC never
# listens on a public interface.

locals {
  p2p_port   = 16211 # testnet default
  borsh_port = 17210 # testnet default; the tunnel's origin

  compose = templatefile("${path.module}/compose.yaml.tftpl", {
    kaspad_version      = var.kaspad_version
    cloudflared_version = var.cloudflared_version
    external_ip         = hcloud_primary_ip.node.ip_address
    p2p_port            = local.p2p_port
    borsh_port          = local.borsh_port
    rpc_max_clients     = var.rpc_max_clients
  })
  env = "TUNNEL_TOKEN=${data.cloudflare_zero_trust_tunnel_cloudflared_token.node.token}\n"
}

# --- Hetzner ------------------------------------------------------------------

resource "hcloud_ssh_key" "admin" {
  name       = "fourk-node-admin"
  public_key = var.ssh_public_key
}

# Kept apart from the server so a rebuilt server keeps its address (and the
# peers that already know it).
resource "hcloud_primary_ip" "node" {
  name        = "fourk-node-v4"
  type        = "ipv4"
  location    = var.location
  auto_delete = false
}

resource "hcloud_firewall" "node" {
  name = "fourk-node"

  rule {
    description = "kaspad p2p"
    direction   = "in"
    protocol    = "tcp"
    port        = tostring(local.p2p_port)
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "ssh"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_allowed_cidrs
  }

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "node" {
  name         = "fourk-node"
  server_type  = var.server_type
  location     = var.location
  image        = "ubuntu-24.04"
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.node.id]
  user_data    = file("${path.module}/cloud-init.yaml")

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.node.id
    ipv6_enabled = true
  }

  # Replacing the server throws away the synced chain. Changes to what runs
  # on it go through terraform_data.stack below, in place.
  lifecycle {
    ignore_changes = [user_data, image]
  }
}

# The compose stack, pushed over SSH and restarted whenever it (or the
# server) changes. Image upgrades are a kaspad_version bump and an apply.
resource "terraform_data" "stack" {
  triggers_replace = [
    hcloud_server.node.id,
    sha256(local.compose),
    sha256(local.env),
  ]

  connection {
    type = "ssh"
    host = hcloud_primary_ip.node.ip_address
    user = "root"
  }

  provisioner "remote-exec" {
    inline = [
      "cloud-init status --wait >/dev/null || true",
      "command -v docker >/dev/null || { echo 'docker missing: cloud-init failed, see /var/log/cloud-init-output.log' >&2; exit 1; }",
      "install -d -m 700 /opt/kaspa",
    ]
  }

  provisioner "file" {
    content     = local.compose
    destination = "/opt/kaspa/compose.yaml"
  }

  provisioner "file" {
    content     = local.env
    destination = "/opt/kaspa/.env"
  }

  provisioner "remote-exec" {
    inline = [
      "chmod 600 /opt/kaspa/.env",
      # Docker Hub has transient 5xx; one of them should not fail an apply.
      "cd /opt/kaspa && for i in 1 2 3 4 5; do docker compose pull -q && break; [ $i = 5 ] && exit 1; sleep 15; done",
      "cd /opt/kaspa && docker compose up -d --remove-orphans",
    ]
  }
}

# --- Cloudflare ---------------------------------------------------------------

resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "node" {
  account_id    = var.cloudflare_account_id
  name          = "fourk-node"
  config_src    = "cloudflare"
  tunnel_secret = random_id.tunnel_secret.b64_std
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "node" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.node.id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "node" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.node.id

  config = {
    ingress = [
      {
        hostname = var.hostname
        # cloudflared resolves "kaspad" on the compose network.
        service = "http://kaspad:${local.borsh_port}"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

resource "cloudflare_dns_record" "node" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.node.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # automatic; required for proxied records
}
