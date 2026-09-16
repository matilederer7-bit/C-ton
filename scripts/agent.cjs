#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const workspaceScript = path.join(__dirname, "agent_workspace.cjs");

function ensureAgent(agent) {
  if (!["codex", "claude"].includes(agent)) throw new Error("agent must be codex or claude");
}

function runWorkspace(args) {
  const result = spawnSync(process.execPath, [workspaceScript, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`workspace helper terminated by signal ${result.signal}`);
  if (typeof result.status !== "number") throw new Error("workspace helper did not return an exit status");
  if (result.status !== 0) process.exit(result.status);
}

function normalizeTarget(parts) {
  const target = parts.join(" ").trim();
  if (!target) throw new Error("review/handoff target is required, for example PR #123");
  return target;
}

function printHelp() {
  console.log(`SITON_AGENT_COMMANDS
setup
status
doctor
start <codex|claude> <task>
review <codex|claude> <PR|commit|branch>
handoff <PR|commit|branch>
finish <codex|claude>
plan

Examples:
node scripts/agent.cjs start codex "תיקון תמונות מוכר"
node scripts/agent.cjs review claude "PR #123"
node scripts/agent.cjs status`);
}

function review(agent, parts) {
  ensureAgent(agent);
  const target = normalizeTarget(parts);
  console.log("DONE");
  console.log(`AGENT=${agent}`);
  console.log("MODE=review");
  console.log(`REVIEW: ${target}`);
  console.log("RULES=read actual diff; stay read-only; verify relevant tests; return compact verdict");
}

function handoff(parts) {
  const target = normalizeTarget(parts);
  console.log("DONE");
  console.log(`HANDOFF=${target}`);
  console.log("SOURCE_OF_TRUTH=PR/commit diff and checks");
  console.log("INCLUDE_ONLY=goal; changed; tested; known blocker");
}

function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (["setup", "status", "doctor", "plan"].includes(command)) return runWorkspace([command]);
  if (command === "start") {
    ensureAgent(args[0]);
    if (!args.slice(1).join(" ").trim()) throw new Error("task is required");
    runWorkspace(["start", ...args]);
    console.log("DONE");
    return;
  }
  if (command === "finish") {
    ensureAgent(args[0]);
    runWorkspace(["finish", args[0]]);
    console.log("DONE");
    return;
  }
  if (command === "review") return review(args[0], args.slice(1));
  if (command === "handoff") return handoff(args);
  throw new Error(`unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
