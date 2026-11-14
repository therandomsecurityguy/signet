data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

# Account-level GitHub OIDC provider. Most startup accounts already have one
# (created for the first repo that needed it), so we look it up by URL unless an
# explicit ARN is supplied or creation is requested.
data "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == null && !var.create_openid_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_openid_provider ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # Legacy field: AWS ignores thumbprints for well-known CAs (it uses its own
  # CA bundle for token.actions.githubusercontent.com). Kept for compatibility
  # with older provider versions.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.common_tags
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

  oidc_provider_arn = coalesce(
    var.github_oidc_provider_arn,
    try(aws_iam_openid_connect_provider.github[0].arn, null),
    try(data.aws_iam_openid_connect_provider.github[0].arn, null),
  )

  publish_role_name = var.publish_role_name != "" ? var.publish_role_name : "${var.project_name}-${var.environment}-github-publish"

  # Component repos use the chart's repository values (signet/<component>), so
  # images are shared across environments by tag/digest.
  component_repositories = {
    for name in var.components : name => "${var.project_name}/${name}"
  }

  chart_repository = var.chart_repository_name != "" ? { chart = var.chart_repository_name } : {}

  repository_names = merge(local.component_repositories, local.chart_repository)

  all_repository_arns = values(aws_ecr_repository.images)[*].arn
}

# Customer-managed key for ECR image encryption. The key policy is inlined
# (rather than a standalone policy document) so it is evaluated as a KMS key
# policy, matching the khalifa module's pattern.
resource "aws_kms_key" "ecr" {
  description             = "${var.project_name} ${var.environment} ECR image encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccountAdmin"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AwsServices"
        Effect = "Allow"
        Principal = {
          Service = [
            "ecr.amazonaws.com",
            "logs.${data.aws_region.current.region}.amazonaws.com",
          ]
        }
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:Encrypt",
          "kms:GenerateDataKey*",
          "kms:ReEncrypt*",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
        }
      },
    ]
  })

  tags = merge(local.common_tags, { Name = "${var.project_name}-${var.environment}-ecr" })
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/${var.project_name}-${var.environment}-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

resource "aws_ecr_repository" "images" {
  for_each = local.repository_names

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Name      = each.value
    Component = each.key
  })
}

resource "aws_ecr_lifecycle_policy" "images" {
  for_each = aws_ecr_repository.images

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_iam_role" "github_actions_publish" {
  name                 = local.publish_role_name
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "GitHubActionsPublish"
      Effect = "Allow"
      Principal = {
        Federated = local.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud"        = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:repository" = var.github_repository
          "token.actions.githubusercontent.com:workflow"   = var.github_workflow
        }
        StringLike = {
          "token.actions.githubusercontent.com:ref" = var.github_refs
          "token.actions.githubusercontent.com:sub" = var.github_subjects
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name = local.publish_role_name
  })
}

resource "aws_iam_role_policy" "github_actions_publish" {
  name = "${local.publish_role_name}-inline"
  role = aws_iam_role.github_actions_publish.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuthorization"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PublishImagesAndChart"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          # Pulling layers is required by the release pipeline itself: syft
          # scans the pushed image to produce its SBOM, and cosign reads the
          # manifest for signing/attestation.
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = local.all_repository_arns
      },
    ]
  })
}

locals {
  # Read-only CI access: lets other repositories' workflows (e.g. the gitops
  # repo's deployment-registration job) run cosign verification against these
  # repositories without publish permissions.
  reader_role_name = var.reader_role_name != "" ? var.reader_role_name : "${var.project_name}-${var.environment}-github-read"
  reader_enabled   = var.reader_github_repository != ""
}

resource "aws_iam_role" "github_actions_read" {
  count                = local.reader_enabled ? 1 : 0
  name                 = local.reader_role_name
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "GitHubActionsRead"
      Effect = "Allow"
      Principal = {
        Federated = local.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = merge(
          {
            "token.actions.githubusercontent.com:aud"        = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:repository" = var.reader_github_repository
          },
          var.reader_github_workflow != "" ? { "token.actions.githubusercontent.com:workflow" = var.reader_github_workflow } : {},
        )
        StringLike = {
          "token.actions.githubusercontent.com:ref" = var.reader_github_refs
          "token.actions.githubusercontent.com:sub" = var.reader_github_subjects
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name = local.reader_role_name
  })
}

resource "aws_iam_role_policy" "github_actions_read" {
  count = local.reader_enabled ? 1 : 0
  name  = "${local.reader_role_name}-inline"
  role  = aws_iam_role.github_actions_read[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuthorization"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "ReadImagesAndSignatureArtifacts"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:GetDownloadUrlForLayer",
          "ecr:GetRepositoryPolicy",
          "ecr:ListImages",
        ]
        Resource = local.all_repository_arns
      },
    ]
  })
}
