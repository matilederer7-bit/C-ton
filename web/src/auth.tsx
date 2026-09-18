import React, { useEffect, useState } from "react";
import { api, supabaseRecoverPassword, supabaseResendConfirmation, supabaseSignIn, supabaseSignUp, type SupabaseCfg } from "./api";
import { adoptCapabilities, leaveGuestModeInPlace } from "./ownerMode";
import { readSession } from "./session";
import { localizedError } from "./he";
import { BrandMark } from "./brand";
import { beginAuthAttempt, traceAuth } from "./authTrace";
import { t } from "./i18n";

// ── The ONE truthful auth panel (P0.3-1) ────────────────────────────────────
// SIGN IN, SIGN UP and VERIFY are three separate experiences that never mix:
//  * the DEFAULT is plain login — email+password → /token → capabilities.
//    A login NEVER calls /signup and NEVER mentions verification unless the
//    server itself says the email is unconfirmed.
//  * signup happens ONLY when the user explicitly chose "הרשמה", and its
//    wording never claims an email ARRIVED — only that a request was sent.
//  * a repeated signup of an existing account gets Supabase's deliberately
//    ambiguous answer: we say so honestly and hand the user a PROMINENT
//    "להתחברות" action instead of trapping them in resend loops.
type Mode = "login" | "signup" | "recover";

export function AuthPanel(props: {
  surface: "seller" | "admin";
  title: string;
  subtitle?: string;
  initialMode?: "login" | "signup";
  signupLabel?: string;
  // extra server-side verification after sign-in (e.g. admin capability);
  // throw a Hebrew Error to reject
  verify?: () => Promise<void>;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>(props.initialMode || "login");
  useEffect(() => { if (props.initialMode) setMode(props.initialMode); }, [props.initialMode]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<React.ReactNode>("");
  const [showResend, setShowResend] = useState(false);
  const [showLoginCta, setShowLoginCta] = useState(false);
  // P0.4-1: the password was accepted and the session stored, but capability
  // discovery was temporarily unavailable — "נסו שוב" retries DISCOVERY only,
  // never the password.
  const [capsRetryToken, setCapsRetryToken] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    setMode(m); setError(""); setInfo(""); setShowResend(false); setShowLoginCta(false); setCapsRetryToken(null);
  };

  const cfg = async (): Promise<SupabaseCfg> => {
    const c = await api.authConfig();
    if (!c.configured) throw new Error(t("auth.82681f86"));
    return c;
  };

  // Transactional completion (P0.4-1): navigate ONLY once capabilities are
  // resolved and surfaces granted. A valid session is never discarded because
  // discovery hiccuped — the user gets one deterministic message + retry.
  const completeWithCapabilities = async (token: string) => {
    const adoption = await adoptCapabilities(token);
    if (adoption.status !== "ok") {
      setCapsRetryToken(token);
      setInfo(t("auth.e7fc0c4f"));
      setBusy(false);
      return;
    }
    setCapsRetryToken(null);
    traceAuth("AUTH_SURFACE_GRANTED");
    props.onDone();
    traceAuth("AUTH_NAVIGATION_COMPLETE");
  };

  const retryCapabilities = async () => {
    if (busy || !capsRetryToken) return;
    setBusy(true); setError(""); setInfo("");
    try { await completeWithCapabilities(capsRetryToken); }
    catch (err: any) { setError(localizedError(err)); setBusy(false); }
  };

  const finishSignIn = async (c: SupabaseCfg) => {
    beginAuthAttempt();
    traceAuth("AUTH_PASSWORD_REQUEST");
    let token: string;
    try {
      token = await supabaseSignIn(c, email.trim(), password, props.surface);
    } catch (err) {
      traceAuth("AUTH_PASSWORD_FAILURE");
      throw err;
    }
    traceAuth("AUTH_PASSWORD_SUCCESS");
    traceAuth("AUTH_SESSION_STORED");
    // an explicit login intentionally leaves stale Guest view mode — otherwise
    // the API client would keep stripping Authorization after a perfect login
    leaveGuestModeInPlace();
    if (props.verify) { traceAuth("AUTH_VERIFY_SURFACE"); await props.verify(); }
    await completeWithCapabilities(token);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setInfo(""); setShowResend(false); setShowLoginCta(false); setCapsRetryToken(null);
    try {
      const c = await cfg();
      if (mode === "recover") {
        await supabaseRecoverPassword(c, email.trim());
        setInfo(t("auth.9dd7efa0"));
        setMode("login");
        setBusy(false);
        return;
      }
      if (mode === "signup") {
        const r = await supabaseSignUp(c, email.trim(), password, props.surface);
        if (r.outcome === "session") {
          leaveGuestModeInPlace();
          if (props.verify) await props.verify();
          await completeWithCapabilities(readSession()?.access_token || "");
          return;
        }
        if (r.outcome === "confirmation_requested") {
          setInfo(
            <>
              {t("auth.1cb055f8")}<br />
              {t("auth.df3e4272")}</>
          );
          setShowResend(true);
        } else {
          // deliberately ambiguous Supabase answer for an existing account —
          // never claim an email was sent; hand the user straight to login
          setInfo(t("auth.7932f3a2"));
          setShowLoginCta(true);
        }
        setMode("login");
        setBusy(false);
        return;
      }
      // plain LOGIN: /token only — never /signup, never a verification claim
      await finishSignIn(c);
    } catch (err: any) {
      traceAuth("AUTH_FLOW_ERROR", String(err?.message || err).slice(0, 80));
      const msg = localizedError(err, mode === "login" ? t("auth.8d72d128") : t("auth.a507230e"));
      setError(msg);
      if (/טרם אומת/.test(msg)) setShowResend(true);
      setBusy(false);
    }
  };

  const resend = async () => {
    if (busy || !email.trim()) { setError(t("auth.a24ade29")); return; }
    setBusy(true); setError(""); setInfo("");
    try {
      const c = await cfg();
      await supabaseResendConfirmation(c, email.trim());
      setInfo(t("auth.996b5771"));
    } catch (err: any) {
      setError(localizedError(err, t("auth.9359c63a")));
    }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><BrandMark size={54} /></div>
        {/* the login surface IS the page while it is shown (the seller and admin
            dashboards replace it once authenticated), so its title is the page's
            h1 — it was an h2, which left those routes with no top-level heading */}
        <h1 className="auth-title">{props.title}</h1>
        {mode === "signup" ? (
          <p className="muted small" style={{ textAlign: "center" }}>{t("auth.7846e30c")} <a href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>{t("auth.8a5a5423")}</a></p>
        ) : props.subtitle ? (
          <p className="muted small" style={{ textAlign: "center" }}>{props.subtitle}</p>
        ) : null}
        <form onSubmit={submit}>
          <div className="field">
            <label>{t("auth.15dbea0f")}</label>
            <input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          {mode !== "recover" ? (
            <div className="field">
              <label>{t("auth.0b490b5e")}</label>
              <input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"} />
            </div>
          ) : (
            <p className="muted small">{t("auth.d49bd1ab")}</p>
          )}
          {error ? <div className="notice err">{error}</div> : null}
          {info ? <div className="notice ok">{info}</div> : null}
          {showLoginCta || capsRetryToken ? null : (
            <button className="btn btn-primary btn-block" data-testid="auth-submit" disabled={busy}>
              {busy ? t("auth.2129ee06")
                : mode === "login" ? t("auth.254e07f0")
                : mode === "signup" ? (props.signupLabel || t("auth.070f0a6c"))
                : t("auth.3d33ff5c")}
            </button>
          )}
        </form>
        {capsRetryToken ? (
          <button className="btn btn-primary btn-block" data-testid="auth-caps-retry" disabled={busy}
            onClick={() => { void retryCapabilities(); }}>
            {busy ? t("auth.2129ee06") : t("auth.8c634e7d")}
          </button>
        ) : null}
        {showLoginCta ? (
          <button className="btn btn-primary btn-block" data-testid="auth-goto-login" onClick={() => { switchMode("login"); }}>
            {t("auth.8a5a5423")}</button>
        ) : null}
        <div className="auth-links">
          {mode === "login" ? (
            <>
              <a href="#" data-testid="auth-goto-signup" onClick={(e) => { e.preventDefault(); switchMode("signup"); }}>{t("auth.d7ac71c3")}</a>
              <a href="#" onClick={(e) => { e.preventDefault(); switchMode("recover"); }}>{t("auth.cc3c3a9d")}</a>
            </>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>{t("auth.b8127d46")}</a>
          )}
          {showResend ? (
            <a href="#" onClick={(e) => { e.preventDefault(); void resend(); }}>{t("auth.4bd0e34b")}</a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
