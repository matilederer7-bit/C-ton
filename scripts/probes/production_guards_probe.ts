// Executes the REAL boot-time production guard against an environment map
// supplied on stdin as JSON: { "role": "web" | "worker", "env": { ... } }.
// Prints one JSON line: { ok: boolean, error: string | null }.
// Used by scripts/startup_config_matrix.cjs. Never mutates process.env, never
// opens a database, never calls a provider.
import { assertProductionRuntimeGuards } from "../../src/production_guards.ts";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input || "{}") as { role?: "web" | "worker"; env?: Record<string, string> };
  const role = parsed.role === "worker" ? "worker" : "web";
  const env = parsed.env || {};
  try {
    assertProductionRuntimeGuards(role, env as NodeJS.ProcessEnv);
    process.stdout.write(JSON.stringify({ ok: true, error: null }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((error as Error)?.message || error) }) + "\n");
  }
});
