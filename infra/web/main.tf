resource "cloudflare_worker" "site" {
  account_id = var.account_id
  name       = var.worker_name

  subdomain = {
    enabled          = true
    previews_enabled = true
  }
}

resource "cloudflare_worker_version" "site" {
  account_id         = var.account_id
  compatibility_date = "2026-03-03"
  worker_id          = cloudflare_worker.site.id

  main_module = "worker.mjs"
  modules = [{
    name         = "worker.mjs"
    content_type = "application/javascript+module"
    content_file = abspath("${path.module}/worker.mjs")
  }]

  bindings = [{
    type = "assets"
    name = "ASSETS"
  }]

  assets = {
    directory = abspath("${path.module}/../../dist")
    config = {
      not_found_handling = "single-page-application"
    }
  }
}

resource "cloudflare_workers_deployment" "site" {
  account_id  = var.account_id
  script_name = cloudflare_worker.site.name
  strategy    = "percentage"

  annotations = var.workers_message == null ? null : {
    workers_message = var.workers_message
  }

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.site.id
  }]
}

resource "cloudflare_workers_custom_domain" "site" {
  account_id  = var.account_id
  environment = "production"
  hostname    = var.custom_domain
  service     = cloudflare_worker.site.name
  zone_id     = var.zone_id

  depends_on = [cloudflare_workers_deployment.site]
}

resource "cloudflare_workers_custom_domain" "alias" {
  for_each = toset(var.alias_domains)

  account_id  = var.account_id
  environment = "production"
  hostname    = each.value
  service     = cloudflare_worker.site.name
  zone_id     = var.zone_id

  depends_on = [cloudflare_workers_deployment.site]
}
