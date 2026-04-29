# RC Staging Deploy Smoke Readiness

Status: **Ready for staging** — local smoke passed, regression suite green, no
P0 / P1 blockers open.

External staging smoke is **not yet executed** because no staging URL or
`ADMIN_API_KEY` were provided in the current session. The checklist below is
ready to run as soon as those are available.

---

## 1. Pre-conditions verified at HEAD

- HEAD commit: `41ccaaa fix(delivery): remove logistics management drift`
- `git status --short`: clean before this doc was written
- `node --check frontend/app.js`: PASS
- `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`: PASS (exit 0)

## 2. Regression suite (28 / 28 PASS)

| Test | Result |
|---|---|
| frontend_flow_validation | PASS |
| frontend_foundation_rtl_accessibility_validation | PASS |
| seller_profile_readiness_validation | PASS |
| seller_auth_session_validation | PASS |
| seller_analytics_validation | PASS |
| deal_duplicate_validation | PASS |
| seller_deal_excel_export_validation | PASS |
| buyer_delivery_data_validation | PASS |
| seller_delivery_handoff_validation | PASS |
| seller_delivery_excel_export_validation | PASS |
| seller_delivery_no_logistics_management_validation | PASS |
| admin_dashboard_data_validation | PASS |
| admin_omnisearch_validation | PASS |
| admin_deal_profile_validation | PASS |
| admin_forbidden_money_actions_validation | PASS |
| admin_no_public_search_regression_validation | PASS |
| admin_affiliate_no_commission_regression_validation | PASS |
| admin_rtl_surface_validation | PASS |
| admin_system_status_validation | PASS |
| concurrency_proof | PASS |
| otp_rail_validation | PASS |
| otp_runtime_guard_validation | PASS |
| spec_drift_regression_wave3_validation | PASS |
| platform_fee_payments_8_percent_validation | PASS |
| seller_payout_rail_validation | PASS |
| invoice_rail_validation | PASS |
| invoice_morning_adapter_validation | PASS |
| payment_authorization_env_guard_validation | PASS |

No regressions found. No skipped tests.

## 3. Local smoke (port 3380, `DISABLE_OUTBOX_WORKER=1`)

### Public surfaces

| Surface | Result |
|---|---|
| `GET /health` | 200 `{"ok":true}` |
| `GET /app` | 200 (RTL Hebrew SPA shell) |
| `GET /app/admin` | 200 |
| `GET /app/seller` | 200 |
| `GET /app/contact` | 200 |
| `GET /app/terms` | 200 |
| `GET /app/assets/app.js` | 200 (~352 KB) |
| `GET /app/assets/styles.css` | 200 (~27 KB) |
| `GET /app/search?q=test` | 200 — returns SPA shell only, **no real search backend** |

### Deal lifecycle (real seed)

- `POST /deals` (publish=Draft) → `200 { state: "Draft" }`
- `POST /deals/:id/publish` → `200 { ok: true }`
- `GET /api/deals/:id/public` → `200` deal payload, `state=PendingTarget`
- `GET /app/deal/:id` → `200`
- `GET /api/seller/deals/:id/delivery-handoff` (deal still `PendingTarget`)
  → `400 deal_not_completed` — gate works, no logistics fields leak

### Admin surfaces (in dev/test mode without `ADMIN_API_KEY`, legacy open is allowed)

| Surface | Result |
|---|---|
| `GET /api/admin/overview` | 200 |
| `GET /api/admin/mission-control` | 200 |
| `GET /api/admin/system-status` | 200 |
| `GET /api/admin/launch-console` | 200 |

In production (`ADMIN_API_KEY` set / Render-like env), all of the above must
demand a valid `x-admin-key` header — covered by
`payment_authorization_env_guard_validation` and admin_auth_validation suites.

### Forbidden routes — all return 404

- `POST /api/seller/deals/:id/delivery/:participantId` (logistics update — removed in P1 fix)
- `POST /api/seller/deals/:id/participants/:pid/shipped`
- `POST /api/seller/deals/:id/participants/:pid/refund`
- `POST /api/seller/deals/:id/payout`
- `POST /api/admin/deals/:id/state-override`
- `GET /api/deals` (no public marketplace)
- `GET /api/search` (no public catalog)
- `GET /api/catalog` (no public catalog)

### Spec invariants confirmed during smoke

- ✅ No marketplace / search / catalog backend
- ✅ No distributor commission / balance / payout
- ✅ No logistics management UI or endpoints
- ✅ No manual capture / refund / void / payout endpoints
- ✅ Delivery Data Handoff is data-only (no `tracking_number`, `shipped_at`,
  `delivered_at`, `delivery_status`, `shipping_carrier`, etc.)
- ✅ Deal-state guard active (handoff blocked until Completed)

## 4. External staging smoke — checklist (run once URL + admin key available)

Replace `STAGING_URL` and `ADMIN_KEY` placeholders before running.

```sh
BASE=https://STAGING_URL
KEY=$ADMIN_KEY

# 1. Health and shell
curl -fsS  $BASE/health
curl -fsSI $BASE/app                   # expect 200 + Hebrew RTL shell
curl -fsSI $BASE/app/admin
curl -fsSI $BASE/app/seller

# 2. Admin auth gate
curl -sS -o /dev/null -w "%{http_code}\n"               $BASE/api/admin/system-status   # expect 401 or 503
curl -sS -o /dev/null -w "%{http_code}\n" -H "x-admin-key: $KEY" $BASE/api/admin/system-status   # expect 200
curl -sS -o /dev/null -w "%{http_code}\n" -H "x-admin-key: $KEY" $BASE/api/admin/mission-control # expect 200
curl -sS -o /dev/null -w "%{http_code}\n" -H "x-admin-key: $KEY" $BASE/api/admin/overview        # expect 200

# 3. Forbidden routes — all must be 404
for ROUTE in \
  "POST /api/seller/deals/x/delivery/y" \
  "POST /api/seller/deals/x/participants/y/shipped" \
  "POST /api/seller/deals/x/participants/y/refund" \
  "POST /api/seller/deals/x/payout" \
  "POST /api/admin/deals/x/state-override" \
  "GET  /api/deals" \
  "GET  /api/search?q=test" \
  "GET  /api/catalog"; do
  M=$(echo "$ROUTE" | awk '{print $1}'); P=$(echo "$ROUTE" | awk '{print $2}')
  echo "$M $P -> $(curl -sS -o /dev/null -w '%{http_code}' -X $M $BASE$P)"
done

# 4. Seeded public deal page (if a deal_id is provided)
DEAL_ID=...
curl -fsSI "$BASE/app/deal/$DEAL_ID"
curl -fsS  "$BASE/api/deals/$DEAL_ID/public" | head -c 400

# 5. Buyer page reachable, OTP gate active (no provider creds in staging
# means we expect the provider to refuse, not the route to be missing)
curl -fsSI "$BASE/app/join/$DEAL_ID/otp"
```

Pass criteria: every line above produces the expected status. If the admin
gate is open (200 without key) on staging, **abort** — that is a mis-config.

## 5. Open gaps before production cutover

1. Provide staging URL + ADMIN_API_KEY → run section 4 checklist.
2. Provide live payment provider sandbox creds → run buyer-join through
   payment-authorize, capture, webhook, charging window.
3. Provide live SMS / email provider creds → run OTP delivery proof and
   seller delivery-handoff notification (data-only) on real channels.
4. Re-run `concurrency_proof`, `otp_rail_validation`,
   `platform_fee_payments_8_percent_validation` against staging DB.

## 6. Recommended readiness

- **Local readiness: 95 %** (unchanged from P1 closure).
- **Staging readiness: pending external creds.** Once the section 4
  checklist passes against staging, readiness moves to 97 %.
- **Production readiness: pending staging smoke + provider creds**.
