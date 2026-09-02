import React, { useEffect, useRef, useState } from "react";

// ── LiveCountdown (P0.3-2) — a real drift-free clock ────────────────────────
// * canonical deadline (UTC ISO) + a server-time offset (from the response
//   Date header) anchor the countdown to authoritative time
// * rendering is anchored to performance.now(), recomputed ABSOLUTELY every
//   frame — never an accumulating setInterval
// * above 1 hour: ‎DD ימים HH:MM:SS (1s cadence)
// * under 1 hour: HH:MM:SS:CC with hundredths via requestAnimationFrame
// * hidden document pauses the loop; visibility return re-anchors from
//   authoritative time
// * at zero: 00:00:00:00 and onZero fires once (UI flips to closed)

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

const pad2 = (n: number) => String(Math.max(0, n)).padStart(2, "0");

function formatRemaining(ms: number): { text: string; final: boolean } {
  if (ms <= 0) return { text: "00:00:00:00", final: true };
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (ms > 3600_000) {
    return { text: `${pad2(days)} ימים ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`, final: false };
  }
  const hundredths = Math.floor((ms % 1000) / 10);
  return { text: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(hundredths)}`, final: true };
}

export function LiveCountdown({ deadline, onZero, className }: { deadline: string | null | undefined; onZero?: () => void; className?: string }) {
  const [display, setDisplay] = useState<{ text: string; final: boolean } | null>(null);
  const zeroFired = useRef(false);
  const onZeroRef = useRef(onZero);
  onZeroRef.current = onZero;

  useEffect(() => {
    const deadlineMs = Date.parse(String(deadline || ""));
    if (!Number.isFinite(deadlineMs)) { setDisplay(null); return; }
    let raf = 0;
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
      setDisplay((prev) => {
        const next = formatRemaining(rem);
        return prev && prev.text === next.text ? prev : next;
      });
      if (rem <= 0) {
        if (!zeroFired.current) { zeroFired.current = true; onZeroRef.current?.(); }
        return; // stop the loop at zero
      }
      if (document.hidden) return; // resumes on visibilitychange
      if (rem <= 3600_000) {
        raf = requestAnimationFrame(tick); // hundredths need frame cadence
      } else {
        timer = setTimeout(tick, 250); // seconds cadence, absolute recompute
      }
    };

    const start = async () => { await reanchor(); if (!stopped) tick(); };
    const onVisibility = () => { if (!document.hidden && !stopped) { void start(); } };
    document.addEventListener("visibilitychange", onVisibility);
    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deadline]);

  if (!display) return null;
  return (
    <span className={`live-countdown${display.final ? " final" : ""}${className ? ` ${className}` : ""}`} dir="ltr" aria-live="off">
      {display.text}
    </span>
  );
}
