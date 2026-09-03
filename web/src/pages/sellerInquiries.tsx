import React, { useEffect, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, Toast, useToast } from "../components";
import { num, timeAgo } from "../util";

// ── P0.7 — seller command center: customer inquiries ("פניות מלקוחות") ──────
// The authoritative conversation lives in the product. The dashboard panel,
// the list page and the thread page all read the seller-scoped API
// (/api/seller/inquiries…) — the server enforces ownership; a foreign thread
// is a 404 exactly like a missing one. Replies are stored in the product; the
// customer reads them on the deal page ("הפניות שלי").

const STATUS_LABEL: Record<string, string> = { Open: "ממתינה לתשובה", Answered: "נענתה", Closed: "סגורה" };

function fmtWhen(iso: unknown): string {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

export function InquiryRow({ t, navigate }: { t: Json; navigate: (h: string) => void }) {
  const unread = Number(t.seller_unread_count || 0) > 0;
  return (
    <button className={`inq-row${unread ? " unread" : ""}`} data-testid="inquiry-row" data-thread-id={t.thread_id}
      onClick={() => navigate(`#/seller/inquiries/${t.thread_id}`)}>
      <span className="inq-dot" aria-hidden="true" />
      <span className="inq-main">
        <span className="inq-head"><b>{t.customer_name}</b><span className="muted small"> · {t.deal_title}</span></span>
        <span className="inq-preview">{t.last_sender_type === "Seller" ? "אתם: " : ""}{t.last_message_preview}</span>
      </span>
      <span className="inq-meta">
        <span className={`inq-status ${String(t.status)}`}>{STATUS_LABEL[String(t.status)] || String(t.status)}</span>
        <span className="muted small">{timeAgo(t.last_message_at)}</span>
      </span>
    </button>
  );
}

export function InquiriesPanel({ data, error, navigate }: { data: Json | null; error?: string; navigate: (h: string) => void }) {
  const threads: Json[] = data?.threads || [];
  const unread = Number(data?.summary?.unread_threads || 0);
  return (
    <div className="panel" data-testid="inquiries-panel">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          💬 פניות מלקוחות
          {unread > 0 ? <span className="inq-badge" data-testid="inquiries-unread" aria-label={`${num(unread)} פניות שלא נקראו`}>{num(unread)}</span> : null}
        </div>
        <button className="btn btn-sm btn-ghost" data-testid="inquiries-open-all" onClick={() => navigate("#/seller/inquiries")}>לכל הפניות ←</button>
      </div>
      {error ? <p className="notice err" style={{ margin: "8px 0 0" }}>{error}</p>
        : !data ? <p className="muted small" style={{ margin: "8px 0 0" }}>טוענים פניות…</p>
        : threads.length === 0 ? (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            אין פניות פתוחות. כשלקוח ילחץ על ״פנייה למוכר״ בדף העסקה, הפנייה תופיע כאן ותקבלו התראה במייל שמפנה לכאן.
          </p>
        ) : (
          <div className="inq-list">
            {threads.slice(0, 6).map((t) => <InquiryRow key={String(t.thread_id)} t={t} navigate={navigate} />)}
          </div>
        )}
    </div>
  );
}

export function SellerInquiriesPage({ navigate }: { navigate: (h: string) => void }) {
  const [scope, setScope] = useState<"open" | "all">("open");
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null);
    api.sellerInquiries(scope).then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [scope]);
  const threads: Json[] = data?.threads || [];
  const summary = data?.summary || {};
  return (
    <>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>→ לדשבורד</a>
      <div className="panel" data-testid="inquiries-page">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: "1.3rem" }}>💬 פניות מלקוחות</h1>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn btn-sm ${scope === "open" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("open")}>פתוחות</button>
            <button className={`btn btn-sm ${scope === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("all")}>הכול</button>
          </div>
        </div>
        {data ? (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {num(summary.open_threads)} פתוחות · {num(summary.unread_threads)} שלא נקראו · {num(summary.total_threads)} סה״כ
          </p>
        ) : null}
      </div>
      {error ? <div className="notice err">{error}</div>
        : !data ? <BrandLoader label="טוענים פניות…" minHeight={240} />
        : threads.length === 0 ? (
          <EmptyState icon="💬" title={scope === "open" ? "אין פניות פתוחות" : "עדיין אין פניות"}
            body="כשלקוח ילחץ על ״פנייה למוכר״ בדף העסקה, הפנייה תופיע כאן — והמייל שתקבלו רק מפנה לכאן." />
        ) : (
          <div className="panel">
            <div className="inq-list">
              {threads.map((t) => <InquiryRow key={String(t.thread_id)} t={t} navigate={navigate} />)}
            </div>
          </div>
        )}
    </>
  );
}

export function SellerInquiryThreadPage({ threadId, navigate }: { threadId: string; navigate: (h: string) => void }) {
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState("");
  const [toast, showToast] = useToast();

  const load = () => api.sellerInquiry(threadId).then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [threadId]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || reply.trim().length < 3) return;
    setBusy(true); setSendError("");
    try {
      await api.sellerInquiryReply(threadId, { message: reply.trim() });
      setReply("");
      showToast("התשובה נשמרה ונשלחה ללקוח בתוך C-ton");
      await load();
    } catch (err: any) { setSendError(err.message || "השליחה נכשלה"); }
    setBusy(false);
  };

  if (error) return <EmptyState icon="⚠️" title="הפנייה לא נמצאה" body={error} action={<button className="btn btn-primary" onClick={() => navigate("#/seller/inquiries")}>לכל הפניות</button>} />;
  if (!data?.thread) return <BrandLoader label="טוענים את הפנייה…" minHeight={320} />;
  const t = data.thread;
  const messages: Json[] = data.messages || [];
  return (
    <>
      <a className="back" href="#/seller/inquiries" onClick={(e) => { e.preventDefault(); navigate("#/seller/inquiries"); }}>→ לכל הפניות</a>
      <div className="panel" data-testid="inquiry-thread">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.25rem" }}>פנייה מ{t.customer_name}</h1>
            <div className="muted small" style={{ marginTop: 4 }}>
              <span dir="ltr" data-testid="inquiry-customer-email">{t.customer_email_masked}</span> · נפתחה {fmtWhen(t.created_at)}
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className={`inq-status ${String(t.status)}`} data-testid="inquiry-status">{STATUS_LABEL[String(t.status)] || String(t.status)}</span>
            <a className="btn btn-sm btn-ghost" href={`#/seller/deal/${t.deal_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${t.deal_id}`); }}>לעסקה: {t.deal_title}</a>
          </div>
        </div>
        <div className="inq-thread" style={{ marginTop: 14 }}>
          {messages.map((m) => (
            <div key={String(m.message_id)} className={`inq-msg ${String(m.sender_type).toLowerCase()}`} data-testid={`inquiry-msg-${String(m.sender_type).toLowerCase()}`}>
              <div className="inq-msg-meta">{m.sender_type === "Seller" ? "אתם" : t.customer_name} · {fmtWhen(m.created_at)}</div>
              <div className="inq-msg-body">{m.body}</div>
            </div>
          ))}
        </div>
        <form className="inq-reply" onSubmit={send}>
          <label htmlFor="inq-reply-body" style={{ fontWeight: 700 }}>תשובה ללקוח</label>
          <textarea id="inq-reply-body" data-testid="inquiry-reply-body" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} rows={4}
            placeholder="כתבו את התשובה כאן — הלקוח יראה אותה בדף העסקה תחת ״הפניות שלי״" />
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className="muted small">התשובה נשמרת ב-C-ton בלבד. כתובת האימייל שלכם לא נחשפת ללקוח.</span>
            <button className="btn btn-primary" data-testid="inquiry-reply-send" disabled={busy || reply.trim().length < 3}>{busy ? "שולחים…" : "שליחת תשובה"}</button>
          </div>
          {sendError ? <div className="notice err">{sendError}</div> : null}
        </form>
      </div>
      <Toast msg={toast} />
    </>
  );
}
