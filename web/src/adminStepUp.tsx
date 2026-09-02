import React, { useState } from "react";
import { api, supabaseSignIn } from "./api";
import { adoptCapabilities, leaveGuestModeInPlace, readOwnerCaps } from "./ownerMode";
import { markAdminUnlocked } from "./adminGate";
import { hebrewError } from "./he";
import { BrandMark } from "./brand";
import { beginAuthAttempt, traceAuth } from "./authTrace";

// ── Admin password step-up (P0.5-1) ─────────────────────────────────────────
// Shown after the hidden two-tap entry, and for ANY #/admin navigation while
// the session is not step-up-unlocked. When the current account's canonical
// email is known (adopted capabilities), only the password is requested; the
// password goes ONLY to Supabase's canonical password grant — never stored,
// never logged, never sent to the C-ton backend. Entry requires BOTH a
// correct password AND a server-confirmed Admin capability.
export function AdminStepUp({ onUnlocked, onCancel }: { onUnlocked: () => void; onCancel: () => void }) {
  const knownEmail = readOwnerCaps()?.email || "";
  const [email, setEmail] = useState(knownEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    beginAuthAttempt();
    traceAuth("AUTH_PASSWORD_REQUEST", "admin step-up");
    try {
      const cfg = await api.authConfig();
      if (!cfg.configured) throw new Error("התחברות אינה זמינה בסביבה זו");
      const token = await supabaseSignIn(cfg, email.trim(), password, "admin");
      traceAuth("AUTH_PASSWORD_SUCCESS", "admin step-up");
      leaveGuestModeInPlace();
      const adoption = await adoptCapabilities(token);
      if (adoption.status !== "ok") {
        throw new Error("ההתחברות הצליחה, אך טעינת החשבון נכשלה זמנית. נסו שוב.");
      }
      if (!adoption.caps.admin) {
        // correct password, but this identity holds no Admin capability —
        // it stays OUTSIDE Admin.
        throw new Error("לחשבון זה אין הרשאת ניהול");
      }
      markAdminUnlocked();
      traceAuth("AUTH_SURFACE_GRANTED", "admin step-up unlocked");
      onUnlocked();
    } catch (err: any) {
      traceAuth("AUTH_FLOW_ERROR", "admin step-up");
      setError(hebrewError(err, "הכניסה נכשלה — נסו שוב"));
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <main className="container">
      <div style={{ maxWidth: 380, margin: "60px auto" }}>
        <div className="panel" data-testid="admin-stepup">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><BrandMark size={48} /></div>
          <h2 style={{ textAlign: "center" }}>כניסת מנהל</h2>
          <form onSubmit={submit}>
            {/* P0.6-1 — the email is ALWAYS visible so the user sees exactly
                WHICH account is being authenticated; prefilled from the
                canonical session and editable (editing = switching account). */}
            <div className="field">
              <label>אימייל</label>
              <input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" data-testid="stepup-email" />
              {knownEmail ? <span className="hint">זהו החשבון המחובר — אפשר לערוך כדי להתחבר עם חשבון אחר.</span> : null}
            </div>
            <div className="field">
              <label>סיסמה</label>
              <input dir="ltr" type="password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" data-testid="stepup-password" />
            </div>
            {error ? <div className="notice err" data-testid="stepup-error">{error}</div> : null}
            <button className="btn btn-primary btn-block" data-testid="stepup-submit" disabled={busy}>
              {busy ? "רגע…" : "כניסה למערכת הניהול"}
            </button>
          </form>
          <div className="auth-links">
            <a href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>חזרה לאתר</a>
          </div>
        </div>
      </div>
    </main>
  );
}
