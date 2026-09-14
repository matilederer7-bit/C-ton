# UX pre-merge hardening — 2026-09-14

Branch: `codex/ux-premerge-hardening-night`.
Start: exact UX SHA `9ce6df986c7c8d230dbce1c36e4138b3a5210331`.
Canonical master verified: `82c91d62fd092350748405c8aec15a23d0e2af5e`.
Worktree: `.worktrees/ux-premerge-hardening-night`.

The financial branch exists and was not checked out, merged, or edited.
`claude/launch-ux-cleanup` and `claude/backend-sensitive-ux-plan` were consulted
read-only. All changes in this pass are frontend presentation, UX proofs/tests,
or this report and project status. The pre-existing UX baseline's runtime
projection is inherited; this pass does not edit `src/frontend_runtime.ts`.

## Known regressions closed

* **Unpaid completed deal:** a non-ready applicable pickup now renders its
  canonical status independently of receipt existence. `payment_pending`, failed
  and refunded/unavailable states expose neither order code nor QR. The existing
  ready pickup path remains gated by the entitlement response. Rendered proof
  deliberately supplies sentinel credentials to non-ready fixtures and asserts
  they do not appear. Entitlement results are also scoped to participant/token,
  preventing an old result from appearing when those props change.
* **Early participation:** a summary CTA appears beside the price and group
  threshold in the first panel. It calls the exact same `startJoin` as the order
  panel and mobile bar. Quantity and receipt readiness checks apply to every
  entry. The mobile bar waits until the summary leaves the viewport, hides for
  dialogs and the canonical CTA, and remains absent on desktop. Reserved space
  includes the safe-area inset and app-footer clearance.

## Additional concrete defects fixed

1. Quantity paste stripped punctuation/signs (`1.5` → `15`, `-2` → `2`). Invalid
   text is now retained for correction and never becomes an accepted integer.
2. Invalid/empty buyer quantity could submit the previous valid value. All join
   entries now refuse it and return focus to the quantity control.
3. Seller minimum could silently become one when empty; fractional seller
   quantities passed frontend validation. Create/edit fields now use numeric
   keyboard text inputs and validate positive safe integers without changing
   the backend's quantity rules.
4. Modal and pickup overlays did not contain keyboard focus or restore the
   trigger. A shared helper now handles Tab, Shift-Tab and focus return.
5. Field-attention scrolling ignored reduced motion. It now uses immediate
   scrolling for that preference; the existing static error ring remains.
6. Invalid receipt instructions/URL targeted the entire fieldset. The exact
   textarea/input now receives the existing canonical attention attributes.
7. Public profile name validation lacked canonical attention. Empty/whitespace
   names target that input and clear on the first valid character.
8. Delivery edit validation displayed generic errors. It now targets the
   missing row label (or add-option control for an empty list), and clears on
   valid input using `settleErrors`.
9. Publish consent errors did not target the missing checkboxes. Both now use
   `fieldAttention`, with focus on the first missing consent.
10. Empty CMS sections caused `sections.home.value` to throw. Empty data now has
    an explicit state; a non-home first section can be selected safely.
11. A missing CMS document remained on “loading” indefinitely. Loading, missing
    content and request failure are now distinguished within the native shell.
12. Public seller profile failures showed raw API messages. They now have a
    native panel and clear Hebrew failure copy.
13. Async dashboard content could shift restored history position by 32px.
    Existing bounded restoration now stabilizes layout shifts and cancels on
    wheel, touch, pointer or navigation-key input. Disposal cancels pending work.
14. Seller and buyer join labels were not associated with their controls.
    Required seller controls and join controls now have explicit associations.

Copy/native share controls in the compact public share block also use the
existing white circular social-button treatment. The two remaining decorative
pilot test-tube glyphs were removed without changing disclosure text. Long
seller names retain safe wrapping; disabled choice cards communicate their state.

## Audit and browser evidence

`node scripts/ux_polish_round2_browser_proof.cjs --shots=<directory>` builds the
real React components against deterministic local API fixtures and drives Edge
through CDP. Additional cases live in `scripts/ux_premerge_browser_checks.cjs`.
`--only=history` is a short focused interaction/history rerun.

**Full expanded proof: 324 passed, 0 failed.**
Viewports: **390×844, 430×932, 768×1024, 1280×800, 1440×900**, plus **320×844**.
Zero horizontal overflow and zero captured application console errors.

| Surface/contract | Evidence and verdict |
|---|---|
| Guest/pilot and home | Real landing, disclosure without glyph, current bilingual copy; real App Mall feature-flag navigation |
| Mall | Populated and empty fixtures; rendered sweep and real card navigation |
| Public deal/join | Early CTA is within initial viewport and hit-testable at all six widths; canonical sheet opens; invalid quantities refused |
| Tracking/entitlement | Real tracking page; pending, failed, refunded/unavailable and ready pickup cards; no ineligible credential exposure |
| Seller onboarding/profile | Business/public profile forms rendered; public name exact attention |
| Seller create/edit | Wizard with real image selection, quantity step and receipt validation; real draft editor; delivery edits and publish consent |
| Seller operations | Dashboard, empty receipts, pickup scanner, empty handoff list at all widths |
| Seller public trust | Logo/name/About/stats/profile links; absent logo/About and long Hebrew/English; private sentinel keys ignored |
| Admin | Dashboard and CMS rendered; direct App admin URL requires step-up, with no public nav admin link |
| Legal/CMS | Real App header/footer/container around content; panel/nav/RTL/section markers; canonical legal source and parser substance unchanged |
| Share | Above “how it works”; network/copy white-circle parity; canonical `/d/:id` URLs; actual copy callback |
| Selection | Orange selected indicator and border, neutral unselected; radio round and checkbox square; single-method receipt contract retained |
| Accessibility | Modal/pickup focus containment and return; labels; exact aria-invalid clearing; reduced-motion static attention |
| Empty/error states | Empty Mall/CMS/receipts/handoff, missing document, deal/tracking/profile API failure |
| History | Mall → deal → back/forward; deal → seller profile → back; legal → back; seller dashboard → draft edit → back |

The baseline's 85-check proof passed before edits, after resolving local browser
process restrictions and copying missing web dependencies into this worktree.
The first expanded pass was 291/309: an incomplete seller dashboard fixture and
an `h3`-omitting assertion caused 18 harness failures. Those were corrected.
The next pass was 312/315: history tests exposed async scroll movement (and one
dependent navigation failure). Focused history checks passed after the fix;
the final complete proof passed 324/324. Screenshots are local `.tmp_ux_shots`
artifacts and are not deployed or bundled into the product.

## Regression gates

The full local suite completed all ten groups. Initial results:

| Group | Initial result |
|---|---|
| Unit | 14 pass / 1 stale source-shape assertion failure |
| Integration | 30 pass / 1 missing local mobile-build artifact failure |
| Database | 8/8 |
| API | 44/44 |
| Workers | 13/13 |
| Payments | 29/29 |
| Security | 40/40 |
| Concurrency | 7/7 |
| Failure | 9/9 |
| E2E | 13/13 |

The CTA source assertion now verifies the quantity guard, receipt-readiness guard
and shared summary handler instead of requiring the old single-line function.
Pilot assertions now require the same disclosure without the removed glyph.
No assertions were simply deleted. The requested older “no סיטון” and direct
admin expectations were not present as such in this exact baseline; explicit
rendered regressions now require **C-ton (סיטון)** and **hidden entry plus admin
password step-up**. Existing authorization tests remain intact.

The missing `.mobile_dist/app/index.html` was resolved by running the existing
local mobile build. Corrective tests passed **4/4**, including both initial
failures and both new regression files. Final complete reruns passed **unit
16/16** and **integration 31/31**. All **210 distinct test files** passed across
the full run and these corrective/final reruns; the initial full run itself
was not a clean pass. Final web TypeScript also passed.

Backend/test and web TypeScript, lint, architecture, runtime-DDL, payment scan,
isolated migration proof (fresh install/repeat/checksum/drift), and route
authorization (static plus four behavioral suites) all passed. Local databases
were disposable and derived only from the verified localhost configuration.

### Production legacy tracking

The new runtime regression exercises **90 real anonymous requests** for a known
participant: all 15 nonempty combinations of `NODE_ENV=production`,
`APP_ENV=production`, `RENDER=true`, and `RENDER_EXTERNAL_URL`, crossed with
unset/demo-preview/production deployment mode and unset/zero legacy override.
Every case has `legacy_links_allowed=false`, returns 401
`tracking_token_required`, and contains no buyer PII.

Explicit `TRACKING_LEGACY_COMPAT=1` is the existing compatibility override, not a
production default. Its existing live-readiness blocker is pinned; this pass
does not redesign that configuration or claim it cannot be explicitly enabled.
The existing strict public-seller payload allow-list was not weakened.

## Open items and integration order

Backend dependencies remain **OPEN**: multi-method receipt persistence,
structured FAQ persistence, hero-video storage/migration, backend windowed
virality. None is simulated as a new frontend persistence contract. No new
product decision blocks these frontend fixes. Business-profile partial-save
semantics remain as provided by the backend; they were not changed into a new
onboarding gate.

This is local fixture/browser and isolated database evidence, not certification
of real devices, production data, external share applications or future master.
**AFTER R9C FINANCIAL MERGE:** integrate the resulting master into the UX branch,
resolve conflicts, rerun UX/browser/security gates, then merge UX.
This candidate is **not claimed merge-ready against future master**.

`FINANCIAL_FILES_CHANGED=NO`, `PAYMENT_LOGIC_CHANGED=NO`,
`MIGRATIONS_CREATED=NO`, `GROW_CHANGED=NO`, `DEPLOYMENT_CHANGED=NO`,
`REAL_MONEY=0`, `DEPLOYED=NO`, `MERGED=NO`.
