import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OperationalRepairError,
  applyOperationalRepair,
  dryRunOperationalRepair,
  inspectOperationalRepair,
  validateOperationalRepairActorId,
  validateOperationalRepairPlan,
  type OperationalRepairPlan,
  type OperationalRepairRepository,
  type OperationalRepairRequest,
  type OperationalRepairSnapshot
} from "./operational_repair.js";

type CliMode = "inspect" | "dry-run" | "apply";

type CliArgs = {
  mode: CliMode;
  input: string | null;
  expectedPlanHash: string | null;
  confirmApply: string | null;
  repositoryModule: string | null;
  actorId: string | null;
  help: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    mode: "inspect",
    input: null,
    expectedPlanHash: null,
    confirmApply: null,
    repositoryModule: null,
    actorId: null,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") parsed.help = true;
    else if (key === "--mode") parsed.mode = String(argv[++index] || "") as CliMode;
    else if (key === "--input") parsed.input = String(argv[++index] || "");
    else if (key === "--expected-plan-hash") parsed.expectedPlanHash = String(argv[++index] || "");
    else if (key === "--confirm-apply") parsed.confirmApply = String(argv[++index] || "");
    else if (key === "--repository-module") parsed.repositoryModule = String(argv[++index] || "");
    else if (key === "--actor-id") parsed.actorId = String(argv[++index] || "");
    else throw new OperationalRepairError("unknown_cli_argument", { argument: key });
  }
  if (!["inspect", "dry-run", "apply"].includes(parsed.mode)) {
    throw new OperationalRepairError("invalid_repair_mode", { mode: parsed.mode });
  }
  return parsed;
}

function usage() {
  return [
    "Siton Stage 32B operational repair",
    "",
    "Inspect (default):",
    "  tsx src/operational_repair_cli.ts --input <sanitized-snapshot.json>",
    "Dry-run:",
    "  tsx src/operational_repair_cli.ts --mode dry-run --input <sanitized-snapshot.json>",
    "Apply (never implicit; requires a separately reviewed repository adapter):",
    "  tsx src/operational_repair_cli.ts --mode apply --input <plan.json>",
    "    --expected-plan-hash <sha256> --confirm-apply STAGE32B_APPLY",
    "    --repository-module <reviewed-local-adapter.mjs> --actor-id <operator-id>",
    "",
    "Inspect/dry-run input: { \"request\": {...}, \"snapshot\": {...} }",
    "Apply input: { \"plan\": {...} }",
    "The CLI never discovers targets and never accepts wildcard identifiers."
  ].join("\n");
}

async function readJson(file: string | null): Promise<Record<string, unknown>> {
  if (!file) throw new OperationalRepairError("repair_input_required");
  const raw = await readFile(resolve(file), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OperationalRepairError("repair_input_invalid");
  }
  return parsed as Record<string, unknown>;
}

async function loadRepository(modulePath: string | null): Promise<OperationalRepairRepository> {
  if (!modulePath) throw new OperationalRepairError("apply_repository_adapter_required");
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href);
  const factory = (loaded as { createOperationalRepairRepository?: unknown }).createOperationalRepairRepository;
  if (typeof factory !== "function") {
    throw new OperationalRepairError("apply_repository_adapter_invalid");
  }
  const repository = await factory();
  if (!repository || typeof repository.transaction !== "function") {
    throw new OperationalRepairError("apply_repository_adapter_invalid");
  }
  return repository as OperationalRepairRepository;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const input = await readJson(args.input);
  if (args.mode === "inspect" || args.mode === "dry-run") {
    const request = input.request as OperationalRepairRequest;
    const snapshot = input.snapshot as OperationalRepairSnapshot;
    const result = args.mode === "inspect"
      ? inspectOperationalRepair(request, snapshot)
      : dryRunOperationalRepair(request, snapshot);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.confirmApply !== "STAGE32B_APPLY") {
    throw new OperationalRepairError("explicit_apply_confirmation_required");
  }
  const plan = input.plan as OperationalRepairPlan;
  if (!plan || typeof plan !== "object") throw new OperationalRepairError("repair_plan_required");
  validateOperationalRepairPlan(plan);
  if (plan.status === "blocked") {
    throw new OperationalRepairError("repair_plan_blocked", { reason_code: plan.reason_code });
  }
  if (plan.status !== "repairable" || !plan.proposed_change) {
    throw new OperationalRepairError("repair_plan_not_actionable", { reason_code: plan.reason_code });
  }
  if (!args.expectedPlanHash || args.expectedPlanHash !== plan.plan_hash) {
    throw new OperationalRepairError("expected_plan_hash_mismatch");
  }
  if (!args.actorId) throw new OperationalRepairError("apply_actor_id_required");
  const actorId = validateOperationalRepairActorId(args.actorId);
  const repository = await loadRepository(args.repositoryModule);
  const result = await applyOperationalRepair(plan, repository, actorId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof OperationalRepairError) {
    console.error(JSON.stringify({ ok: false, error: error.code, context: error.context }));
  } else {
    console.error(JSON.stringify({ ok: false, error: "operational_repair_failed" }));
  }
  process.exitCode = 1;
});
