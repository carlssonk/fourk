output "node_url" {
  description = "Set as the VITE_NODE_URL repository variable"
  value       = "wss://${var.hostname}"
}

output "ipv4" {
  value = hcloud_primary_ip.node.ip_address
}

output "ssh" {
  value = "ssh root@${hcloud_primary_ip.node.ip_address}"
}
