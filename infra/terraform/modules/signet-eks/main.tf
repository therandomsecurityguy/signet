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

  dynamic "set" {
    for_each = var.set_values
    content {
      name  = set.key
      value = set.value
    }
  }
}
