import React, { useEffect, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, Toast, useToast } from "../components";
import { num, timeAgo } from "../util";
import { t, tKey } from "../i18n/index.js";
import { Tx } from "../i18n/Tx.js";

// ── P0.7 — seller command center: customer inquiries ("פניות מלקוחות") ──────
// The authoritative conversation lives in the product. The dashboard panel,
// the list page and the thread page all read the seller-scoped API
// (/api/seller/inquiries…) — the server enforces ownership; a foreign thread
// is a 404 exactly like a missing one. Replies are stored in the product; the
// customer reads them on the deal page ("הפניות שלי").

const STATUS_LABEL: Record<string, string> = { Open: "seller_inquiries.status_label.open", Answered: "seller_inquiries.status_label.answered", Closed: "seller_inquiries.status_label.closed" };

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
        <span className="inq-preview">{inquiry.last_sender_type === "Seller" ? t("seller_inquiries.you_2") : ""}{inquiry.last_message_preview}</span>
      </span>
      <span className="inq-meta">
        <span className={`inq-status ${String(inquiry.status)}`}>{tKey(STATUS_LABEL[String(inquiry.status)], inquiry.status)}</span>
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
        <div className="panel-title" style={{ marginBottom: 0 }}>{t("seller_inquiries.panel_title")}
          {unread > 0 ? <span className="inq-badge" data-testid="inquiries-unread" aria-label={t("seller_inquiries.unread_unread_enquiries", { unread: num(unread) })}>{num(unread)}</span> : null}
        </div>
        <button className="btn btn-sm btn-ghost" data-testid="inquiries-open-all" onClick={() => navigate("#/seller/inquiries")}>{t("seller_inquiries.to_all_enquiries_2")}</button>
      </div>
      {error ? <p className="notice err" style={{ margin: "8px 0 0" }}>{error}</p>
        : !data ? <p className="muted small" style={{ margin: "8px 0 0" }}>{t("seller_inquiries.loading_enquiries")}</p>
        : threads.length === 0 ? (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {t("seller_inquiries.there_open_enquiries_when_customer")}</p>
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
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("seller_inquiries.to_dashboard")}</a>
      <div className="panel" data-testid="inquiries-page">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: "1.3rem" }}>{t("seller_inquiries.customer_enquiries")}</h1>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn btn-sm ${scope === "open" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("open")}>{t("seller_inquiries.open")}</button>
            <button className={`btn btn-sm ${scope === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => setScope("all")}>{t("seller_inquiries.all")}</button>
          </div>
        </div>
        {data ? (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {t("seller_inquiries.open_threads_open_unread_threads", { open_threads: num(summary.open_threads), unread_threads: num(summary.unread_threads), total_threads: num(summary.total_threads) })}</p>
        ) : null}
      </div>
      {error ? <div className="notice err">{error}</div>
        : !data ? <BrandLoader label={t("seller_inquiries.loading_enquiries")} minHeight={240} />
        : threads.length === 0 ? (
          <EmptyState title={scope === "open" ? t("seller_inquiries.no_open_enquiries") : t("seller_inquiries.no_enquiries_yet")}
            body={t("seller_inquiries.when_customer_taps_enquiry_seller")} />
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
      showToast(t("seller_inquiries.the_reply_saved_sent_customer"));
      await load();
    } catch (err: any) { setSendError(err.message || t("seller_inquiries.sending_failed")); }
    setBusy(false);
  };

  if (error) return <EmptyState title={t("seller_inquiries.enquiry_found")} body={error} action={<button className="btn btn-primary" onClick={() => navigate("#/seller/inquiries")}>{t("seller_inquiries.all_enquiries")}</button>} />;
  if (!data?.thread) return <BrandLoader label={t("seller_inquiries.loading_enquiry")} minHeight={320} />;
  const thread = data.thread;
  const messages: Json[] = data.messages || [];
  return (
    <>
      <a className="back" href="#/seller/inquiries" onClick={(e) => { e.preventDefault(); navigate("#/seller/inquiries"); }}>{t("seller_inquiries.to_all_enquiries")}</a>
      <div className="panel" data-testid="inquiry-thread">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.25rem" }}>{t("seller_inquiries.an_enquiry_customer_name", { customer_name: thread.customer_name })}</h1>
            <div className="muted small" style={{ marginTop: 4 }}>
              <Tx k="seller_inquiries.email_and_opened" vars={{ email: <span dir="ltr" data-testid="inquiry-customer-email">{thread.customer_email_masked}</span>, when: fmtWhen(thread.created_at) }} />
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className={`inq-status ${String(thread.status)}`} data-testid="inquiry-status">{tKey(STATUS_LABEL[String(thread.status)], thread.status)}</span>
            <a className="btn btn-sm btn-ghost" href={`#/seller/deal/${thread.deal_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${thread.deal_id}`); }}>{t("seller_inquiries.on_deal_deal_title", { deal_title: thread.deal_title })}</a>
          </div>
        </div>
        <div className="inq-thread" style={{ marginTop: 14 }}>
          {messages.map((m) => (
            <div key={String(m.message_id)} className={`inq-msg ${String(m.sender_type).toLowerCase()}`} data-testid={`inquiry-msg-${String(m.sender_type).toLowerCase()}`}>
              <div className="inq-msg-meta">{m.sender_type === "Seller" ? t("seller_inquiries.you") : thread.customer_name} · {fmtWhen(m.created_at)}</div>
              <div className="inq-msg-body">{m.body}</div>
            </div>
          ))}
        </div>
        <form className="inq-reply" onSubmit={send}>
          <label htmlFor="inq-reply-body" style={{ fontWeight: 700 }}>{t("seller_inquiries.a_reply_customer")}</label>
          <textarea id="inq-reply-body" data-testid="inquiry-reply-body" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} rows={4}
            placeholder={t("seller_inquiries.write_reply_here_customer_sees")} />
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className="muted small">{t("seller_inquiries.the_reply_stored_c_ton")}</span>
            <button className="btn btn-primary" data-testid="inquiry-reply-send" disabled={busy || reply.trim().length < 3}>{busy ? t("seller_inquiries.sending") : t("seller_inquiries.send_reply")}</button>
          </div>
          {sendError ? <div className="notice err">{sendError}</div> : null}
        </form>
      </div>
      <Toast msg={toast} />
    </>
  );
}
