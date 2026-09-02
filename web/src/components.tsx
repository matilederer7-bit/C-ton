import React, { useEffect, useMemo, useRef, useState } from "react";
import { clamp, countdownView, num, progressColor, stateLabel } from "./util";
import { absoluteShareUrl, sendFunnelEvent } from "./viral";
import { BRAND_MARK_URL } from "./config";
import { CopyLinkIcon, FacebookIcon, InstagramIcon, NativeShareIcon, TelegramIcon, WhatsAppIcon, XIcon } from "./shareIcons";

export { BrandLoader } from "./brand";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center" role="status" aria-live="polite">
      <div className="spinner" />
      {label ? <p style={{ marginTop: 10 }}>{label}</p> : null}
    </div>
  );
}

// Product image with a branded fallback: a failed load never leaves a blank
// box — the C-ton mark appears on the dark surface instead.
export function ProductImg({ src, alt, fallbackText }: { src: string; alt: string; fallbackText?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) {
    return (
      <div className="img-fallback">
        <img src={BRAND_MARK_URL} alt="" aria-hidden="true" />
        <span>{fallbackText || "התמונה אינה זמינה"}</span>
      </div>
    );
  }
  return <img src={src} alt={alt} onError={() => setFailed(true)} />;
}

export function StatusPill({ state, label }: { state: string; label?: string }) {
  return <span className={`status ${state}`}>{label || stateLabel(state)}</span>;
}

// ── THE GROUP METER — the signature element ────────────────────────────────
// One bar tells the whole group story: progress toward the minimum (the flag),
// capacity, and the warm→green color arc as the group closes in.
export function GroupMeter(props: {
  joined: number;
  threshold: number;
  max: number;
  large?: boolean;
  reached?: boolean;
  showFlag?: boolean;
}) {
  const { joined, threshold, max } = props;
  const capacityPct = clamp((joined / Math.max(1, max)) * 100, 0, 100);
  const flagPct = clamp((threshold / Math.max(1, max)) * 100, 0, 100);
  const targetRatio = joined / Math.max(1, threshold);
  const reached = props.reached ?? joined >= threshold;
  return (
    <div className={`gm${reached ? " celebrate-armed" : ""}`}>
      <div
        className={`gm-track${props.large ? " gm-lg" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={joined}
        aria-label={`הצטרפו ${num(joined)} יחידות מתוך יעד ${num(threshold)}`}
        style={{ marginTop: props.showFlag ? 26 : 0 }}
      >
        <div className="gm-fill" style={{ width: `${capacityPct}%`, background: progressColor(targetRatio) }} />
        {props.showFlag !== false && flagPct > 3 && flagPct < 99 ? (
          <>
            <div className="gm-flag" style={{ insetInlineStart: `${flagPct}%` }} />
            <div className="gm-flag-label" style={{ insetInlineStart: `${flagPct}%` }}>🎯 יעד {num(threshold)}</div>
          </>
        ) : null}
      </div>
      <div className="gm-meta">
        <span>
          <span className="gm-count">{num(joined)}</span> יחידות הצטרפו
        </span>
        {reached
          ? <span className="gm-reached">✓ המינימום הושג</span>
          : <span>עוד <span className="gm-count">{num(Math.max(0, threshold - joined))}</span> ליעד</span>}
      </div>
    </div>
  );
}

export function Countdown(props: { until: string | null | undefined; label?: string; overText?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const view = countdownView(props.until);
  if (!view) return null;
  if (view.tone === "over") return <span className="countdown danger">{props.overText || "הסתיים"}</span>;
  return (
    <span className={`countdown ${view.tone}`}>
      {props.label ? <span className="countdown-label">{props.label}</span> : null}
      <span>⏳ {view.text}</span>
    </span>
  );
}

export function QtyStepper(props: { value: number; min?: number; max: number; onChange: (v: number) => void }) {
  const min = props.min ?? 1;
  return (
    <div className="qty-stepper" role="group" aria-label="בחירת כמות">
      <button type="button" aria-label="הוסף יחידה" disabled={props.value >= props.max} onClick={() => props.onChange(clamp(props.value + 1, min, props.max))}>+</button>
      <span className="qty-value" aria-live="polite">{num(props.value)}</span>
      <button type="button" aria-label="הפחת יחידה" disabled={props.value <= min} onClick={() => props.onChange(clamp(props.value - 1, min, props.max))}>−</button>
    </div>
  );
}

// Modal — on phones it renders as a full-height sheet (see styles):
// pinned header, scrollable body, and an optional sticky `footer` for the
// final CTA so it stays reachable above browser chrome and the keyboard.
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    // lock body scroll while the sheet is open (prevents trapped-scroll fights)
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>("input, button:not(.x), select, textarea")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} style={props.wide ? { maxWidth: 760 } : undefined}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="x" onClick={props.onClose} aria-label="סגירה">✕</button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function useToast(): [string, (msg: string) => void] {
  const [msg, setMsg] = useState("");
  const show = (m: string) => {
    setMsg(m);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setMsg(""), 2600);
  };
  return [msg, show];
}
export function Toast({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div className="toast" role="status">{msg}</div>;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const el = document.createElement("textarea");
      el.value = text; document.body.appendChild(el); el.select();
      document.execCommand("copy"); el.remove();
      return true;
    } catch { return false; }
  }
}

// ── ShareActions — THE one canonical share surface ─────────────────────────
// Exactly ONE copy-link action per share context; recognizable brand icons
// with Hebrew accessible labels. On mobile the native share sheet is the
// primary action. Instagram has no reliable web prefill — it truthfully
// copies the link and tells the user to paste it (never a silent fail).
// Every share is a funnel event; the URL carries the sharer's personal code.
export function ShareActions(props: {
  dealId: string;
  title: string;
  code?: string | null;
  onNotify?: (msg: string) => void;
  compact?: boolean;
}) {
  const url = useMemo(() => absoluteShareUrl(props.dealId, props.code || null), [props.dealId, props.code]);
  const shareTitle = `${props.title} — קנייה קבוצתית ב-C-ton`;
  const canNative = typeof navigator !== "undefined" && Boolean((navigator as any).share);
  const track = (channel: string) => sendFunnelEvent(props.dealId, "share_button_click", { share_channel: channel });
  const copy = async () => {
    track("copy");
    if (await copyText(url)) props.onNotify?.("הקישור הועתק");
    else props.onNotify?.("ההעתקה נכשלה — סמנו את הקישור והעתיקו ידנית");
  };

  const nets: { key: string; label: string; icon: React.ReactNode; href?: string; onClick?: () => void }[] = [
    { key: "whatsapp", label: "שיתוף בוואטסאפ", icon: <WhatsAppIcon />, href: `https://wa.me/?text=${encodeURIComponent(`${shareTitle}\n${url}`)}` },
    { key: "facebook", label: "שיתוף בפייסבוק", icon: <FacebookIcon />, href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
    { key: "x", label: "שיתוף ב-X", icon: <XIcon />, href: `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(shareTitle)}` },
    { key: "telegram", label: "שיתוף בטלגרם", icon: <TelegramIcon />, href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(shareTitle)}` },
    {
      key: "instagram", label: "שיתוף באינסטגרם", icon: <InstagramIcon />,
      onClick: async () => {
        track("instagram");
        if (await copyText(url)) props.onNotify?.("הקישור הועתק — אפשר להדביק אותו בסטורי או בהודעה באינסטגרם");
        else props.onNotify?.("ההעתקה נכשלה — העתיקו את הקישור ידנית ושתפו באינסטגרם");
      }
    }
  ];

  return (
    <div className="share-actions">
      <div className={`share-primary-row${canNative ? "" : " single"}`}>
        {canNative ? (
          <button className="btn btn-primary" aria-label="שיתוף" onClick={async () => {
            track("native");
            try { await (navigator as any).share({ title: shareTitle, url }); } catch { /* user cancelled */ }
          }}>
            <NativeShareIcon /> שיתוף
          </button>
        ) : null}
        <button className="btn btn-ghost" onClick={copy} data-testid="share-copy" aria-label="העתקת קישור">
          <CopyLinkIcon /> העתקת קישור
        </button>
      </div>
      <div className="share-networks share-icons" role="group" aria-label="שיתוף ברשתות">
        {nets.map((n) => n.href ? (
          <a key={n.key} className={`share-ico-btn ${n.key}`} href={n.href} target="_blank" rel="noopener noreferrer"
            aria-label={n.label} title={n.label} onClick={() => track(n.key)}>
            {n.icon}
          </a>
        ) : (
          <button key={n.key} className={`share-ico-btn ${n.key}`} aria-label={n.label} title={n.label} onClick={n.onClick}>
            {n.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton" style={{ height: 320 }} />)}
    </div>
  );
}

export function EmptyState(props: { icon: string; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="center">
      <div style={{ fontSize: "2.6rem" }}>{props.icon}</div>
      <h3 style={{ marginTop: 8 }}>{props.title}</h3>
      {props.body ? <p className="muted">{props.body}</p> : null}
      {props.action}
    </div>
  );
}

export function StatTile(props: { num: React.ReactNode; label: string; tone?: "good" | "warn" | "bad"; sub?: string }) {
  return (
    <div className={`stat-tile${props.tone ? ` ${props.tone}` : ""}`}>
      <div className="num">{props.num}</div>
      <div className="lbl">{props.label}</div>
      {props.sub ? <div className="sub">{props.sub}</div> : null}
    </div>
  );
}
