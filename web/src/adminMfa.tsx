import React, { useEffect, useState } from "react";
import { api } from "./api";
import { beginSession, ensureFreshSession, readSession, type AuthSessionPayload } from "./session";
import { QrCode } from "./qrcode";
import { localizedError } from "./he";
import { t } from "./i18n/index.js";

// ── Admin second-factor step-up (Codex P1 on #120) ─────────────────────────
// Identity-management actions (creating an admin) require a RECENT second
// factor: the server accepts only a Supabase AAL2 token. This panel raises the
// current admin session to AAL2 through Supabase Auth's own TOTP MFA — no
// parallel system: on first use it enrolls an authenticator app (QR + setup
// key), afterwards it asks for the 6-digit code. The code goes only to
// Supabase; the upgraded session replaces the stored one.
type Factor = { id: string; factor_type: string; status: string };

async function authCall(path: string, init: RequestInit = {}): Promise<any> {
  const cfg = await api.authConfig();
  if (!cfg.configured) throw new Error(t("admin_mfa.unavailable"));
  await ensureFreshSession(); // a near-expiry token would otherwise yield a spurious 401
  const token = readSession()?.access_token || "";
  const res = await fetch(`${cfg.supabase_url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", apikey: cfg.supabase_anon_key, authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(localizedError({ status: res.status, message: String(body?.msg || body?.error_description || body?.message || body?.error || "") }, t("admin_mfa.failed")));
    err.status = res.status;
    throw err;
  }
  return body;
}

export function AdminMfaStepUp({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const [factorId, setFactorId] = useState("");
  const [enroll, setEnroll] = useState<{ uri: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await authCall(`/auth/v1/user`);
        if (cancelled) return;
        const factors: Factor[] = Array.isArray(user?.factors) ? user.factors : [];
        const verified = factors.find((f) => f.factor_type === "totp" && f.status === "verified");
        if (verified) {
          if (!cancelled) setFactorId(String(verified.id));
        } else if (factors.some((f) => f.status === "verified")) {
          // A verified non-TOTP factor (e.g. phone) blocks enrolling TOTP at AAL1.
          if (!cancelled) setError(t("admin_mfa.other_factor"));
        } else {
          // Clear abandoned unverified TOTP enrollments (cancelled/reloaded
          // attempts) so they neither collide on friendly_name nor pile up
          // toward the per-user factor cap. GoTrue allows this at AAL1.
          // (This also removes an unverified enrollment started in another open
          // tab by the same admin; that tab simply enrolls again.)
          // Best-effort and idempotent: a factor that is already gone (404 —
          // e.g. a second run of this effect deleted it first) or a failed
          // delete never blocks enrolling; the collision-proof name below keeps
          // the new enrollment valid either way.
          for (const f of factors) {
            if (cancelled) return;
            if (f.factor_type === "totp" && f.status !== "verified") {
              await authCall(`/auth/v1/factors/${encodeURIComponent(String(f.id))}`, { method: "DELETE" }).catch(() => undefined);
            }
          }
          if (cancelled) return;
          const suffix = Math.random().toString(36).slice(2, 8);
          const created = await authCall(`/auth/v1/factors`, {
            method: "POST",
            body: JSON.stringify({ factor_type: "totp", friendly_name: `Siton admin ${new Date().toISOString().slice(0, 19)} ${suffix}` })
          });
          if (!cancelled) {
            setFactorId(String(created.id));
            setEnroll({ uri: String(created?.totp?.uri || ""), secret: String(created?.totp?.secret || "") });
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(localizedError(err, t("admin_mfa.failed")));
      }
      if (!cancelled) setBusy(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !factorId) return;
    if (!/^\d{6}$/.test(code.trim())) { setError(t("admin_mfa.code_format")); return; }
    setBusy(true); setError("");
    try {
      const challenge = await authCall(`/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, { method: "POST", body: "{}" });
      const session = await authCall(`/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, {
        method: "POST",
        body: JSON.stringify({ challenge_id: String(challenge.id), code: code.trim() })
      });
      beginSession(session as AuthSessionPayload, "admin");
      setCode("");
      onVerified();
    } catch (err: any) {
      setError(err?.status === 422 || err?.status === 400 ? t("admin_mfa.wrong_code") : localizedError(err, t("admin_mfa.failed")));
    }
    setBusy(false);
  };

  return (
    <div className="panel" data-testid="admin-mfa">
      <div className="panel-title">{t("admin_mfa.title")}</div>
      <p className="muted small">{enroll ? t("admin_mfa.enroll_hint") : t("admin_mfa.code_hint")}</p>
      {enroll ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginBottom: 12 }}>
          {enroll.uri ? <QrCode value={enroll.uri} size={180} label={t("admin_mfa.qr_label")} /> : null}
          <div>
            <div className="muted small">{t("admin_mfa.setup_key")}</div>
            <code dir="ltr" data-testid="admin-mfa-secret" style={{ wordBreak: "break-all" }}>{enroll.secret}</code>
          </div>
        </div>
      ) : null}
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="admin-mfa-code">{t("admin_mfa.code")}</label>
          <input id="admin-mfa-code" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="admin-mfa-code" />
        </div>
        {error ? <div className="notice err" role="alert" data-testid="admin-mfa-error">{error}</div> : null}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" disabled={busy || !factorId} data-testid="admin-mfa-submit">{t("admin_mfa.verify")}</button>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("admin_mfa.cancel")}</button>
        </div>
      </form>
    </div>
  );
}
