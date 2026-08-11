variable "account_id" {
  description = "Cloudflare Account ID"
  type        = string
  sensitive   = true
}

variable "custom_domain" {
  description = "Custom domain attached to the Worker"
  type        = string
  default     = "next.sable.moe"

  validation {
    condition     = var.custom_domain == "next.sable.moe"
    error_message = "The sable-next deployment must use next.sable.moe."
  }
}

variable "worker_name" {
  description = "Cloudflare Worker name"
  type        = string
  default     = "sable-next"

  validation {
    condition     = var.worker_name == "sable-next"
    error_message = "The sable-next deployment must use the sable-next Worker."
  }
}

variable "workers_message" {
  description = "Optional short message attached to Worker deployments"
  type        = string
  default     = null
}

variable "zone_id" {
  description = "Cloudflare Zone ID"
  type        = string
  sensitive   = true
}
