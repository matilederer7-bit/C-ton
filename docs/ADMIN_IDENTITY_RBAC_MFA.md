# Admin Identity, RBAC And MFA

Status: foundation implemented; demo gate can pass, live pilot remains blocked until operational enrollment and runbooks are complete.

## Identity Model

Admin identity is now represented by `siton.admin_users`.

Roles:

- `SuperAdmin`
- `OpsAdmin`
- `SupportAdmin`
- `ReadOnlyAdmin`

Statuses:

- `Active`
- `Suspended`
- `Disabled`

Passwords are stored as `scrypt` hashes only. No default admin password is committed.

First admin bootstrap is manual:

```bash
ADMIN_BOOTSTRAP_EMAIL=admin@example.com ADMIN_BOOTSTRAP_PASSWORD=... npm run admin:create-user
```

The script reads values from env only and does not print the password.

## Session Model

Admin sessions are stored in `siton.admin_sessions`.

- Raw session token is returned only once in the cookie.
- DB stores `session_token_hash` only.
- Cookie: `HttpOnly`, `SameSite=Lax`, bounded `Max-Age`, and `Secure` in production-like environments.
- `mfa_verified_at` is stored on the session and is used for sensitive actions.

## MFA Model

MFA foundation uses email-OTP style challenges:

- `siton.admin_mfa_challenges` stores `code_hash`, not raw code.
- `siton.admin_mfa_factors` stores factor metadata.
- Dev code is returned only outside production-like environments.
- Sensitive actions require recent MFA.

This is a safe foundation, but not yet full production-grade MFA operations. Live pilot still needs enrollment, recovery, disable, rotation and operator runbooks.

## RBAC

Permissions are a closed set in `src/admin_identity.ts`.

Examples:

- `mission_control.read`
- `admin_actions.read`
- `admin_actions.create`
- `admin_actions.approve`
- `admin_actions.execute`
- `admin_users.manage`
- `support.manage`
- `security.read`
- `payout.freeze`
- `emergency.pause`
- `invoice.retry`
- `notification.retry`
- `outbox.requeue`

High-trust permissions such as `payout.freeze` and `emergency.pause` are held by `SuperAdmin` only. Operational roles can perform bounded retry/requeue/support actions, but cannot execute emergency or payout-freeze actions.

Sensitive admin actions require:

- session identity,
- required permission,
- recent MFA,
- second approval when configured.

## ADMIN_API_KEY Fallback

`ADMIN_API_KEY` remains as bootstrap/read-only fallback.

Allowed fallback scope:

- Mission Control read.
- Admin actions read.
- Security/readiness read.

Not allowed via shared key only:

- create/approve/execute sensitive admin actions,
- emergency actions,
- payout freeze/unfreeze,
- identity or MFA management.

## Live Pilot Requirements

- Provision named admins through controlled secret/bootstrap process.
- Enroll MFA for all admins.
- Disable or tightly restrict shared-key fallback in live operations.
- Define admin recovery/disable procedures.
- Review role assignments before live money.
