import React from "react";

// ── SPRINT 4 (A1) — recognizable navigation-app glyphs ──────────────────────
// Monochrome (currentColor) so they sit inside the ghost buttons like the share
// icons do; the text label next to them carries the actual app name.

const P = (props: { d: string; viewBox?: string; size?: number }) => (
  <svg viewBox={props.viewBox || "0 0 24 24"} width={props.size || 18} height={props.size || 18} fill="currentColor" aria-hidden="true" focusable="false">
    <path d={props.d} />
  </svg>
);

/** Google Maps: the classic map pin. */
export const GoogleMapsIcon = () => (
  <P d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
);

/** Waze: the speech-bubble face. */
export const WazeIcon = () => (
  <P d="M12.5 2C7.81 2 4 5.58 4 10c0 .55.06 1.09.18 1.61C4.06 12.1 3 12.5 3 13.5c0 1.1 1.3 1.5 2.36 1.5.9 2 2.66 3.44 4.86 4.14A2 2 0 0012 22a2 2 0 001.86-1.27C17.4 20 21 16.19 21 11.5 21 6.25 17.19 2 12.5 2zM9.5 8a1 1 0 110 2 1 1 0 010-2zm6 0a1 1 0 110 2 1 1 0 010-2zm-6.36 5.02h6.72c-.6 1.8-1.87 2.98-3.36 2.98s-2.76-1.18-3.36-2.98z" />
);
