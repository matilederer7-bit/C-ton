// Browser error reporting. Uncaught errors and unhandled promise rejections
// are posted to the same-origin /api/client-errors relay, which scrubs them
// and forwards them to error monitoring. This file never sees a DSN, a
// cookie, a header or form data: it sends only the error's type, message,
// stack and the route SHAPE (ids and tokens collapsed to :param).

const ENDPOINT = "/api/client-errors";
const MAX_REPORTS_PER_PAGE = 5;
let reported = 0;
const seen = new Set<string>();

function routeShape(): string {
  const raw = (window.location.hash || window.location.pathname || "/").replace(/^#/, "").split(/[?#]/)[0] || "/";
  return raw
    .split("/")
    .slice(0, 8)
    .map((segment) => (!segment || /^[a-z][a-z-]{0,23}$/.test(segment) ? segment : ":param"))
    .join("/");
}

function report(error: unknown) {
  if (reported >= MAX_REPORTS_PER_PAGE) return;
  const err = error instanceof Error ? error : null;
  const message = String(err ? err.message : error ?? "unknown").slice(0, 1_000);
  const key = `${err?.name}|${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  reported += 1;
  const body = JSON.stringify({
    source: "web",
    type: (err?.name || "BrowserError").slice(0, 120),
    message,
    stack: String(err?.stack || "").slice(0, 8_000),
    route: routeShape(),
    release: String((import.meta as any).env?.VITE_RELEASE || "").slice(0, 80) || undefined
  });
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "omit",
      keepalive: true
    }).catch(() => undefined);
  } catch {
    // Reporting must never create a second failure.
  }
}

export function installErrorReporting() {
  window.addEventListener("error", (event) => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
}
