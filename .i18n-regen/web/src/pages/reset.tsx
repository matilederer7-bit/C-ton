import React, { useState } from "react";
import { api } from "../api";
import { beginSession } from "../session";
import { adoptCapabilities } from "../ownerMode";
import { clearRecoverySession, readRecoverySession } from "../authRedirect";
import { hebrewError } from "../he";
import { BrandMark } from "../brand";

// ── Canonical password-reset screen (P0.3-11) ───────────────────────────────
// Reached from the REAL Supabase recovery link (fragment captured at boot).
// Sets the new password via the supported GoTrue user-update call with the
// recovery session token, then establishes a normal session.
export function ResetPasswordPage({ navigate }: { navigate: (h: string) => void }) {
  const recovery = readRecoverySession();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!recovery && !done) {
    return (
      <div style={{ maxWidth: 420, margin: "40px auto" }}>
        <div className="panel" style={{ textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><BrandMark size={54} /></div>
          <h2>קישור האיפוס אינו פעיל</h2>
          <p className="muted small">
            קישורי איפוס תקפים לזמן קצר וחד-פעמיים. אפשר לבקש קישור חדש דרך
            "שכחתי סיסמה" במסך ההתחברות.
          </p>
          <button className="btn btn-primary" onClick={() => navigate("#/seller")}>למסך ההתחברות</button>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !recovery) return;
    if (password.length < 8) { setError("הסיסמה חייבת להכיל לפחות 8 תווים"); return; }
    if (password !== confirm) { setError("הסיסמאות אינן זהות"); return; }
    setBusy(true); setError("");
    try {
      const cfg = await api.authConfig();
      if (!cfg.configured) throw new Error("איפוס סיסמה אינו זמין בסביבה זו");
      const res = await fetch(`${cfg.supabase_url}/auth/v1/user`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          apikey: cfg.supabase_anon_key,
          authorization: `Bearer ${recovery.access_token}`
        },
        body: JSON.stringify({ password })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(body?.error_description || body?.msg || body?.error || "");
        throw Object.assign(new Error(msg || "עדכון הסיסמה נכשל"), { status: res.status, message: msg });
      }
      // the recovery session is a real session — keep the user signed in
      beginSession(recovery, "seller");
      void adoptCapabilities(recovery.access_token);
      clearRecoverySession();
      setDone(true);
    } catch (err: any) {
      setError(hebrewError(err, "עדכון הסיסמה נכשל — נסו לבקש קישור איפוס חדש"));
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{ maxWidth: 420, margin: "40px auto" }}>
        <div className="panel" style={{ textAlign: "center" }} data-testid="reset-success">
          <div style={{ fontSize: "2.2rem" }}>✓</div>
          <h2>הסיסמה עודכנה</h2>
          <p className="muted small">אתם מחוברים — אפשר להמשיך לאזור המוכרים.</p>
          <button className="btn btn-primary btn-block" onClick={() => navigate("#/seller")}>לאזור המוכרים ←</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><BrandMark size={54} /></div>
        <h2 style={{ textAlign: "center" }}>קביעת סיסמה חדשה</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label>סיסמה חדשה</label>
            <input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-testid="reset-password" />
          </div>
          <div className="field">
            <label>אימות סיסמה</label>
            <input dir="ltr" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" data-testid="reset-confirm" />
          </div>
          {error ? <div className="notice err">{error}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy} data-testid="reset-submit">{busy ? "מעדכנים…" : "עדכון הסיסמה"}</button>
        </form>
      </div>
    </div>
  );
}
