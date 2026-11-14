# Source buckets and their destination share this module's AWS
# provider/account/Region. The destination does not log to itself;
# organization CloudTrail data events audit access to the logs.
resource "aws_s3_bucket" "access_logs" {
  bucket = "${var.bucket_name}-access-logs"
  tags   = merge(local.common_tags, { Component = "access-logs" })
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 365
    }
  }
}

data "aws_iam_policy_document" "access_logs" {
  statement {
    sid     = "AllowS3ServerAccessLogs"
    effect  = "Allow"
    actions = ["s3:PutObject"]

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.access_logs.arn}/s3/*"]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.access_logs.json
}

resource "aws_s3_bucket_logging" "this_access_logging" {
  bucket        = aws_s3_bucket.this.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "s3/${aws_s3_bucket.this.id}/"
}
