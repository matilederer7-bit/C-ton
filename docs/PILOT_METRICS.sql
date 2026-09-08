-- LAUNCH MODE — pilot metrics the owner can run directly in the Supabase SQL
-- editor (siton-staging) when the admin console is not at hand.
-- Same definitions as GET /api/admin/pilot-metrics. Aggregate only, no PII.
-- Change the window in the first CTE.

WITH w AS (SELECT now() - interval '30 days' AS since),

-- ── sellers: entered → created → published → repeat ───────────────────────
s AS (
  SELECT sa.seller_id, sa.created_at,
         COALESCE(sa.verification_status,'pending') AS verification_status,
         (sa.auth_user_id IS NOT NULL AND sa.seller_id <> 'c-ton-owner') AS signed_up
  FROM siton.seller_accounts sa
),
d AS (
  SELECT seller_id,
         COUNT(*)::int AS drafts,
         COUNT(*) FILTER (WHERE published_at IS NOT NULL)::int AS published
  FROM siton.deals WHERE seller_id IS NOT NULL GROUP BY seller_id
),
sellers AS (
  SELECT COUNT(*) FILTER (WHERE s.signed_up)                              AS sellers_signed_up,
         COUNT(*) FILTER (WHERE s.signed_up AND s.created_at >= w.since)  AS sellers_signed_up_in_window,
         COUNT(*) FILTER (WHERE s.verification_status = 'pending')        AS sellers_pending_approval,
         COUNT(*) FILTER (WHERE COALESCE(d.drafts,0)    > 0)              AS sellers_created_a_deal,
         COUNT(*) FILTER (WHERE COALESCE(d.published,0) > 0)              AS sellers_published,
         COUNT(*) FILTER (WHERE COALESCE(d.published,0) >= 2)             AS sellers_repeat_publishers
  FROM s LEFT JOIN d ON d.seller_id = s.seller_id, w
),

-- ── deals in window ────────────────────────────────────────────────────────
deals AS (
  SELECT COUNT(*)                                                              AS drafts_created,
         COUNT(*) FILTER (WHERE published_at IS NOT NULL)                      AS published,
         COUNT(*) FILTER (WHERE state IN ('PendingTarget','TargetReached','ClosedForJoining')) AS open_now,
         COUNT(*) FILTER (WHERE state = 'Completed')                           AS completed,
         COUNT(*) FILTER (WHERE state = 'Failed')                              AS failed,
         COUNT(*) FILTER (WHERE state = 'Cancelled')                           AS cancelled,
         (SELECT COUNT(DISTINCT deal_id) FROM siton.audit_log a, w
           WHERE a.action_name = 'deal.target_reached' AND a.created_at >= w.since) AS reached_threshold
  FROM siton.deals, w WHERE created_at >= w.since
),

-- ── buyers: viewed → tried → joined (+ refused, inquiries) ─────────────────
ev AS (
  SELECT COUNT(*) FILTER (WHERE event_type = 'deal_view')                          AS deal_views,
         COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'deal_view')        AS unique_visitors,
         COUNT(*) FILTER (WHERE event_type = 'share_button_click')                 AS share_clicks,
         COUNT(*) FILTER (WHERE event_type = 'join_started')                       AS join_starts,
         COUNT(*) FILTER (WHERE event_type = 'join_failed')                        AS join_failures,
         COUNT(*) FILTER (WHERE event_type = 'inquiry_started')                    AS inquiry_starts
  FROM siton.viral_events, w WHERE created_at >= w.since
),
jn AS (
  SELECT COUNT(*) AS joins, COUNT(DISTINCT buyer_id) AS distinct_buyers,
         COUNT(*) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge')) AS charged
  FROM siton.participants, w WHERE created_at >= w.since
),
inq AS (
  SELECT COUNT(*) AS inquiry_threads,
         COUNT(*) FILTER (WHERE last_sender_type = 'Seller' OR status = 'Answered') AS inquiries_answered
  FROM siton.seller_inquiry_threads, w WHERE created_at >= w.since
)
SELECT sellers.*, deals.*, ev.*, jn.*, inq.*,
       ROUND(100.0 * jn.joins / NULLIF(ev.deal_views, 0), 1)  AS view_to_join_pct,
       ROUND(100.0 * jn.joins / NULLIF(ev.join_starts, 0), 1) AS join_start_to_join_pct
FROM sellers, deals, ev, jn, inq;

-- ── per-seller table (who returned for another deal) ───────────────────────
-- SELECT sa.seller_id, COALESCE(NULLIF(sa.business_name,''), sa.display_name) AS name,
--        COALESCE(sa.verification_status,'pending') AS verification_status,
--        COUNT(d.deal_id) AS drafts,
--        COUNT(d.deal_id) FILTER (WHERE d.published_at IS NOT NULL) AS published,
--        COUNT(d.deal_id) FILTER (WHERE d.state='Completed') AS completed,
--        COUNT(d.deal_id) FILTER (WHERE d.state='Failed') AS failed,
--        MAX(d.published_at) AS last_published_at
-- FROM siton.seller_accounts sa LEFT JOIN siton.deals d ON d.seller_id = sa.seller_id
-- GROUP BY sa.seller_id ORDER BY published DESC, last_published_at DESC NULLS LAST;

-- ── join refusals by reason (why buyers bounced) ───────────────────────────
-- SELECT COALESCE(detail,'(none)') AS reason, COUNT(*) FROM siton.viral_events
-- WHERE event_type='join_failed' AND created_at >= now() - interval '30 days'
-- GROUP BY 1 ORDER BY 2 DESC;

-- ── buyer feedback (sprint 2: "היה משהו שלא היה ברור?") ─────────────────
-- Stored as CLOSED operational cases opened by `buyer_feedback` (no PII).
-- Counts per answer in the window:
-- SELECT COALESCE(substring(description from '(?:^|\n)קטגוריה: ([a-z_]+)'), 'unknown') AS category,
--        COUNT(*) AS answers
-- FROM siton.operational_cases
-- WHERE opened_by = 'buyer_feedback' AND created_at >= now() - interval '30 days'
-- GROUP BY 1 ORDER BY answers DESC;
-- The free texts (last 50), with the deal they came from:
-- SELECT oc.created_at, oc.deal_id, d.title,
--        substring(oc.description from '(?:^|\n)קטגוריה: ([a-z_]+)') AS category,
--        substring(oc.description from '\nטקסט: (.*)$') AS text
-- FROM siton.operational_cases oc LEFT JOIN siton.deals d ON d.deal_id = oc.deal_id
-- WHERE oc.opened_by = 'buyer_feedback' AND oc.description LIKE '%טקסט: %'
-- ORDER BY oc.created_at DESC LIMIT 50;
