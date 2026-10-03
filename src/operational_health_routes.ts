// OPERATIONAL HEALTH — the liveness and readiness HTTP routes.
//
// Lean Refactor round 2: `GET /health` and `GET /readiness` were moved verbatim
// out of src/app.ts. Nothing about them changed: same paths, same methods, same
// response bodies, same `x-readiness-cache` / `x-readiness-age-ms` headers, same
// 503 on a failed verdict, same per-caller `client_ip` / `trust_proxy_hops`
// fields. The readiness PROBE itself (createReadinessProbe with the canonical
// runtime check, its pool, its recovered/warn logging and its exported state)
// deliberately stays in src/app.ts and arrives here by dependency injection, so
// `readinessProbe` keeps being exported from src/app.ts for the tests and the
// pool shutdown path. This module never imports src/app.ts.
import type { FastifyInstance } from "fastify";
import type { ReadinessProbe } from "./readiness_probe.js";

export type OperationalHealthRouteDeps = {
  /** The runtime's readiness probe (cached, bounded, grace-aware DB verdict). Created in src/app.ts. */
  readinessProbe: ReadinessProbe;
  /** The runtime's TRUST_PROXY_HOPS resolver (src/runtime_config.ts), reported back to the caller on /readiness. */
  resolveTrustProxyHops: () => number;
};

export function registerOperationalHealthRoutes(app: FastifyInstance, deps: OperationalHealthRouteDeps) {
  const { readinessProbe, resolveTrustProxyHops } = deps;

  app.get("/health", async () => ({ ok: true }));

  app.get("/readiness", async (req: any, reply: any) => {
    const verdict = await readinessProbe.probe();
    reply.header("x-readiness-cache", verdict.cached ? "hit" : "miss");
    reply.header("x-readiness-age-ms", String(verdict.age_ms));
    if (!verdict.ok) return reply.code(503).send(verdict.body);
    // Operational aid for the proxy hop configuration (A2): the address the
    // runtime attributes to THIS caller. Lets an operator confirm from a
    // browser that TRUST_PROXY_HOPS resolves their real address (not a proxy,
    // not a spoofed X-Forwarded-For prefix). It is the caller's own address.
    return { ...verdict.body, client_ip: String(req.ip || ""), trust_proxy_hops: resolveTrustProxyHops() };
  });
}
