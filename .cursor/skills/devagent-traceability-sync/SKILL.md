---
name: devagent-traceability-sync
description: Keeps `../../../../_devagents/signet/projects/` synchronized with real implementation work in this repository. Use when finishing a meaningful worksession, shipping a vertical slice, adding docs or infra, or moving code so future agents and humans can reconstruct what changed, where, how it was validated, and what was deferred.
---
# Devagent Traceability Sync

## Goal
Leave a reliable implementation trail in `../../../../_devagents/signet/projects/` whenever a meaningful unit of work lands.

## Use this skill when
- finishing a worksession
- adding a new subsystem or infra slice
- moving folders/services and updating docs
- completing a phase or backlog chunk

## Required outputs in this repo

### Worksession folder
Create or update:
- `../../../../_devagents/signet/projects/worksession-XX/README.md`
- `../../../../_devagents/signet/projects/worksession-XX/summary.md`

### Index
Update:
- `../../../../_devagents/signet/projects/README.md`

## What the summary must capture
- goal of the worksession
- what was implemented
- where the code/docs live
- validation performed
- what was deferred

## Workflow
1. Decide whether the work belongs to an existing worksession or a new one.
2. Update the worksession `README.md` with scope and out-of-scope boundaries.
3. Write `summary.md` with concrete file paths and validation notes.
4. Update `../../../../_devagents/signet/projects/README.md` so the new worksession is discoverable.
5. If human or agent docs changed, mention them in the summary.
6. Re-read the `_devagents` files to confirm links and filenames are real.

## Repository-specific expectations
- Use chronological folders such as `worksession-01/`, `worksession-03/`, `worksession-04/`.
- Keep the summary factual, not aspirational.
- Mention deferred work explicitly when the user chose not to do something.
- If a README claims a `summary.md` exists, make sure it actually exists.

## Good summary structure
- `## Summary`
- `### Goal`
- `### Implemented`
- `### Validation`
- `### Deferred`

## Validation
- re-read the created/updated `_devagents` files
- make sure `README.md` indexes point to real folders/files
- verify filenames are spelled consistently

## Output checklist
- [ ] worksession README exists
- [ ] worksession summary exists
- [ ] `../../../../_devagents/signet/projects/README.md` updated
- [ ] changed docs/infra/code mentioned
- [ ] validation and deferred items recorded
