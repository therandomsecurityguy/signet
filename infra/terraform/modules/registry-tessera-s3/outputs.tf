output "bucket_name" {
  description = "Shared S3 bucket name for registry artifacts and Tessera companion data."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "Shared S3 bucket ARN."
  value       = aws_s3_bucket.this.arn
}

output "region" {
  description = "AWS region hosting the bucket."
  value       = data.aws_region.current.region
}

output "registry_artifact_prefix" {
  description = "Prefix for registry CAS objects."
  value       = trimsuffix(var.registry_artifact_prefix, "/")
}

output "tessera_tiles_prefix" {
  description = "Prefix reserved for Tessera tiles/checkpoints."
  value       = trimsuffix(var.tessera_tiles_prefix, "/")
}

output "tessera_requests_prefix" {
  description = "Prefix reserved for sidecar append-intent request objects."
  value       = trimsuffix(var.tessera_requests_prefix, "/")
}

output "registry_artifact_env" {
  description = "Copy/paste environment block for registry S3 artifact configuration."
  sensitive   = true
  value = join("\n", [
    "REGISTRY_ARTIFACT_BACKEND=s3",
    "REGISTRY_S3_BUCKET=${aws_s3_bucket.this.bucket}",
    "REGISTRY_S3_PREFIX=${trimsuffix(var.registry_artifact_prefix, "/")}",
    "REGISTRY_S3_REGION=${data.aws_region.current.region}",
  ])
}

output "tessera_sidecar_env" {
  description = "Copy/paste environment block for the Tessera sidecar."
  sensitive   = true
  value = join("\n", [
    "TESSERA_SIDECAR_BUCKET=${aws_s3_bucket.this.bucket}",
    "TESSERA_SIDECAR_REGION=${data.aws_region.current.region}",
    "TESSERA_SIDECAR_TILES_PREFIX=${trimsuffix(var.tessera_tiles_prefix, "/")}",
    "TESSERA_SIDECAR_REQUESTS_PREFIX=${trimsuffix(var.tessera_requests_prefix, "/")}",
  ])
}

output "ssm_parameter_names" {
  description = "Optional SSM parameter names that can be remote_state-consumed or resolved into env vars."
  value = var.create_ssm_config_parameters ? {
    registry_artifact_bucket = aws_ssm_parameter.registry_bucket[0].name
    registry_artifact_prefix = aws_ssm_parameter.registry_prefix[0].name
    tessera_tiles_prefix     = aws_ssm_parameter.tessera_tiles_prefix[0].name
    tessera_requests_prefix  = aws_ssm_parameter.tessera_requests_prefix[0].name
  } : {}
}
