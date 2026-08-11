output "custom_domain" {
  description = "Custom domain attached to the Worker"
  value       = cloudflare_workers_custom_domain.site.hostname
}

output "worker_name" {
  description = "Cloudflare Worker name"
  value       = cloudflare_worker.site.name
}
