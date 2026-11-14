# ENG-94247: source buckets and their destination share this module's AWS
# provider/account/Region. The destination does not log to itself; organization
# CloudTrail data events audit access to the logs.
module "s3_access_log_destination" {
  source = "git::ssh://git@github.com/togethercomputer/tf-mod-s3-soc2-compliant-bucket.git//modules/access-log-destination?ref=v0.6.0"

  source_bucket_arns = [aws_s3_bucket.artifacts.arn]
  tags               = local.common_tags
}

resource "aws_s3_bucket_logging" "artifacts_access_logging" {
  bucket        = aws_s3_bucket.artifacts.id
  target_bucket = module.s3_access_log_destination.bucket_id
  target_prefix = "s3/${aws_s3_bucket.artifacts.id}/"
}
