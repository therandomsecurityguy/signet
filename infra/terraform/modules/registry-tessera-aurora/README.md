## `registry-tessera-aurora`

Aurora MySQL module for the Tessera runtime's AWS backend.

What it creates:
- Aurora MySQL Serverless v2 cluster
- Aurora security group and subnet group
- Secrets Manager secret containing `host`, `port`, `db_name`, `username`, and `password`

Important notes:
- Tessera's AWS storage path still needs S3 for tiles/checkpoints; use this alongside `registry-tessera-s3`.
- The runtime can now consume the secret indirectly via `TESSERA_DB_SECRET_ARN`.
- Override `engine_version` with a version supported in your target region before apply.
