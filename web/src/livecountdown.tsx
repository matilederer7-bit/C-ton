import React, { useEffect, useRef, useState } from "react";
import {
  COUNTDOWN_TICK_MS, COUNTDOWN_UNITS, countdownAccessibleLabel, countdownParts, formatCountdownNumber,
  sameCountdownParts, type CountdownParts
} from "./countdown";

// ── LiveCountdown (P0.3-2 clock, P0.7 presentation) ─────────────────────────
// * canonical deadline (UTC ISO) + a server-time offset (from the response
//   Date header) anchor the countdown to authoritative time
// * rendering is anchored to performance.now(), recomputed ABSOLUTELY every
//   tick — never an accumulating setInterval
// * four unit cells — label ABOVE, un-padded number BELOW (web/src/countdown.ts)
// * hidden document pauses the loop; visibility return re-anchors from
//   authoritative time
// * at zero: every unit shows 0 and onZero fires once (UI flips to closed);
//   nothing here ever contradicts the server deal state — it only presents time

let serverOffsetPromise: Promise<number> | null = null;
function getServerOffsetMs(): Promise<number> {
  if (!serverOffsetPromise) {
    serverOffsetPromise = (async () => {
      try {
        const t0 = Date.now();
        const res = await fetch("/api/preview/meta", { method: "GET", cache: "no-store" });
        const t1 = Date.now();
        const dateHeader = res.headers.get("date");
        if (!dateHeader) return 0;
        const serverMs = Date.parse(dateHeader) + 500; // header has 1s resolution
        const midpoint = (t0 + t1) / 2;
        const offset = serverMs - midpoint;
        return Math.abs(offset) > 1500 ? offset : 0; // ignore sub-noise offsets
      } catch { return 0; }
    })();
  }
  return serverOffsetPromise;
}

export function LiveCountdown({ deadline, onZero, className, compact }: {
  deadline: string | null | undefined;
  onZero?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const [parts, setParts] = useState<CountdownParts | null>(null);
  const zeroFired = useRef(false);
  const onZeroRef = useRef(onZero);
  onZeroRef.current = onZero;

  useEffect(() => {
    const deadlineMs = Date.parse(String(deadline || ""));
    if (!Number.isFinite(deadlineMs)) { setParts(null); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let anchorRemaining = 0;
    let anchorPerf = 0;

    const reanchor = async () => {
      const offset = await getServerOffsetMs();
      anchorRemaining = deadlineMs - (Date.now() + offset);
      anchorPerf = performance.now();
    };

    const remainingNow = () => anchorRemaining - (performance.now() - anchorPerf);

    const tick = () => {
      if (stopped) return;
      const rem = remainingNow();
      const next = countdownParts(rem);
      setParts((prev) => (sameCountdownParts(prev, next) ? prev : next));
      if (rem <= 0) {
        if (!zeroFired.current) { zeroFired.current = true; onZeroRef.current?.(); }
        return; // settled at zero — stop the loop
      }
      if (document.hidden) return; // resumes on visibilitychange
      timer = setTimeout(tick, COUNTDOWN_TICK_MS);
    };

    const start = async () => { await reanchor(); if (!stopped) tick(); };
    const onVisibility = () => { if (!document.hidden && !stopped) { void start(); } };
    document.addEventListener("visibilitychange", onVisibility);
    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deadline]);

  if (!parts) return null;
  const tone = parts.reached ? " reached" : parts.urgent ? " final" : "";
  return (
    <div
      className={`live-countdown${tone}${compact ? " compact" : ""}${className ? ` ${className}` : ""}`}
      role="timer"
      aria-live="off"
      aria-label={countdownAccessibleLabel(parts)}
      data-testid="live-countdown"
      data-reached={parts.reached ? "1" : "0"}
    >
      {COUNTDOWN_UNITS.map((unit) => (
        <div className="cd-unit" key={unit.key} data-unit={unit.key}>
          <span className="cd-label" aria-hidden="true">{unit.label}</span>
          <span className="cd-num" data-testid={`cd-${unit.key}`}>{formatCountdownNumber(parts[unit.key])}</span>
        </div>
      ))}
    </div>
  );
}
