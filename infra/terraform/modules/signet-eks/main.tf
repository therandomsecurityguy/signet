resource "helm_release" "this" {
  name      = var.release_name
  namespace = var.namespace

  repository = var.chart_repository
  chart      = var.chart_name
  version    = var.chart_version

  create_namespace = var.create_namespace
  atomic           = var.atomic
  wait             = var.wait
  timeout          = var.timeout_seconds
  cleanup_on_fail  = true

  # helm_release.values takes literal YAML documents, not file paths, so read
  # each values file's contents.
  values = [for f in var.values_files : file(f)]

  # Helm provider v3 takes set values as a list attribute rather than nested
  # set blocks.
  set = [for k, v in var.set_values : { name = k, value = v }]
}
