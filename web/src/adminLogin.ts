// Username sign-in for admins created from the admin team screen.
//
// A team admin's Supabase Auth identity is the synthetic, undeliverable
// e-mail <username>@admins.siton.invalid (created server-side only — see
// src/admin_team.ts). The admin login therefore accepts either a real e-mail
// or a bare username and maps the latter onto that address; the password
// still goes ONLY to Supabase's canonical password grant.
export const ADMIN_LOGIN_DOMAIN = "admins.siton.invalid";
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;

export function adminLoginEmail(identifier: string): string {
  const value = identifier.trim();
  if (value.includes("@")) return value;
  const username = value.toLowerCase();
  return USERNAME_RE.test(username) ? `${username}@${ADMIN_LOGIN_DOMAIN}` : value;
}
