#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const workspaceScript = path.join(__dirname, "agent_workspace.cjs");
const ciSummaryScript = path.join(__dirname, "ci_failure_summary.cjs");

function ensureAgent(agent) {
  if (!["codex", "claude"].includes(agent)) throw new Error("agent must be codex or claude");
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(), env: process.env, encoding: "utf8"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`helper terminated by signal ${result.signal}`);
  if (typeof result.status !== "number") throw new Error("helper did not return an exit status");
  if (result.status !== 0) process.exit(result.status);
}

function normalizeTarget(parts) {
  const target = parts.join(" ").trim();
  if (!target) throw new Error("review/handoff target is required");
  return target;
}

function printHelp() {
  console.log(`SITON_AGENT_COMMANDS
setup
status
doctor
start <codex|claude> <task> [--scope ...] [--do-not-touch ...] [--mode builder|reviewer]
review <codex|claude> <PR|commit|branch>
handoff <PR|commit|branch>
finish <codex|claude> --completed ... --tested ... --open ... --percentage ... --next ... [--message ...]
ci [run-id|latest]
plan

Owner default:
node scripts/agent.cjs start claude "<task>"

One-time local activation:
node scripts/agent.cjs setup`);
}

function review(agent, parts) {
  ensureAgent(agent);
  const target = normalizeTarget(parts);
  console.log(`AGENT=${agent}`);
  console.log("MODE=reviewer");
  console.log(`REVIEW=${target}`);
  console.log("RULES=read actual diff; stay read-only; verify relevant tests; return compact verdict; do not duplicate builder work");
}

function handoff(parts) {
  const target = normalizeTarget(parts);
  console.log(`HANDOFF=${target}`);
  console.log("SOURCE_OF_TRUTH=PR/commit diff and checks");
  console.log("INCLUDE_ONLY=goal; changed; tested; known blocker; next action");
}

function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (["setup", "status", "doctor", "plan"].includes(command)) return runNode(workspaceScript, [command]);
  if (command === "start") {
    ensureAgent(args[0]);
    return runNode(workspaceScript, ["start", ...args]);
  }
  if (command === "finish") {
    ensureAgent(args[0]);
    return runNode(workspaceScript, ["finish", ...args]);
  }
  if (command === "ci") return runNode(ciSummaryScript, args.length ? args : ["latest"]);
  if (command === "review") return review(args[0], args.slice(1));
  if (command === "handoff") return handoff(args);
  throw new Error(`unknown command: ${command}`);
}

try { main(); } catch (error) {
  console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
