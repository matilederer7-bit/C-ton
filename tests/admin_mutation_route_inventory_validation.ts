import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// R5C regression: NO administrative mutation route (POST/PATCH/PUT/DELETE under
// /api/admin) may be guarded by the shared bootstrap key alone. Every mutation
// must resolve a named admin identity via requireAdminMutation or
// requireAdminAuthContext. This guards against a future edit silently reverting
// an admin mutation to shared-key-only authority.

const source = await readFile("src/frontend_runtime.ts", "utf8");

// Split the file into route blocks. Each block starts at an `app.<method>("...`
// registration (2-space indent) and runs until the next registration.
const routeRe = /\n  app\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g;
type Block = { method: string; path: string; start: number };
const starts: Block[] = [];
let m: RegExpExecArray | null;
while ((m = routeRe.exec(source))) {
  starts.push({ method: m[1]!.toLowerCase(), path: m[2]!, start: m.index });
}

const MUTATION = new Set(["post", "patch", "put", "delete"]);
const adminMutations = starts.filter((b) => MUTATION.has(b.method) && /^\/api\/admin\//.test(b.path));

// Routes that are legitimately unauthenticated admin *auth* endpoints (login /
// MFA challenge) — they establish identity and cannot themselves require one.
const AUTH_BOOTSTRAP = new Set([
  "/api/admin/auth/login",
  "/api/admin/auth/mfa/verify",
  "/api/admin/auth/mfa/setup",
  "/api/admin/auth/mfa/disable",
  "/api/admin/auth/logout"
]);

let passed = 0, failed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.message || e}`); failed++; }
}

ok("admin mutation routes were discovered", () => {
  assert.ok(adminMutations.length >= 12, `expected to find admin mutation routes, found ${adminMutations.length}`);
});

const offenders: string[] = [];
for (let i = 0; i < adminMutations.length; i++) {
  const block = adminMutations[i]!;
  if (AUTH_BOOTSTRAP.has(block.path)) continue;
  // Body = from this registration to the next registration (or +4000 chars).
  const next = starts.find((b) => b.start > block.start);
  const body = source.slice(block.start, next ? next.start : block.start + 4000);
  const named = /requireAdminMutation\(|requireAdminAuthContext\(/.test(body);
  if (!named) offenders.push(`${block.method.toUpperCase()} ${block.path}`);
}

ok("every admin mutation route requires a named admin identity (no shared-key-only mutations)", () => {
  assert.deepEqual(offenders, [], `shared-key-only admin mutations detected:\n  ${offenders.join("\n  ")}`);
});

// Positive spot-checks: the P0 routes must reference requireAdminMutation.
const P0_ROUTES = [
  "/api/admin/sellers/:sellerId/status",
  "/api/admin/seller-auth/:sellerId/provision",
  "/api/admin/distributor-auth/:affiliateId/provision",
  "/api/admin/kyc/:subjectType/:subjectId/decision",
  "/api/admin/support-cases",
  "/api/admin/support-cases/:caseId",
  "/api/admin/support-cases/:caseId/escalate"
];
for (const path of P0_ROUTES) {
  ok(`P0 route uses named-admin gate: ${path}`, () => {
    const block = adminMutations.find((b) => b.path === path);
    assert.ok(block, `route ${path} not found among admin mutations`);
    const next = starts.find((b) => b.start > block!.start);
    const body = source.slice(block!.start, next ? next.start : block!.start + 4000);
    assert.match(body, /requireAdminMutation\(/, `${path} must gate with requireAdminMutation`);
  });
}

console.log(`\nADMIN_MUTATION_ROUTE_INVENTORY ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
