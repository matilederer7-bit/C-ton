import React, { useEffect, useState } from "react";
import { api, supabaseRecoverPassword, supabaseResendConfirmation, supabaseSignIn, supabaseSignUp, type SupabaseCfg } from "./api";
import { adoptCapabilities } from "./ownerMode";
import { readSession } from "./session";
import { hebrewError } from "./he";
import { BrandMark } from "./brand";

// ── The ONE truthful auth panel (seller + admin surfaces) ───────────────────
// Rules (P0.2-A):
//  * never claim an email ARRIVED — the app can only know a REQUEST was sent
//  * repeated signup of an existing account gets Supabase's deliberately
//    ambiguous answer — say so honestly and offer the real next actions
//  * obvious actions: התחברות · שליחה מחדש של אימות · שכחתי סיסמה
//  * zero English; zero repeated-signup loops
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

  const cfg = async (): Promise<SupabaseCfg> => {
    const c = await api.authConfig();
    if (!c.configured) throw new Error("התחברות אינה זמינה בסביבה זו");
    return c;
  };

  const finishSignIn = async (c: SupabaseCfg) => {
    const token = await supabaseSignIn(c, email.trim(), password, props.surface);
    if (props.verify) await props.verify();
    await adoptCapabilities(token);
    props.onDone();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setInfo(""); setShowResend(false);
    try {
      const c = await cfg();
      if (mode === "recover") {
        await supabaseRecoverPassword(c, email.trim());
        setInfo("בקשת איפוס הסיסמה נשלחה. אם קיים חשבון עם הכתובת הזו — יגיע אליו מייל עם קישור לקביעת סיסמה חדשה.");
        setMode("login");
        setBusy(false);
        return;
      }
      if (mode === "signup") {
        const r = await supabaseSignUp(c, email.trim(), password, props.surface);
        if (r.outcome === "session") {
          if (props.verify) await props.verify();
          await adoptCapabilities(readSession()?.access_token || "");
          props.onDone();
          return;
        }
        if (r.outcome === "confirmation_requested") {
          setInfo("בקשת האימות נשלחה. פתחו את המייל, לחצו על קישור האימות — ואז התחברו כאן.");
        } else {
          // deliberately ambiguous Supabase answer for an existing account —
          // never claim an email was sent
          setInfo(
            <>
              אם זה חשבון חדש — בדקו את המייל להשלמת האימות.<br />
              אם כבר נרשמתם ל-C-ton — עברו להתחברות, או אפסו סיסמה.
            </>
          );
        }
        setShowResend(true);
        setMode("login");
        setBusy(false);
        return;
      }
      await finishSignIn(c);
    } catch (err: any) {
      const msg = hebrewError(err, mode === "login" ? "התחברות נכשלה — נסו שוב" : "הפעולה נכשלה — נסו שוב");
      setError(msg);
      if (/טרם אומת/.test(msg)) setShowResend(true);
      setBusy(false);
    }
  };

  const resend = async () => {
    if (busy || !email.trim()) { setError("הזינו אימייל ואז בקשו שליחה מחדש"); return; }
    setBusy(true); setError(""); setInfo("");
    try {
      const c = await cfg();
      await supabaseResendConfirmation(c, email.trim());
      setInfo("בקשת האימות נשלחה שוב. אם הכתובת רשומה וממתינה לאימות — יגיע אליה מייל. שימו לב: ייתכן שהמייל בתיקיית הספאם.");
    } catch (err: any) {
      setError(hebrewError(err, "שליחת בקשת האימות נכשלה — נסו שוב מאוחר יותר"));
    }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><BrandMark size={54} /></div>
        <h2 style={{ textAlign: "center" }}>{props.title}</h2>
        {props.subtitle ? <p className="muted small" style={{ textAlign: "center" }}>{props.subtitle}</p> : null}
        <form onSubmit={submit}>
          <div className="field">
            <label>אימייל</label>
            <input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          {mode !== "recover" ? (
            <div className="field">
              <label>סיסמה</label>
              <input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"} />
            </div>
          ) : (
            <p className="muted small">נשלח לכתובת קישור לקביעת סיסמה חדשה.</p>
          )}
          {error ? <div className="notice err">{error}</div> : null}
          {info ? <div className="notice ok">{info}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "רגע…"
              : mode === "login" ? "התחברות"
              : mode === "signup" ? (props.signupLabel || "יצירת חשבון")
              : "שליחת קישור איפוס"}
          </button>
        </form>
        <div className="auth-links">
          {mode === "login" ? (
            <>
              <a href="#" onClick={(e) => { e.preventDefault(); setMode("signup"); setError(""); setInfo(""); }}>הרשמה</a>
              <a href="#" onClick={(e) => { e.preventDefault(); setMode("recover"); setError(""); setInfo(""); }}>שכחתי סיסמה</a>
            </>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); setMode("login"); setError(""); setInfo(""); }}>חזרה להתחברות</a>
          )}
          {showResend ? (
            <a href="#" onClick={(e) => { e.preventDefault(); void resend(); }}>שליחה מחדש של אימות</a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
