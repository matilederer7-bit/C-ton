#!/usr/bin/env node
// FINANCIAL TORTURE LAB — Phase 21: anti-vacuity / mutation testing.
//
// Applies one deliberate defect at a time to a THROWAWAY working copy of the
// source (this worktree; every mutation is reverted with `git checkout --`),
// runs the lab suite(s) that are supposed to catch it, and records whether the
// suite went RED. A mutation that stays GREEN means the tests are insufficient
// for that invariant — reported honestly, never hidden.
//
// Usage: node scripts/financial_lab_mutations.cjs [mutationId ...] [--report path]
// Requires a clean git tree for the mutated files (checked before start).

const { spawnSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MUTATIONS = [
  { id: "M01_unknown_fencing_503_declared", invariant: "UNKNOWN fencing (post-dispatch 5xx/429 is UNKNOWN, not a declared failure)", file: "src/payment_provider.ts",
    from: `  if (status === 408 || status === 425 || status === 429 || status >= 500 || status < 400) return "unknown";`,
    to: `  if (status === 408 || status === 425 || status < 400) return "unknown"; return "declared_failure";`,
    suites: [["payments", "payment_lab_c1_c2"]] },
  { id: "M02_recovery_blocking_removed", invariant: "recovery blocked behind an unresolved/executed capture (app layer)", file: "src/payment_attempt_helpers.ts",
    from: `        blocking = rows.find((row) => row.attempt_type === "charge_start" && (row.result_class === "unknown" || row.result_class === "success"));`,
    to: `        blocking = undefined;`,
    suites: [["payments", "payment_lab_refund_release_recovery"], ["payments", "payment_lab_c1_c2"]] },
  { id: "M03_refund_ambiguity_retry", invariant: "refund ambiguity fencing (UNKNOWN refund never re-fired blindly)", file: "src/app.ts",
    from: `    if (outcome === "unknown" || outcome === "success") {`,
    to: `    if (outcome === "unknown") { await settle("pre_dispatch_failure", "mutant"); throw new Error("temporary_fail refund mutant"); }\n    if (outcome === "success") {`,
    suites: [["payments", "payment_lab_refund_release_recovery"]] },
  { id: "M04_identity_rotation", invariant: "operation identity persistence (no fresh identity while prior is unresolved)", file: "src/payment_attempt_helpers.ts",
    from: `      const unresolved = [...sameType].reverse().find((row) => row.result_class === "unknown" || row.result_class === "success");`,
    to: `      const unresolved = undefined as PaymentAttemptLifecycleRow | undefined;`,
    suites: [["payments", "payment_lab_lifecycle_reconcile"], ["payments", "payment_lab_c1_c2"]] },
  { id: "M05_arm_cas_removed", invariant: "payment_attempt lifecycle CAS (arming an identity another live owner is dispatching)", file: "src/payment_attempt_helpers.ts",
    from: `           AND NOT (\n             dispatch_state='dispatching'\n             AND (owner_event_uuid IS DISTINCT FROM $5::uuid OR owner_lease_generation IS DISTINCT FROM $6::integer)\n             AND siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation)\n           )`,
    to: `           AND TRUE`,
    suites: [["payments", "payment_lab_lifecycle_reconcile"]] },
  { id: "M06_ledger_skipped", invariant: "ledger/state atomicity (fee ledger written with the state)", file: "src/platform_fee_money.ts",
    from: `  async function recordProviderFinancialEventInTx(c: any, args: ProviderMoneyEventInput) {\n    {`,
    to: `  async function recordProviderFinancialEventInTx(c: any, args: ProviderMoneyEventInput) {\n    if (args.event_type === "charge_captured") return { inserted: false, skipped: "mutant" } as any;\n    {`,
    suites: [["payments", "payment_lab_foundation"]] },
  { id: "M07_reconcile_deferral_removed", invariant: "reconciliation deferral while the exact operation is in flight", file: "src/app.ts",
    from: `  const inFlight = await anyOperationInFlight(participantId, dealId);`,
    to: `  const inFlight = null as Awaited<ReturnType<typeof anyOperationInFlight>>;`,
    suites: [["payments", "payment_lab_c1_c2"]] },
  { id: "M08_late_event_protection_removed", invariant: "late economically-real event never discarded silently (contradiction case)", file: "src/app.ts",
    from: `  if (!contradiction) return;`,
    to: `  if (!contradiction || moneyState.length >= 0) return;`,
    suites: [["payments", "payment_lab_terminal_economics"], ["payments", "payment_lab_c1_c2"]] },
  { id: "M09_duplicate_webhook_protection_removed", invariant: "duplicate webhook protection (same provider event id processed once)", file: "src/webhook_ingestion.ts",
    from: `      if (!existing.rowCount) {`,
    to: `      if (true) { await c.query(\`DELETE FROM siton.webhook_events WHERE provider=$1 AND event_id=$2\`, [input.provider, input.event_id]);`,
    suites: [["payments", "payment_lab_terminal_economics"]] },
  { id: "M10_lease_ownership_removed", invariant: "worker lease ownership at arm time", file: "src/payment_attempt_helpers.ts",
    from: `      if (Number(lease.rowCount || 0) !== 1) return "lease_lost" as const;`,
    to: `      void lease;`,
    suites: [["concurrency", "payment_lab_concurrency_matrix"], ["payments", "payment_lab_crash_matrix"]] },
  { id: "M11_fee_7_percent", invariant: "Siton fee = exactly 8 % (7 %)", file: "src/platform_fee_money.ts",
    from: `export const SITON_PLATFORM_FEE_RATE = 0.08;`, to: `export const SITON_PLATFORM_FEE_RATE: number = 0.07;`,
    suites: [["payments", "payment_lab_terminal_economics"]] },
  { id: "M12_fee_9_percent", invariant: "Siton fee = exactly 8 % (9 %)", file: "src/platform_fee_money.ts",
    from: `export const SITON_PLATFORM_FEE_RATE = 0.08;`, to: `export const SITON_PLATFORM_FEE_RATE: number = 0.09;`,
    suites: [["payments", "payment_lab_terminal_economics"]] },
  { id: "M13_vat_included_in_fee_base", invariant: "buyer VAT excluded from the fee base", file: "src/platform_fee_money.ts",
    from: `  const feeBaseAmount = roundMoney(Math.max(0, grossAmount - vatAmount));`, to: `  const feeBaseAmount = roundMoney(Math.max(0, grossAmount));`,
    suites: [["payments", "payment_lab_terminal_economics"]] },
  { id: "M14_delivery_excluded", invariant: "delivery included in the fee base", file: "src/platform_fee_money.ts",
    from: `  const grossAmount = productGross + deliveryGross;`, to: `  const grossAmount = productGross;`,
    suites: [["payments", "payment_lab_terminal_economics"]] },
  { id: "M15_distributor_commission", invariant: "distributor commission / payout / revenue share = 0", file: "src/platform_fee_money.ts",
    from: `  const sellerNetAmount = roundMoney(grossAmount - platformFeeTotalAmount);`, to: `  const sellerNetAmount = roundMoney(grossAmount - platformFeeTotalAmount - grossAmount * 0.05);`,
    suites: [["payments", "payment_lab_terminal_economics"]] },
  { id: "M16_recovery_preflight_removed", invariant: "F-1 recovery pre-flight (original capture re-verified before a second capture)", file: "src/app.ts",
    // the pre-flight is neutralised entirely (always "proceed"): a mutation that only
    // dropped the captured branch still blocked the recovery through the ambiguous
    // deferral and therefore survived without proving anything
    from: `  const reference = String(args.authorization_id || "").trim();\n  if (!paymentProvider.status || !reference) return "proceed";`,
    to: `  const reference = String(args.authorization_id || "").trim();\n  if (!paymentProvider.status || !reference || reference.length >= 0) return "proceed";`,
    suites: [["payments", "payment_lab_lifecycle_reconcile"]] },
  { id: "M17_recovery_preflight_single_read", invariant: "F-9 recovery pre-flight reads the status twice; a flapping provider holds the recovery", file: "src/app.ts",
    // back to ONE status read: the pinned fuzz schedule (failed <-> captured) and the
    // disagreeing-negatives scenario must both turn red
    from: `  for (let i = 0; i < 2; i++) {
    if (i > 0 && confirmMs > 0) await new Promise((resolve) => setTimeout(resolve, confirmMs));`,
    to: `  for (let i = 0; i < 1; i++) {
    if (i > 0 && confirmMs > 0) await new Promise((resolve) => setTimeout(resolve, confirmMs));`,
    suites: [["payments", "payment_lab_refund_release_recovery"]] },

  // ── Independent financial review (migration 064 + F-6 + identity + Grow) ─────
  // Every invariant the review added has a red mutant. A mutation may touch several
  // files (`files`); all are applied together and restored together.
  { id: "M18_settlement_horizon_fence_removed", invariant: "settlement horizon fences automatic recovery (app fence AND DB predicate)",
    files: [
      { file: "src/payment_attempt_helpers.ts",
        from: `    const value = r.rows[0]?.fence;\n    if (!value) return null;`,
        to: `    const value = null as any; void r;\n    if (!value) return null;` },
      { file: "src/migrations/064_payment_settlement_horizon.sql",
        from: `    AND pa.settlement_horizon_at > clock_timestamp();\n$$;`,
        to: `    AND pa.settlement_horizon_at > clock_timestamp() AND false;\n$$;` }
    ],
    suites: [["payments", "payment_review_settlement_horizon"], ["payments", "payment_review_adversarial"]] },
  { id: "M19_f6_release_proof_removed", invariant: "F-6: AuthReleased only through the provider-proofed release rail (never by assumption on recovery_failed)", file: "src/app.ts",
    from: `    await schedulePaymentRelease({ participant_id: args.target.participant_id, deal_id: args.target.deal_id, reason: "recovery_failed" }).catch(() => undefined);`,
    to: `    await applyAuthorizationRelease(args.target.participant_id, args.target.deal_id, requestId, args.event.correlation_id ?? null); // MUTANT: released by assumption`,
    suites: [["payments", "payment_review_adversarial"]] },
  { id: "M20_currency_check_removed", invariant: "currency is part of the exact-operation identity (reconcile)", file: "src/app.ts",
    from: `  if (status.currency && operation !== "release" && String(status.currency).toUpperCase() !== expectedCurrency) {`,
    to: `  if (false && status.currency && operation !== "release" && String(status.currency).toUpperCase() !== expectedCurrency) {`,
    suites: [["payments", "payment_review_adversarial"]] },
  { id: "M21_grow_failed_status_verdict", invariant: "Grow fail-closed: a 'failed' status after dispatch is not a verdict for a provider without exact-operation status", file: "src/app.ts",
    from: `    if (status.state === "failed" || (status.state === "authorized" && status.final)) {\n      if (!policy.negative_status_authoritative) {`,
    to: `    if (status.state === "failed" || (status.state === "authorized" && status.final)) {\n      if (status.state !== "failed" && !policy.negative_status_authoritative) {`,
    suites: [["payments", "payment_review_grow_negative_status"]] },
  { id: "M22_status_echo_rewrites_binding", invariant: "exact-operation identity: a status echo never rewrites the durable provider reference (O-1)", file: "src/app.ts",
    from: `    // Exact-operation identity (independent financial review, O-1): a status\n    // READ never rewrites the participant's durable provider reference. Only the`,
    to: `    if (status.provider_reference) await paymentBindings.updateProviderReferenceForParticipant(participantId, status.provider_reference).catch(() => undefined); // MUTANT\n    // (mutated) a status READ rewrites the participant's durable provider reference. Only the`,
    suites: [["payments", "payment_review_adversarial"]] },
  { id: "M23_mock_status_fabricated", invariant: "mock provider status is truthful (never a fabricated 'captured')", file: "src/payment_provider.ts",
    from: `state: mockExecutedState(input.provider_reference, input.operation), amount_minor: null`,
    to: `state: input.operation === "capture" ? "captured" : mockExecutedState(input.provider_reference, input.operation), amount_minor: null`,
    suites: [["payments", "payment_review_mock_provider_truth"]] },
  { id: "M24_preflight_unverifiable_proceeds", invariant: "recovery pre-flight holds on an unverifiable status unless the failure is exact-request evidence", file: "src/app.ts",
    from: `    if (exactDecline) return "proceed";`,
    to: `    if (exactDecline || !exactDecline) return "proceed";`,
    suites: [["payments", "payment_review_adversarial"]] },
  { id: "M25_finalize_horizon_fence_removed", invariant: "the terminal deal decision waits for the settlement horizon", file: "src/app.ts",
    from: `  if (fencedCaptures.length > 0) {\n    const until = new Date(String(fencedCaptures[fencedCaptures.length - 1]!.settlement_horizon_at));`,
    to: `  if (fencedCaptures.length > 0 && false) {\n    const until = new Date(String(fencedCaptures[fencedCaptures.length - 1]!.settlement_horizon_at));`,
    suites: [["payments", "payment_review_settlement_horizon"]] },
  { id: "M26_release_fence_removed", invariant: "the settlement horizon fences the release rail (no release-then-capture)", file: "src/payment_attempt_helpers.ts",
    from: `      if (args.attempt_type === "recovery" || args.attempt_type === "release") {\n        const fence = await settlementFenceInTx(c, args.participant_id, args.deal_id);`,
    to: `      if (args.attempt_type === "recovery") {\n        const fence = await settlementFenceInTx(c, args.participant_id, args.deal_id);`,
    suites: [["payments", "payment_review_settlement_horizon"]] },
  { id: "M27_inferred_failure_marked_exact", invariant: "provenance: a status-inferred failure is never recorded as exact-request evidence", file: "src/app.ts",
    // The primary provenance site: the canonical charge_failed / recovery_failed
    // transition settles the identity INSIDE the state transaction with the
    // evidence derived from the event source. (The reconcile's later
    // finalizeAttemptResult only converges an identity the transition did not
    // touch — mutating it alone is a dead site and survived for that reason.)
    from: `  const failureEvidence = inferredSources.includes(eventSource) ? "status_inference" : "provider_event";`,
    to: `  const failureEvidence = "dispatch_response"; void inferredSources; void eventSource; // MUTANT`,
    suites: [["payments", "payment_review_settlement_horizon"], ["payments", "payment_review_adversarial"]] },
  { id: "M28_horizon_not_opened_at_dispatch", invariant: "a capture-side dispatch opens the settlement horizon on the identity", file: "src/app.ts",
    from: `      ? providerAmbiguityPolicy(paymentProvider).settlement_horizon_ms\n      : null`,
    to: `      ? null\n      : null`,
    suites: [["payments", "payment_review_settlement_horizon"], ["payments", "payment_review_adversarial"]] },
  { id: "M29_stale_identity_settled_from_sibling_evidence", invariant: "a reconcile carrying a terminal identity steps aside while a sibling identity is unresolved (evidence tied to the exact identity)", file: "src/app.ts",
    from: `    if (otherUnresolved) return; // FR-4: the unresolved sibling identity owns this verdict`,
    to: `    if (otherUnresolved && false) return; // MUTANT`,
    suites: [["payments", "payment_review_findings_reconstruction"]] },
  { id: "M30_finalize_ignores_success_unpersisted", invariant: "R-11: the terminal decision waits for an executed capture whose canonical state is not yet applied", file: "src/app.ts",
    from: `           OR (pa.result_class='success' AND p.money_state NOT IN ('ChargedSuccess','RecoveredCharge','Refunded'))`,
    to: `           OR (pa.result_class='success' AND false)`,
    suites: [["payments", "payment_review_findings_reconstruction"]] },
  { id: "M31_completed_deal_sweep_removed", invariant: "R-11: a finalize retried on a Completed deal completes every paid participant", file: "src/app.ts",
    from: `    await completeParticipantsOfCompletedDeal(dealId, eventId);\n    return;`,
    to: `    return; // MUTANT: no sweep`,
    suites: [["payments", "payment_review_findings_reconstruction"]] }
];

const args = process.argv.slice(2);
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;
const selected = args.filter((a, i) => !a.startsWith("--") && !(reportIdx >= 0 && i === reportIdx + 1));
const toRun = selected.length ? MUTATIONS.filter((m) => selected.some((id) => m.id === id || m.id.startsWith(`${id}_`))) : MUTATIONS;
if (selected.length && !toRun.length) { console.error(`no mutation matches: ${selected.join(", ")}`); process.exit(2); }

function normalizeEol(text, eol) { return text.replace(/\r\n/g, "\n").split("\n").join(eol); }
function readFile(file) { return fs.readFileSync(file, "utf8"); }

const dirty = execSync("git status --porcelain -- src", { encoding: "utf8" }).trim();
if (dirty) { console.error("refusing to mutate: src has uncommitted changes:\n" + dirty); process.exit(2); }

const results = [];
for (const m of toRun) {
  // one or several files per mutation; applied together, restored together
  const edits = (m.files || [{ file: m.file, from: m.from, to: m.to }]).map((e) => ({ ...e, original: readFile(e.file) }));
  const missing = edits.find((e) => { const eol = e.original.includes("\r\n") ? "\r\n" : "\n"; return !e.original.includes(normalizeEol(e.from, eol)); });
  if (missing) { results.push({ id: m.id, invariant: m.invariant, outcome: "ANCHOR_MISSING", suites: [] }); console.log(`[${m.id}] ANCHOR_MISSING in ${missing.file}`); continue; }
  for (const e of edits) {
    const eol = e.original.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(e.file, e.original.replace(normalizeEol(e.from, eol), normalizeEol(e.to, eol)));
  }
  console.log(`\n[${m.id}] applied to ${edits.map((e) => e.file).join(", ")} — ${m.invariant}`);
  const suiteResults = [];
  try {
    for (const [group, pattern] of m.suites) {
      const startedAt = Date.now();
      const run = spawnSync(process.execPath, ["scripts/run_test_group.cjs", group], { env: { ...process.env, TEST_FILE_PATTERN: pattern }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const out = `${run.stdout || ""}\n${run.stderr || ""}`;
      const summary = (out.match(/^SUMMARY .*$/gm) || []).slice(-1)[0] || "";
      const compileFailed = /error TS\d+/.test(out);
      const status = run.status === 0 ? "GREEN" : compileFailed ? "COMPILE_ERROR" : "RED";
      suiteResults.push({ group, pattern, status, summary, seconds: Math.round((Date.now() - startedAt) / 1000) });
      console.log(`  ${pattern}: ${status} (${Math.round((Date.now() - startedAt) / 1000)}s) ${summary}`);
      if (status === "RED") break;
    }
  } finally {
    for (const e of edits) {
      execSync(`git checkout -- "${e.file}"`);
      // git autocrlf may hand a NEW file back with CRLF; compare content, not line endings
      const normalize = (text) => text.split("\r\n").join("\n");
      if (normalize(readFile(e.file)) !== normalize(e.original)) { console.error(`  RESTORE FAILED for ${e.file}`); process.exit(3); }
    }
  }
  const caught = suiteResults.some((s) => s.status === "RED");
  const compileError = suiteResults.some((s) => s.status === "COMPILE_ERROR");
  results.push({ id: m.id, invariant: m.invariant, outcome: caught ? "CAUGHT" : compileError ? "COMPILE_ERROR" : "SURVIVED", suites: suiteResults });
  console.log(`  => ${caught ? "CAUGHT" : compileError ? "COMPILE_ERROR (mutation invalid, not evidence)" : "SURVIVED — tests insufficient for this invariant"}`);
}

const caught = results.filter((r) => r.outcome === "CAUGHT").length;
const survived = results.filter((r) => r.outcome === "SURVIVED");
console.log(`\nMUTATION_SUMMARY tested=${results.length} caught=${caught} survived=${survived.length} invalid=${results.filter((r) => r.outcome !== "CAUGHT" && r.outcome !== "SURVIVED").length}`);
for (const r of results) console.log(`  ${r.outcome.padEnd(14)} ${r.id} — ${r.invariant}`);
if (reportPath) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2)); }
process.exit(survived.length ? 1 : 0);
