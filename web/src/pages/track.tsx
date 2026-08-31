import React, { useEffect, useState } from "react";
import { api, Json } from "../api";
import { Countdown, EmptyState, GroupMeter, SharePanel, Spinner, StatusPill, Toast, useToast } from "../components";
import { fmtDate, ils, initialOf, num, timeAgo } from "../util";

// מסך המעקב של הקונה — מקור האמת היחיד מרגע ההצטרפות ועד ההכרעה.
export function TrackPage({ participantId, token }: { participantId: string; token: string }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [impact, setImpact] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [toast, showToast] = useToast();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tracking(participantId, token)
        .then((r) => { if (alive) { setPayload(r); setError(""); } })
        .catch((e) => { if (alive && !payload) setError(e.status === 401 || e.status === 403 ? "הקישור אינו תקף — פתחו את הקישור המלא שקיבלתם" : e.message); });
    load();
    const id = setInterval(load, 6_000);
    return () => { alive = false; clearInterval(id); };
  }, [participantId, token]);

  useEffect(() => {
    api.impact(participantId, token).then((r) => setImpact(r.impact)).catch(() => undefined);
  }, [participantId, token]);

  if (error) return <EmptyState icon="🔒" title="אין גישה למסך המעקב" body={error} />;
  if (!payload?.tracking) return <Spinner label="טוענים את מסך המעקב…" />;

  const t = payload.tracking;
  const toneClass = t.tone === "success" ? "ok" : t.tone === "danger" ? "err" : "info";
  const inCompletionWindow = t.buyer_state === "ChargeFailedCompletion";

  return (
    <>
      <div className="track-hero">
        <StatusPill state={t.deal_state} />
        <h1 style={{ marginTop: 10 }}>{t.deal_title}</h1>
        <p className="muted">{t.deal_status?.text || ""}</p>
      </div>

      <div className="deal-layout">
        <div className="stack">
          <div className="panel">
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
              <span className="k">דדליין</span>
              <span className="v"><Countdown until={t.deadline} overText="עבר" /></span>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">🧾 פרטי ההצטרפות שלי</div>
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
            </div>
          </div>

          {t.fulfillment?.units?.length ? (
            <div className="panel">
              <div className="panel-title">🎫 המימושים שלי</div>
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
          <div className="panel">
            <div className="panel-title">🌱 ההשפעה שלי</div>
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
                    שתפו את הלינק האישי — כל מצטרף דרככם נספר כאן.
                  </p>
                )}
              </>
            ) : <p className="muted small">טוען…</p>}
            <div style={{ marginTop: 12 }}>
              <SharePanel
                compact
                dealId={t.deal_id}
                title={t.deal_title}
                code={impact?.personal_share_code || null}
                onCopied={() => showToast("הלינק האישי הועתק")}
              />
            </div>
          </div>

          {Array.isArray(t.activity_feed) && t.activity_feed.length ? (
            <div className="panel">
              <div className="panel-title">📈 מה קרה בעסקה</div>
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
            <div className="panel-title">ℹ️ סטטוס אישי</div>
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
