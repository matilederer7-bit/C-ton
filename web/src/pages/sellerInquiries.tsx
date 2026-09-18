import React, { useEffect, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, Toast, useToast } from "../components";
import { num, timeAgo } from "../util";
import { t } from "../i18n";

// ── P0.7 — seller command center: customer inquiries ("פניות מלקוחות") ──────
// The authoritative conversation lives in the product. The dashboard panel,
// the list page and the thread page all read the seller-scoped API
// (/api/seller/inquiries…) — the server enforces ownership; a foreign thread
// is a 404 exactly like a missing one. Replies are stored in the product; the
// customer reads them on the deal page ("הפניות שלי").

const STATUS_LABEL: Record<string, string> = { Open: "ממתינה לתשובה", Answered: "נענתה", Closed: "סגורה" };

function fmtWhen(iso: unknown): string {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

export function InquiryRow({ inquiry, navigate }: { inquiry: Json; navigate: (h: string) => void }) {
  const unread = Number(inquiry.seller_unread_count || 0) > 0;
  return (
    <button className={`inq-row${unread ? " unread" : ""}`} data-testid="inquiry-row" data-thread-id={inquiry.thread_id}
      onClick={() => navigate(`#/seller/inquiries/${inquiry.thread_id}`)}>
      <span className="inq-dot" aria-hidden="true" />
      <span className="inq-main">
        <span className="inq-head"><b>{inquiry.customer_name}</b><span className="muted small"> · {inquiry.deal_title}</span></span>
        <span className="inq-preview">{inquiry.last_sender_type === "Seller" ? t("pages.seller_inquiries.54ebb8ab") : ""}{inquiry.last_message_preview}</span>
      </span>
      <span className="inq-meta">
        <span className={`inq-status ${String(inquiry.status)}`}>{STATUS_LABEL[String(inquiry.status)] || String(inquiry.status)}</span>
        <span className="muted small">{timeAgo(inquiry.last_message_at)}</span>
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
        <div className="panel-title" style={{ marginBottom: 0 }}>פניות מלקוחות
          {unread > 0 ? <span className="inq-badge" data-testid="inquiries-unread" aria-label={t("pages.seller_inquiries.f4f6c375", { unread: num(unread) })}>{num(unread)}</span> : null}
        </div>
        <button className="btn btn-sm btn-ghost" data-testid="inquiries-open-all" onClick={() => navigate("#/seller/inquiries")}>{t("pages.seller_inquiries.4cfb750b")}</button>
      </div>
      {error ? <p className="notice err" style={{ margin: "8px 0 0" }}>{error}</p>
        : !data ? <p className="muted small" style={{ margin: "8px 0 0" }}>{t("pages.seller_inquiries.f7755a72")}</p>
        : threads.length === 0 ? (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {t("pages.seller_inquiries.82224310")}</p>
        ) : (
          <div className="inq-list">
            {threads.slice(0, 6).map((row) => <InquiryRow key={String(row.thread_id)} inquiry={row} navigate={navigate} />)}
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
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("pages.seller_inquiries.227cf122")}</a>
      <div className="panel" data-testid="inquiries-page">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: "1.3rem" }}>{t("pages.seller_inquiries.67377a53")}</h1>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn btn-sm ${scope === "open" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("open")}>{t("pages.seller_inquiries.bc86cd9d")}</button>
            <button className={`btn btn-sm ${scope === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("all")}>{t("pages.seller_inquiries.d0940366")}</button>
          </div>
        </div>
        {data ? (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {t("pages.seller_inquiries.19b1b2f0", { open_threads: num(summary.open_threads), unread_threads: num(summary.unread_threads), total_threads: num(summary.total_threads) })}</p>
        ) : null}
      </div>
      {error ? <div className="notice err">{error}</div>
        : !data ? <BrandLoader label={t("pages.seller_inquiries.f7755a72")} minHeight={240} />
        : threads.length === 0 ? (
          <EmptyState title={scope === "open" ? t("pages.seller_inquiries.95e8605f") : t("pages.seller_inquiries.f7fdee0e")}
            body={t("pages.seller_inquiries.05b3d2fa")} />
        ) : (
          <div className="panel">
            <div className="inq-list">
              {threads.map((row) => <InquiryRow key={String(row.thread_id)} inquiry={row} navigate={navigate} />)}
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
      showToast(t("pages.seller_inquiries.7c1719b6"));
      await load();
    } catch (err: any) { setSendError(err.message || t("pages.seller_inquiries.2ccf39be")); }
    setBusy(false);
  };

  if (error) return <EmptyState title={t("pages.seller_inquiries.c797d26a")} body={error} action={<button className="btn btn-primary" onClick={() => navigate("#/seller/inquiries")}>{t("pages.seller_inquiries.67173ba1")}</button>} />;
  if (!data?.thread) return <BrandLoader label={t("pages.seller_inquiries.20ecda2f")} minHeight={320} />;
  const thread = data.thread;
  const messages: Json[] = data.messages || [];
  return (
    <>
      <a className="back" href="#/seller/inquiries" onClick={(e) => { e.preventDefault(); navigate("#/seller/inquiries"); }}>{t("pages.seller_inquiries.3c4558fb")}</a>
      <div className="panel" data-testid="inquiry-thread">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.25rem" }}>{t("pages.seller_inquiries.086b64cf", { customer_name: thread.customer_name })}</h1>
            <div className="muted small" style={{ marginTop: 4 }}>
              <span dir="ltr" data-testid="inquiry-customer-email">{thread.customer_email_masked}</span> · נפתחה {fmtWhen(thread.created_at)}
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className={`inq-status ${String(thread.status)}`} data-testid="inquiry-status">{STATUS_LABEL[String(thread.status)] || String(thread.status)}</span>
            <a className="btn btn-sm btn-ghost" href={`#/seller/deal/${thread.deal_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${thread.deal_id}`); }}>{t("pages.seller_inquiries.15a0e679", { deal_title: thread.deal_title })}</a>
          </div>
        </div>
        <div className="inq-thread" style={{ marginTop: 14 }}>
          {messages.map((m) => (
            <div key={String(m.message_id)} className={`inq-msg ${String(m.sender_type).toLowerCase()}`} data-testid={`inquiry-msg-${String(m.sender_type).toLowerCase()}`}>
              <div className="inq-msg-meta">{m.sender_type === "Seller" ? t("pages.seller_inquiries.1ea8fbb3") : thread.customer_name} · {fmtWhen(m.created_at)}</div>
              <div className="inq-msg-body">{m.body}</div>
            </div>
          ))}
        </div>
        <form className="inq-reply" onSubmit={send}>
          <label htmlFor="inq-reply-body" style={{ fontWeight: 700 }}>{t("pages.seller_inquiries.fc764ac0")}</label>
          <textarea id="inq-reply-body" data-testid="inquiry-reply-body" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} rows={4}
            placeholder={t("pages.seller_inquiries.3b2a8914")} />
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className="muted small">{t("pages.seller_inquiries.e486db4c")}</span>
            <button className="btn btn-primary" data-testid="inquiry-reply-send" disabled={busy || reply.trim().length < 3}>{busy ? t("pages.seller_inquiries.ea12faeb") : t("pages.seller_inquiries.bdd19372")}</button>
          </div>
          {sendError ? <div className="notice err">{sendError}</div> : null}
        </form>
      </div>
      <Toast msg={toast} />
    </>
  );
}
