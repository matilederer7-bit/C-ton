import React, { useState } from "react";
import { api } from "../api";
import { beginSession } from "../session";
import { adoptCapabilities } from "../ownerMode";
import { clearRecoverySession, readRecoverySession } from "../authRedirect";
import { localizedError } from "../he";
import { BrandMark } from "../brand";
import { t } from "../i18n";

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
          <h2>{t("reset.the_reset_link_active")}</h2>
          <p className="muted small">
            {t("reset.reset_links_valid_short_time")}</p>
          <button className="btn btn-primary" onClick={() => navigate("#/seller")}>{t("reset.to_sign_screen")}</button>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !recovery) return;
    if (password.length < 8) { setError(t("reset.the_password_must_least_8")); return; }
    if (password !== confirm) { setError(t("reset.the_passwords_do_match")); return; }
    setBusy(true); setError("");
    try {
      const cfg = await api.authConfig();
      if (!cfg.configured) throw new Error(t("reset.password_reset_available_environment"));
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
        throw Object.assign(new Error(msg || t("reset.updating_password_failed")), { status: res.status, message: msg });
      }
      // the recovery session is a real session — keep the user signed in
      beginSession(recovery, "seller");
      void adoptCapabilities(recovery.access_token);
      clearRecoverySession();
      setDone(true);
    } catch (err: any) {
      setError(localizedError(err, t("reset.updating_password_failed_try_requesting")));
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{ maxWidth: 420, margin: "40px auto" }}>
        <div className="panel" style={{ textAlign: "center" }} data-testid="reset-success">
          <div style={{ fontSize: "2.2rem" }}>✓</div>
          <h2>{t("reset.the_password_updated")}</h2>
          <p className="muted small">{t("reset.you_signed_continue_sellers_area")}</p>
          <button className="btn btn-primary btn-block" onClick={() => navigate("#/seller")}>{t("reset.to_sellers_area")}</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><BrandMark size={54} /></div>
        <h2 style={{ textAlign: "center" }}>{t("reset.set_new_password")}</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label>{t("reset.new_password")}</label>
            <input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-testid="reset-password" />
          </div>
          <div className="field">
            <label>{t("reset.confirm_password")}</label>
            <input dir="ltr" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" data-testid="reset-confirm" />
          </div>
          {error ? <div className="notice err">{error}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy} data-testid="reset-submit">{busy ? t("reset.updating") : t("reset.update_password")}</button>
        </form>
      </div>
    </div>
  );
}
