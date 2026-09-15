import { BuyerEntitlement } from "../receiptContent";
import React, { useEffect, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, Countdown, EmptyState, GroupMeter, ShareActions, StatusPill, Toast, copyText, useToast } from "../components";
import { fmtDate, formatIsraelDateTime, ils, initialOf, num, timeAgo } from "../util";
import { NOTIFICATIONS_OFF_LINE, INQUIRY_PRIVACY_LINE, PILOT_MOCK_MONEY_LINE, SHARE_LOOP_TITLE, notificationsLine } from "../buyerCopy";
import { FeedbackPrompt } from "../feedback";
import { PickupCard } from "../pickupCard";

// מסך המעקב של הקונה — מקור האמת היחיד מרגע ההצטרפות ועד ההכרעה.
// LAUNCH POLISH 2 (P4/P5/P6/P7/P8): the page answers, in order — what is my
// status, what still has to happen and until when, how I get back here (and
// the honest "no e-mail/SMS in the pilot" line), how I ask the seller, how I
// help the deal succeed, one feedback question. Every sentence derives from
// the server payload; nothing here promises a notification that does not exist.

const OPEN_STATES = ["PendingTarget", "TargetReached"];

function nextSteps(t: Json): string[] {
  const state = String(t.deal_state || "");
  const current = Number(t.progress?.current_units || 0);
  const threshold = Number(t.threshold_units || t.progress?.target_units || 1);
  const toTarget = Math.max(0, threshold - current);
  const deadline = formatIsraelDateTime(t.deadline);
  if (OPEN_STATES.includes(state)) {
    return [
      toTarget > 0 ? `חסרות עוד ${num(toTarget)} יחידות כדי שהעסקה תצא לפועל` : "היעד הושג — ההצטרפות עדיין פתוחה עד מועד הסיום",
      deadline ? `מועד הסיום: ${deadline}` : "",
      "הגיעו ליעד עד אז → החיוב מתבצע והמוכר מתאם את הקבלה. לא הגיעו → המסגרת משתחררת ואף אחד לא משלם."
    ].filter(Boolean);
  }
  if (["ClosedForJoining", "ReadyForCharging", "Charging"].includes(state)) {
    return ["ההצטרפות נסגרה — העסקה בתהליך סגירה וחיוב", "המסך הזה מתעדכן לבד; אין צורך לעשות דבר"];
  }
  if (state === "CompletionWindow") return ["חלון השלמה: חלק מהחיובים לא עברו. אם זה נוגע אליכם — ההנחיה מופיעה למעלה במסך הזה"];
  if (state === "Completed") return ["העסקה הושלמה", t.delivery_method_label ? `אופן הקבלה: ${t.delivery_method_label}` : "המוכר מתאם את הקבלה"];
  if (state === "Failed") return ["העסקה לא יצאה לפועל — לא בוצע חיוב, המסגרת משתחררת"];
  if (state === "Cancelled") return ["העסקה בוטלה — לא בוצע חיוב"];
  return [];
}

export function TrackPage({ participantId, token }: { participantId: string; token: string }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [impact, setImpact] = useState<Json | null>(null);
  const [error, setError] = useState<{ kind: "link" | "gone" | "network" | "busy" | "other"; message: string } | null>(null);
  const [toast, showToast] = useToast();
  const [notifLine, setNotifLine] = useState(NOTIFICATIONS_OFF_LINE);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tracking(participantId, token)
        .then((r) => { if (alive) { setPayload(r); setError(null); } })
        .catch((e) => {
          if (!alive || payload) return;
          const status = Number(e?.status || 0);
          if (status === 401 || status === 403) setError({ kind: "link", message: "הקישור אינו תקף או לא הועתק במלואו — פתחו את הקישור המלא שקיבלתם אחרי ההצטרפות." });
          else if (status === 404) setError({ kind: "gone", message: "לא מצאנו את ההצטרפות הזו. בדקו שהקישור הועתק במלואו." });
          else if (!status) setError({ kind: "network", message: "לא הצלחנו לטעון את מסך המעקב. בדקו את החיבור ונסו שוב — הקישור עצמו תקין." });
          else if (status === 429 || status >= 500) setError({ kind: "busy", message: "השרת לא הספיק לענות. הקישור עצמו תקין — נסו שוב בעוד כמה שניות." });
          else setError({ kind: "other", message: String(e?.message || "משהו השתבש — נסו שוב") });
        });
    load();
    const id = setInterval(load, 6_000);
    return () => { alive = false; clearInterval(id); };
  }, [participantId, token]);

  useEffect(() => {
    api.impact(participantId, token).then((r) => setImpact(r.impact)).catch(() => undefined);
    notificationsLine().then(setNotifLine).catch(() => undefined);
  }, [participantId, token]);

  if (error) {
    return (
      <EmptyState icon={error.kind === "network" ? "📡" : error.kind === "busy" ? "⏳" : "🔒"}
        title={error.kind === "network" ? "בעיית תקשורת" : error.kind === "busy" ? "עומס רגעי — נסו שוב בעוד רגע" : "אין גישה למסך המעקב"} body={error.message}
        action={
          <div className="row" style={{ justifyContent: "center" }}>
            {error.kind === "network" || error.kind === "busy" ? <button className="btn btn-primary" data-testid="track-retry" onClick={() => window.location.reload()}>נסו שוב</button> : null}
            <a className="btn btn-ghost" href="#/support" data-testid="track-support">תמיכה</a>
          </div>
        } />
    );
  }
  if (!payload?.tracking) return <BrandLoader label="טוענים את מסך המעקב…" minHeight={420} />;

  const t = payload.tracking;
  const toneClass = t.tone === "success" ? "ok" : t.tone === "danger" ? "err" : "info";
  const inCompletionWindow = t.buyer_state === "ChargeFailedCompletion";
  const steps = nextSteps(t);
  const dealHash = `#/deal/${t.deal_id}`;
  const askHash = `#/deal/${t.deal_id}?inquiry=1`;
  const deadlineText = formatIsraelDateTime(t.deadline);
  const copyHere = async () => {
    if (await copyText(window.location.href)) showToast("קישור המעקב הועתק");
    else showToast("ההעתקה נכשלה — סמנו את הקישור והעתיקו ידנית");
  };

  return (
    <>
      <div className="track-hero">
        <StatusPill state={t.deal_state} />
        <h1 style={{ marginTop: 10 }}>{t.deal_title}</h1>
        <p className="muted">{t.deal_status?.text || ""}</p>
      </div>

      <div className="deal-layout">
        <div className="stack">
          <div className="panel" data-testid="track-status">
            <div className={`notice ${toneClass}`} style={{ marginTop: 0 }}>
              <b>{t.headline}</b>
              {t.subline ? <div className="small" style={{ marginTop: 4 }}>{t.subline}</div> : null}
            </div>
            {inCompletionWindow && t.completion_window_until ? (
              <div className="notice err">
                <b>נדרש עדכון אמצעי תשלום</b> — החיוב לא עבר.
                <div style={{ marginTop: 6 }}>
                  נותר לחלון ההשלמה: <Countdown until={t.completion_window_until} overText="חלון ההשלמה הסתיים" />
                </div>
              </div>
            ) : null}
            <div style={{ margin: "14px 0 6px" }}>
              <GroupMeter
                large
                joined={Number(t.progress?.current_units || 0)}
                threshold={Number(t.threshold_units || 1)}
                max={Number(t.max_units || 1)}
                showFlag
              />
            </div>
            <p className="muted small" style={{ textAlign: "center" }}>
              את/ה ועוד {num(Math.max(0, Number(t.progress?.participants_count || 1) - 1))} משתתפים בעסקה
            </p>
            <div className="kv">
              <span className="k">סיום ההצטרפות</span>
              <span className="v"><Countdown until={t.deadline} overText="עבר" />{deadlineText ? <div className="muted small" style={{ fontWeight: 400 }}>{deadlineText}</div> : null}</span>
            </div>
            {steps.length ? (
              <div className="track-next" data-testid="track-next">
                <div className="track-next-title">מה עוד צריך לקרות?</div>
                <ul>{steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-title">פרטי ההצטרפות שלי</div>
            <div className="kv">
              <span className="k">כמות יחידות</span><span className="v">{num(t.qty)}</span>
              <span className="k">מחיר ליחידה</span><span className="v">{ils(t.price_per_unit)}</span>
              {t.delivery_method_label ? (<><span className="k">אופן קבלה</span><span className="v">{t.delivery_method_label}</span></>) : null}
              {Number(t.delivery_cost) > 0 ? (<><span className="k">משלוח</span><span className="v">{ils(t.delivery_cost)}</span></>) : null}
              <span className="k">סכום שנתפס במסגרת</span><span className="v">{ils(t.estimated_total)}</span>
            </div>
            <div className="order-note" style={{ marginTop: 12 }}>
              מסגרת האשראי נתפסה — <b>לא בוצע חיוב בפועל</b> עד סגירת העסקה בהצלחה.
              אין אפשרות שינוי או ביטול לאחר נעילת העסקה.
              <div className="muted small" style={{ marginTop: 4 }}>{PILOT_MOCK_MONEY_LINE}</div>
            </div>
          </div>

          {/* LAUNCH SPRINT 3 — physical pickup credential: only when the server
              says the order is canonically eligible; "handed over" afterwards */}
          <BuyerEntitlement participantId={participantId} token={token} pickup={t.pickup} />

          {/* LAUNCH POLISH 2 (P4/P7) — how I get back here + how I ask the seller */}
          <div className="panel" data-testid="track-return">
            <div className="panel-title">לחזור לכאן ולשאול את המוכר</div>
            <p className="small" style={{ marginTop: 0 }} data-testid="track-notif-line">{notifLine}</p>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" data-testid="track-copy-link" onClick={copyHere}>העתקת קישור המעקב</button>
              <a className="btn btn-ghost btn-sm" data-testid="track-deal-link" href={dealHash}>לדף העסקה ←</a>
            </div>
            <div className="track-ask" style={{ marginTop: 12 }}>
              <a className="btn btn-primary btn-sm" data-testid="track-ask-seller" href={askHash}>✉️ שאלה למוכר</a>
              <p className="muted small" style={{ margin: "6px 0 0" }}>{INQUIRY_PRIVACY_LINE} התשובה מופיעה בדף העסקה תחת ״הפניות שלי״.</p>
            </div>
          </div>

          {t.fulfillment?.units?.length ? (
            <div className="panel">
              <div className="panel-title">המימושים שלי</div>
              <div className="stack">
                {t.fulfillment.units.map((u: Json) => (
                  <div key={u.fulfillment_unit_id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                    <span>יחידה {u.unit_index}</span>
                    <span className="muted">•••{u.code_display_last4 || "—"}</span>
                    <span className="status Completed">{u.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="stack">
          {/* LAUNCH POLISH 2 (P5) — the share loop: the deal depends on aggregation */}
          <div className="panel" data-testid="track-share">
            <div className="panel-title">{SHARE_LOOP_TITLE}</div>
            {impact ? (
              <>
                <div className="impact-stats">
                  <div className="impact-stat"><div className="num">{num(impact.direct_children)}</div><div className="lbl">מצטרפים שהבאת</div></div>
                  <div className="impact-stat"><div className="num">{num(impact.units_joined_via_branch)}</div><div className="lbl">יחידות דרך השרשרת שלך</div></div>
                  <div className="impact-stat"><div className="num">{num(impact.branch_depth)}</div><div className="lbl">דורות בענף שלך</div></div>
                </div>
                {Number(impact.descendants) > 0 ? (
                  <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                    בסך הכול {num(impact.descendants)} מצטרפים בענף שלך 🎉
                  </p>
                ) : (
                  <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                    שתפו את הקישור האישי — כל מצטרף דרככם נספר כאן ומקרב את העסקה ליעד.
                  </p>
                )}
              </>
            ) : <p className="muted small">טוען…</p>}
            <div style={{ marginTop: 12 }}>
              <ShareActions
                layout="loop"
                dealId={t.deal_id}
                title={t.deal_title}
                price={Number(t.price_per_unit)}
                code={impact?.personal_share_code || null}
                onNotify={showToast}
              />
            </div>
          </div>

          {/* LAUNCH POLISH 2 (P6) — one question, once per deal, never forced */}
          <div className="panel" data-testid="track-feedback">
            <FeedbackPrompt dealId={String(t.deal_id)} surface="tracking" />
          </div>

          {Array.isArray(t.activity_feed) && t.activity_feed.length ? (
            <div className="panel">
              <div className="panel-title">מה קרה בעסקה</div>
              <div className="ticker">
                {t.activity_feed.slice(0, 10).map((a: Json, i: number) => (
                  <div className="ticker-item" key={i}>
                    <span className="ticker-avatar">{initialOf(String(a.label || a.text || "•"))}</span>
                    <span>{a.text || a.label}</span>
                    <span className="ticker-time">{a.at ? timeAgo(a.at) : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-title">סטטוס אישי</div>
            <p style={{ marginBottom: 4 }}><b>{t.personal_status?.headline || t.headline}</b></p>
            {t.personal_status?.body ? <p className="muted small">{t.personal_status.body}</p> : null}
            <p className="muted small" style={{ marginBottom: 0 }}>עודכן: {fmtDate(t.live?.generated_at)}</p>
          </div>
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}
