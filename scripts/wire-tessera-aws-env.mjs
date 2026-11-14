#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const beginMarker = "# BEGIN MANAGED BY make wire-tessera-aws";
const endMarker = "# END MANAGED BY make wire-tessera-aws";

function parseArgs(argv) {
  const options = {
    terraformDir: path.join(repoRoot, "infra/terraform/examples/dev/registry-tessera-aws-backend"),
    appendLogId: "registry-governance-dev",
    sidecarUrl: "http://tessera-sidecar:3400",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--terraform-dir") {
      options.terraformDir = path.resolve(argv[++index] ?? "");
      continue;
    }
    if (arg === "--append-log-id") {
      options.appendLogId = argv[++index] ?? "";
      continue;
    }
    if (arg === "--sidecar-url") {
      options.sidecarUrl = argv[++index] ?? "";
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.appendLogId) {
    throw new Error("--append-log-id cannot be empty");
  }
  if (!options.sidecarUrl) {
    throw new Error("--sidecar-url cannot be empty");
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/wire-tessera-aws-env.mjs [options]

Reads Terraform outputs from the Tessera AWS backend example and writes
managed override blocks into the Compose env files used by:
- service/api
- service/tessera-sidecar
- service/tessera-runtime

Options:
  --terraform-dir <path>   Terraform directory with applied state
  --append-log-id <value>  Transparency append log ID for service/api
  --sidecar-url <value>    Tessera sidecar URL for service/api
  --dry-run                Print planned updates without writing files
  --help                   Show this help
`);
}

function terraformOutput(terraformDir, name) {
  try {
    return execFileSync("terraform", ["output", "-raw", name], {
      cwd: terraformDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(
      `failed to read terraform output "${name}" from ${terraformDir}${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

function buildManagedBlock(lines) {
  return [
    beginMarker,
    "# Generated from Terraform outputs; rerun after terraform apply.",
    ...lines.filter(Boolean),
    endMarker,
  ].join("\n");
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function upsertManagedBlock(existingContent, block) {
  const normalized = existingContent.replace(/\r\n/g, "\n");
  const blockWithNewline = ensureTrailingNewline(block);
  const pattern = new RegExp(`${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "m");

  if (pattern.test(normalized)) {
    return ensureTrailingNewline(normalized.replace(pattern, blockWithNewline));
  }

  const trimmed = normalized.trimEnd();
  if (!trimmed) {
    return blockWithNewline;
  }
  return `${trimmed}\n\n${blockWithNewline}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadBaseEnv(targetPath) {
  if (existsSync(targetPath)) {
    return readFileSync(targetPath, "utf8");
  }
  const examplePath = `${targetPath}.example`;
  if (existsSync(examplePath)) {
    return readFileSync(examplePath, "utf8");
  }
  return "";
}

function writeEnvFile(targetPath, lines, dryRun) {
  const current = loadBaseEnv(targetPath);
  const next = upsertManagedBlock(current, buildManagedBlock(lines));
  const relativePath = path.relative(repoRoot, targetPath);

  if (dryRun) {
    console.log(`Would update ${relativePath}`);
    return;
  }

  writeFileSync(targetPath, next, "utf8");
  console.log(`Updated ${relativePath}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const registryArtifactEnv = terraformOutput(options.terraformDir, "registry_artifact_env")
    .split(/\r?\n/)
    .filter(Boolean);
  const tesseraSidecarEnv = terraformOutput(options.terraformDir, "tessera_sidecar_env")
    .split(/\r?\n/)
    .filter(Boolean);
  const tesseraRuntimeEnv = terraformOutput(options.terraformDir, "tessera_runtime_env")
    .split(/\r?\n/)
    .filter(Boolean);

  writeEnvFile(
    path.join(repoRoot, "service/api/infra/.env"),
    [
      ...registryArtifactEnv,
      `TESSERA_SIDECAR_URL=${options.sidecarUrl}`,
      `TRANSPARENCY_APPEND_LOG_ID=${options.appendLogId}`,
    ],
    options.dryRun,
  );

  writeEnvFile(
    path.join(repoRoot, "service/tessera-sidecar/infra/.env"),
    tesseraSidecarEnv,
    options.dryRun,
  );

  writeEnvFile(
    path.join(repoRoot, "service/tessera-runtime/infra/.env"),
    tesseraRuntimeEnv,
    options.dryRun,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
