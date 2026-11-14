data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "random_password" "fuseki" {
  length  = 32
  special = false
}

# Peppers the API-key hash (HMAC-SHA256). Stable; rotating it invalidates all
# existing API keys, so it is Terraform-owned rather than operator-rotated.
resource "random_password" "api_key_pepper" {
  length  = 48
  special = false
}

locals {
  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  secret_prefix = var.secret_prefix != "" ? var.secret_prefix : "${var.project_name}-${var.environment}/runtime"

  # Operator-seeded secrets (never generated or stored in state) plus any extra
  # keys. Generated secrets are created in secrets.tf.
  operator_secret_keys = [
    "okta-client-secret",
    "tessera-log-private-key",
    "tessera-sidecar-auth-token",
  ]

  generated_secret_keys = [
    "database-url",
    "fuseki-admin-password",
    "redis-url",
    "api-key-pepper",
  ]

  all_secret_keys = concat(local.operator_secret_keys, local.generated_secret_keys, var.additional_secret_keys)

  artifact_prefix = trimsuffix(var.artifact_prefix, "/")
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid    = "EnableRootAccountAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowEsoDecrypt"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.eso.arn]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = ["*"]
  }
}

resource "aws_kms_key" "this" {
  description             = "${var.project_name} ${var.environment} data encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json

  tags = merge(local.common_tags, { Name = "${var.project_name}-${var.environment}" })
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.project_name}-${var.environment}"
  target_key_id = aws_kms_key.this.key_id
}

# ---- Artifact bucket (registry CAS) -----------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket        = var.artifact_bucket_name
  force_destroy = var.force_destroy_bucket

  tags = merge(local.common_tags, { Name = var.artifact_bucket_name, Component = "artifacts" })
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "artifacts_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts_bucket.json
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  # Daily Fuseki dumps: expire after 90 days (restore window).
  rule {
    id     = "expire-fuseki-backups"
    status = "Enabled"

    filter {
      prefix = "${local.artifact_prefix}/backups/fuseki/"
    }

    expiration {
      days = 90
    }
  }
}

# ---- Static S3 credentials --------------------------------------------------
#
# Retired: registry workloads reach the artifact bucket through IRSA (the ESO /
# workload role in irsa.tf), not long-lived IAM user access keys. This keeps
# access under federated identity and out of Secrets Manager/state.
