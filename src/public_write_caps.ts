// Per-client hourly caps for anonymous public writers (Black-Sky C5).
//
// The public support form (30/h), deal inquiries (200/h) and buyer feedback
// (200/h) had PLATFORM-WIDE hourly caps counted in the database (plus
// per-e-mail / per-deal caps). One client could burn the whole platform budget
// and starve every real buyer for the rest of the hour. These caps add a
// per-client-address budget IN FRONT of the global one; the global and
// per-identity caps are unchanged (never weakened).
//
// The address key is the same one the request limiter uses (trusted-proxy
// resolved req.ip, IPv6 keyed by /64). Like that limiter the store is
// in-process (single_instance_only): with N web instances an abuser gets at
// most N x the per-client budget, still far below the global cap.

// IPv6 clients are keyed by their /64: one allocation holds 2^64 addresses,
// so a per-address key gave a single host unlimited budgets.
export function rateLimitClientKey(ip: string): string {
  const value = String(ip || "unknown").trim().toLowerCase();
  if (!value.includes(":") || value.startsWith("::ffff:")) return value.replace(/^::ffff:/, "");
  const head = value.split("%")[0] ?? value;
  const parts = head.split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const full = [...left, ...Array(missing).fill("0"), ...right].slice(0, 8);
  return full.slice(0, 4).map((h) => h || "0").join(":") + "::/64";
}

export type PublicWriteSurface = "support_contact" | "inquiry" | "feedback";

const DEFAULT_PER_CLIENT_PER_HOUR: Record<PublicWriteSurface, number> = {
  // Per e-mail the form allows 3/h; a shared NAT (office, school) gets a few
  // people's worth, still a third of the 30/h platform cap.
  support_contact: 10,
  // Per customer e-mail 5/h; per deal 40/h; platform 200/h.
  inquiry: 30,
  // Per deal 60/h; platform 200/h. Feedback is one tap after a join.
  feedback: 30
};

const ENV_NAME: Record<PublicWriteSurface, string> = {
  support_contact: "SUPPORT_CONTACT_PER_IP_PER_HOUR",
  inquiry: "INQUIRY_PER_IP_PER_HOUR",
  feedback: "FEEDBACK_PER_IP_PER_HOUR"
};

/** Bounded 1..1000; an operator can tune the budget but never switch it off. */
export function publicWriteCapPerHour(surface: PublicWriteSurface, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_NAME[surface]];
  const parsed = Math.floor(Number(raw));
  if (raw === undefined || String(raw).trim() === "" || !Number.isFinite(parsed)) return DEFAULT_PER_CLIENT_PER_HOUR[surface];
  return Math.min(1000, Math.max(1, parsed));
}

const WINDOW_MS = 60 * 60_000;
const MAX_KEYS = 50_000;

export class PublicWriteCapStore {
  private entries = new Map<string, { count: number; resetAt: number }>();

  /** Counts the attempt; returns false when it is over the cap (the attempt still costs budget). */
  consume(surface: PublicWriteSurface, clientIp: string, now = Date.now(), cap = publicWriteCapPerHour(surface)): boolean {
    const key = `${surface}:${rateLimitClientKey(clientIp)}`;
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.entries.size >= MAX_KEYS) this.purge(now);
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= cap;
  }

  purge(now = Date.now()) {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
    // Still full of live keys (address-rotation flood): drop the oldest half.
    if (this.entries.size >= MAX_KEYS) {
      let drop = Math.floor(this.entries.size / 2);
      for (const key of this.entries.keys()) { if (drop-- <= 0) break; this.entries.delete(key); }
    }
  }

  reset() { this.entries.clear(); }
}

export const publicWriteCaps = new PublicWriteCapStore();
