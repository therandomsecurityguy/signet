# IRSA for the release service account. One role backs both:
#   - External Secrets Operator reading the cachet Secrets Manager prefix
#     (the chart's SecretStore JWT auth), and
#   - registry workloads reading/writing the artifact bucket via the AWS SDK
#     credential chain (no static access keys).
locals {
  oidc_issuer_url = var.eks_oidc_issuer_url != "" ? var.eks_oidc_issuer_url : replace(var.eks_oidc_provider_arn, "/^arn:[^:]+:iam::[0-9]+:oidc-provider\\//", "")
}

data "aws_iam_policy_document" "eso_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.eks_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer_url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer_url}:sub"
      values   = ["system:serviceaccount:${var.eso_namespace}:${var.eso_service_account_name}"]
    }
  }
}

resource "aws_iam_role" "eso" {
  name               = "${var.project_name}-${var.environment}-eso"
  assume_role_policy = data.aws_iam_policy_document.eso_assume.json

  tags = merge(local.common_tags, { Component = "eso" })
}

data "aws_iam_policy_document" "eso_secrets" {
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [for s in aws_secretsmanager_secret.this : s.arn]
  }

  statement {
    sid    = "WatchdogMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:PutMetricData",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.sidecar_watchdog_metric_namespace]
    }
  }

  statement {
    sid    = "ArtifactObjectAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/${local.artifact_prefix}/*"]
  }

  statement {
    sid       = "ArtifactBucketList"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.this.arn]
  }
}

resource "aws_iam_role_policy" "eso" {
  name   = "${var.project_name}-${var.environment}-eso"
  role   = aws_iam_role.eso.id
  policy = data.aws_iam_policy_document.eso_secrets.json
}
