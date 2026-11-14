---
name: Policy Authoring
description: Author policy packages that gate the skill/agent lifecycle.
triggers: [add a rule, policy check, enforce a constraint]
capabilities:
  - register a versioned policy package
  - record machine-readable violations
constraints:
  - certification is bound to policy/ontology versions
tags: [platform, policy, topic:platform]
---
# Policy Authoring

Encode validation rules that gate `draft → validated` and certification.

## When to use

- Built-in graph-shape checks are not enough.
- You want reusable, versioned policy for a class of skills.

## Inputs → Outputs

- **In:** a SHACL-like policy package authored as a CAS artifact.
- **Out:** a versioned package whose violations are recorded (with paths) at validation.

## Steps

1. Author the policy package and register it (CAS artifact + version).
2. Bind it so `validate` records violations via `tg:validatedBy`.
3. Certify — bound to the policy and ontology versions in effect.

## Example

> **Prompt:** "Explain how a policy package gates draft → validated."
> **Result:** the policy version, the violation report shape, and how certification references it.

## Constraints

- Policy packages are versioned; certification records the exact versions used.
