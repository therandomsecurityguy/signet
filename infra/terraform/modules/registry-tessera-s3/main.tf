data "aws_region" "current" {}

locals {
  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  managed_prefixes = [
    trimsuffix(var.registry_artifact_prefix, "/"),
    trimsuffix(var.tessera_tiles_prefix, "/"),
    trimsuffix(var.tessera_requests_prefix, "/"),
  ]
}

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy

  tags = local.common_tags
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = length(var.allowed_read_principal_arns) > 0 ? [1] : []
    content {
      sid    = "AllowReadManagedPrefixes"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = var.allowed_read_principal_arns
      }

      actions = [
        "s3:GetObject",
        "s3:GetObjectVersion",
      ]

      resources = flatten([
        for prefix in local.managed_prefixes : [
          "${aws_s3_bucket.this.arn}/${prefix}",
          "${aws_s3_bucket.this.arn}/${prefix}/*",
        ]
      ])
    }
  }

  dynamic "statement" {
    for_each = length(var.allowed_read_principal_arns) > 0 ? [1] : []
    content {
      sid    = "AllowListManagedPrefixes"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = var.allowed_read_principal_arns
      }

      actions   = ["s3:ListBucket"]
      resources = [aws_s3_bucket.this.arn]

      condition {
        test     = "StringLike"
        variable = "s3:prefix"
        values = flatten([
          for prefix in local.managed_prefixes : [
            prefix,
            "${prefix}/*",
          ]
        ])
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.allowed_write_principal_arns) > 0 ? [1] : []
    content {
      sid    = "AllowWriteManagedPrefixes"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = var.allowed_write_principal_arns
      }

      actions = [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:PutObjectTagging",
      ]

      resources = flatten([
        for prefix in local.managed_prefixes : [
          "${aws_s3_bucket.this.arn}/${prefix}",
          "${aws_s3_bucket.this.arn}/${prefix}/*",
        ]
      ])
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json
}

resource "aws_ssm_parameter" "registry_bucket" {
  count = var.create_ssm_config_parameters ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_prefix, "/")}/registry_artifact_bucket"
  type  = "String"
  value = aws_s3_bucket.this.bucket
  tags  = local.common_tags
}

resource "aws_ssm_parameter" "registry_prefix" {
  count = var.create_ssm_config_parameters ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_prefix, "/")}/registry_artifact_prefix"
  type  = "String"
  value = trimsuffix(var.registry_artifact_prefix, "/")
  tags  = local.common_tags
}

resource "aws_ssm_parameter" "tessera_tiles_prefix" {
  count = var.create_ssm_config_parameters ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_prefix, "/")}/tessera_tiles_prefix"
  type  = "String"
  value = trimsuffix(var.tessera_tiles_prefix, "/")
  tags  = local.common_tags
}

resource "aws_ssm_parameter" "tessera_requests_prefix" {
  count = var.create_ssm_config_parameters ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_prefix, "/")}/tessera_requests_prefix"
  type  = "String"
  value = trimsuffix(var.tessera_requests_prefix, "/")
  tags  = local.common_tags
}
