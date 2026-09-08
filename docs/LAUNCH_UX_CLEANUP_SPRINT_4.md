# Launch Sprint 4 — owner UX cleanup

Branch `claude/launch-ux-cleanup` from exact master `d4c7877` (Sprint 3), NOT
merged. Nine owner findings closed in one branch; the tenth (long-horizon
deals, item 8) is architecture on its own branch
(`claude/long-horizon-deals-architecture`, `docs/LONG_HORIZON_DEALS_ARCHITECTURE.md`)
and is deliberately NOT mixed into this one.

Real money executed: 0. No payment-provider, Grow, capture, settlement,
refund, reconciliation or migration change. No migration at all.

## 1. Pickup location accuracy — Google Maps + Waze

Audit (seller form → stored option → seller preview → public deal → buyer
tracking → pickup credential → navigation) found ONE canonical module
(`src/pickup_location.ts`, imported by the React bundle) but three divergent
navigation renderers: `/maps/dir/` on the public deal, `/maps/search/` on the
tracking card, two inline URL builders on the seller page, a lone
"פתח במפה" button, and no Waze anywhere. Buyers were only ever sent to stored
coordinates (never to an invented point) — but an address-only option gave
them no navigation at all, and nothing told the seller whether an exact point
existed.

Now one truth, one renderer:

| Stored data | `precision` | Google Maps | Waze | UI mode line |
|---|---|---|---|---|
| explicit coordinates | `exact` | `maps/dir/?destination=LAT,LNG` | `waze.com/ul?ll=LAT,LNG&navigate=yes` | "נקודה מדויקת" |
| address text only (non-generic) | `address` | `maps/dir/?destination=<text>` | `waze.com/ul?q=<text>&navigate=yes` | "ניווט לפי חיפוש כתובת" |
| generic label ("איסוף עצמי") / nothing | `none` | — | — | existing neutral fallback |

* `pickupNavigation()` / `pickupPrecision()` / `pickupWazeUrl()` in
  `src/pickup_location.ts`; `describePickupLocation()` now also projects
  `precision` + `navigation` on the public AND seller payloads (same
  function, so the seller preview stays byte-identical to the public page).
* `tracking.pickup.pickup_navigation` on the buyer tracking payload
  (`src/physical_fulfillment.ts`) — the credential card renders the same two
  actions. A generic label is still shown as the label there but never
  becomes a navigation target.
* Public deal + tracking card: `PickupNavActions` (`web/src/pages/deal.tsx`)
  — two labelled buttons with recognizable glyphs (`web/src/navIcons.tsx`),
  ≥44 px tall, plus the mode line. "פתח במפה" is gone.
* Seller: `LocationCapture` shows "✓ מיקום מדויק הוגדר (lat, lng)" with the
  same two links; an address-only row shows
  "⚠️ הוגדרה כתובת בלבד — מומלץ לאמת נקודה מדויקת"; the delivery read view
  carries `pickup-precision-exact` / `pickup-precision-address` / the
  existing missing warning. The two inline map URL builders are deleted.
* Phones: Google Maps `dir/?api=1` and the Waze universal link both open the
  native app when installed and the web app otherwise (proof reads the
  hrefs at 390/430/1280; app hand-off itself is outside web automation).

## 2. Mobile horizontal overflow

Sprint 3 fixed the one confirmed source (RTL honeypot at −9999px). This
sprint does NOT assume it was the only one: the proof sweeps 17 routes ×
3 widths and asserts `documentElement.scrollWidth <= innerWidth` AND
`body.scrollWidth <= innerWidth`, listing offending elements on failure.
Result: **0 overflow on 64 page checks** (390: 24, 430: 18, 1280: 22) —
landing, deal, join sheet, address-only deal, tracking, tracking with pickup
card, support, legal ×3, seller dashboard, seller deal, seller Draft editor,
seller pickup scanner, admin overview / growth / buyers / deals. No global
`overflow-x: hidden` band-aid exists (pinned by the unit suite).

## 3. Viral tree — seller/admin backstage only

Audit: the ONLY buyer surface with tree data was the tracking share panel
(direct children / units via branch / generations in branch / descendants),
fed by the buyer-token `GET /api/participants/:id/impact`; the public join
reply also carried `viral.generation`; `web/src/vtree.tsx` was an orphan
tree canvas.

* Tracking page: the share loop (WhatsApp / native share / copy) stays;
  every counter and the "דורות בענף" / "השרשרת שלך" copy is gone.
* `/impact` (buyer token) now returns the share identity ONLY
  (`participant_id`, `personal_share_code`, `personal_share_url`) — no
  recursive tree query runs on a buyer token any more.
* Public join reply: `viral.generation` removed; the generation lives in the
  canonical attribution row (`viral_attributions`) and the seller/admin
  propagation endpoints. Attribution collection (`POST /api/viral/events`,
  `POST /api/affiliate/links/visit`, `?ref=` capture) is untouched.
* Seller (`#/seller/deal/:id/viral`, `/api/seller/deals/:id/propagation|viral-tree|viral`)
  and admin (`/api/admin/deals/:id/propagation|viral-tree|viral`) keep the
  canonical TRUE propagation tree, still server-authorized (ownership → 404,
  `requireAdminRead`).
* `web/src/vtree.tsx` deleted.

## 4. Legal pages — native React

`src/legal_pages.ts` stays the ONE content source (no Hebrew text copied into
the bundle — the payment-term scans would catch it). New: a tiny parser
(`parseLegalBlocks`) + `legalPageProjection(slug)` served by
`GET /api/legal/:slug`; `web/src/pages/legal.tsx` renders the blocks inside
the product shell (same header, container, typography, `.panel` card, footer,
responsive rules) at `#/legal/terms`, `#/legal/privacy`, `#/legal/refunds`
(and the other four slugs). Nav chips = the core documents; an unknown slug
gets a product empty state.

Footer links and the join-sheet consent link now stay inside the product
(`#/legal/...`). The direct legacy URLs `/legal/terms|privacy|refunds|…`
answer `302 → /preview/#/legal/<slug>`, so old links, the legacy `/app` shell
and the seller flows all land on the same document. The standalone legal HTML
shell (its own CSS, Arial, second footer) is deleted. Legal meaning/content
unchanged — the version notice ("גרסה 0.9 …") is rendered from the same
constant.

## 5. True back/forward scroll restoration

`web/src/scrollRestoration.ts` replaces the router's unconditional
scroll-to-top on every hashchange:

* every history entry gets a private key stamped into `history.state`
  (`replaceState`, no extra entries); positions are remembered PER ENTRY (not
  per route string) in memory + `sessionStorage`;
* a hashchange whose target entry already carries a key is a traversal
  (Back / Forward / Android back) → its exact position is restored; an entry
  without a key is NEW → top;
* restoration waits for the asynchronous page render (re-tries on animation
  frames until the document can reach the target, 3 s budget, then rests at
  the reachable maximum), scrolls WITHOUT the global smooth-scroll, and holds
  for a short settle window to undo the browser clamp that happens when a
  tall old page is replaced by the short loader before the new content
  renders (found and fixed by the proof — Back from a tall legal page landed
  at 0 before the fix);
* while a restore is pending, scroll events from the loader never overwrite
  the remembered position; the user's own scrolls are remembered as soon as
  the target is reached;
* `history.scrollRestoration = "manual"`; reload adopts the stored key.

Browser proof: deal scrolled to 1200 → Support → Back = 1200 (±40) →
Forward = Support's own 172; deal 900 → legal terms → Back = 900 → Forward =
legal's own 700; at 390 and 1280. A new page always starts at the top.

## 6. Admin buyer search — intent-sensitive and literal

Reproduced the owner's finding exactly: the roster searched four hidden
fields with `ILIKE` and then displayed `MAX(buyer_name)` — a buyer who joined
once as "שרה אברהם" and once as "תמר אברהם" matched "ש" and was DISPLAYED as
"תמר אברהם". `src/buyer_search_intent.ts` (pure, unit-tested):

| Input | Intent | Searches |
|---|---|---|
| letters / Hebrew | `name` | the buyer name only, every whitespace token, NFKC + niqqud stripped + final letters folded + case-insensitive |
| digits (with spaces / dashes / +) | `phone` | digit-normalized phone (and the phone-shaped buyer id) |
| contains `@` | `email` | e-mail |
| `CT-1234-5678` | `order_code` | the human order code on fulfillment units |
| UUID / long hex | `id` | technical ids only |

The predicate runs on the DISPLAYED aggregate values (the participation name
that matched is the one shown), `%`/`_` are literal, typing is debounced,
the screen names the intent ("חיפוש לפי שם") and every row shows why it
matched ("התאמה בשם" / "בטלפון" / "במייל" / "בקוד הזמנה" / "במזהה").
Regression test: query "ש" cannot return a displayed name without ש.

## 7. Copy

"צמיחה וויראליות" → "ויראליות" (page heading + admin nav item). The nav
GROUP label "צמיחה" and the backend route `/api/admin/growth` are unchanged.

## 8. Virality time range (owner item 9)

Audit: `/api/admin/growth` mixed a lifetime cached rollup (10 tiles, both
leaderboards) with one hard-coded 7-day card, unlabelled. Now:

* `src/growth_window.ts` — default **7 days**; presets 7/30/90 (technical
  ceiling 3650 days, no product cap); custom `[from, to)` as UTC instants
  with validation (inverted / malformed / before 2020 / >2 days in the future
  / >20 years → 400 with a Hebrew reason); `range=all`.
* `src/growth_metrics.ts` — every windowed number is computed live for the
  window (joins, attributed joins, viral coefficient, share of joins, charged
  units/GMV through sharing, sharing participants, generation depth, personal
  links created, share-button clicks, deal views, link clicks/entries, funnel
  events, top deals, top sellers with display name).
* Admin screen: range chips + custom Israel-local day inputs
  (`web/src/growthRange.ts` converts to UTC instants through the DST-aware
  Israel converter, `to` = start of the day after the last day) + "כל הזמן";
  the window label is on every windowed card; the lifetime rollup is a
  separate block titled "מצטבר מאז ההשקה (כל הזמן)" with its computed-at.
* Seller dashboard viral panel labelled "(מצטבר — כל הזמן)" — it shares the
  concept but not the engine; windowing it is a follow-up.

## 9. Quantities — typed, no steppers (owner item 10)

`QtyStepper` (+/− buttons around a read-only number) is deleted. `QtyInput`
(`web/src/components.tsx`) + `web/src/quantityInput.ts` (pure rules): a
text-like field with `inputMode="numeric"`, `pattern="[0-9]*"`, digits only
(a decimal can never be typed), zero / empty / over-stock refused with a
reason instead of being clamped silently, valid values drive the order
summary. Seller min / max units in the wizard and the Draft editor use the
same attributes and an integer check; browser spinner arrows are hidden on
every remaining `type="number"` money field. Canonical business constraints
(server positive-integer, DB `qty <= 1000`, min ≤ max) are untouched.

## Proofs

| Proof | Result |
|---|---|
| `tests/frontend_foundation_sprint4_ux_cleanup_validation.ts` (unit) | 13/13 — pure rules for quantities, scroll state machine (fake window), navigation parity, legal parser, search intent + SQL shape, window validation, Israel-day boundaries; source pins per item |
| `tests/admin_buyer_search_intent_validation.ts` (api) | 8/8 — DB-exercised semantics incl. the "ש" regression |
| `tests/admin_growth_window_validation.ts` (api) | 6/6 — default 7d, presets, custom drives data, refusals, all-time, admin-only |
| `scripts/sprint4_ux_cleanup_browser_proof.cjs` (headless Edge CDP, local demo-preview runtime, real admin cookie session) | **73/73**, 64 page checks @390/430/1280, 0 console errors, 0 failed essential requests, 0 horizontal overflow, 0 text under 10 px |
| Affected regressions | 19/19 files (r6 viral graph, legal trust ×2, countdown/pickup, geolocation, pickup, react-legacy, buyer polish, p05 admin viral, p07 ×2, seller pickup fulfillment, pilot readiness, cache policy, tracking command center, delivery handoff, …) |
| Static gates | TypeScript (server + web), lint (secret + control-byte scans), payment compliance scan, runtime DDL scan, architecture gate — PASS |
| Full suite | see PROJECT_STATUS.md (Sprint 4 section) |

## Gotchas recorded

* The admin React surface needs a REAL admin session locally: the fake
  bearer used for the seller context is not an admin identity
  (`resolveAdminIdentity` → 401 → AdminLogin). The proof creates an admin
  user with `scripts/create_admin_user.cjs`, sets `mfa_required=false` on the
  local proof DB, and logs in through `/api/admin/auth/login` from the page
  origin (cookie session).
* `deals.description` is capped at 420 characters by a DB CHECK and the
  create route answers 500 (not 400) when exceeded — pre-existing, noted.
* A raw control byte inside a regex literal trips the lint control-byte scan;
  always use `\uXXXX` escapes.

## Open / not done

* Seller virality panel is labelled lifetime but not yet windowed (separate
  SQL engine in `seller_analytics.ts`).
* Native app hand-off (Google Maps / Waze opening the installed app) cannot be
  proven by web automation; the URLs follow both vendors' documented deep-link
  formats.
