# signet-stack (dev example)

Composes the three signet modules (registry, data, eks) for a single
environment. Copy this into the environment repo (`tf-io-sec`) and adjust.

## Apply order

1. `terraform apply -target=module.signet_registry` (ECR + OIDC publish role).
2. Configure the GitHub repo variables (`AWS_ROLE_ARN`, ECR repo names) and cut
   a release so `charts/signet` and the component images exist.
3. `terraform apply` (data plane + Helm release).

## Operator follow-up

Seed the non-generated secrets before the first successful rollout:

```sh
aws secretsmanager put-secret-value \
  --secret-id <secret_prefix>/okta-client-secret --secret-string '<value>'
aws secretsmanager put-secret-value \
  --secret-id <secret_prefix>/tessera-log-private-key \
  --secret-string file:///secure/tessera-log-key.pem
```
