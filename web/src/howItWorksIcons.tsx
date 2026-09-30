import React from "react";
import { HOW_IT_WORKS_DEFAULT_ICON, isHowItWorksIconKey, type HowItWorksIconKey } from "./content/howItWorksIcons";

// ── "How it works" infographic — the icon GLYPHS ────────────────────────────
// One clean monochrome line glyph per whitelisted key (currentColor, sized by
// CSS), in the same family as the share / navigation icons. The key is the
// only thing ever stored or received from the CMS; the markup lives here, so
// a persisted value can never inject anything — an unknown key draws the
// default glyph.

const GLYPHS: Record<HowItWorksIconKey, React.ReactNode> = {
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.4-3.4" /></>,
  cart: <><path d="M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6" /><circle cx="9.5" cy="20.5" r="1.2" /><circle cx="17.5" cy="20.5" r="1.2" /></>,
  card_hold: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h4" /><rect x="14.5" y="13.5" width="5" height="3.5" rx="1" /><path d="M15.5 13.5v-1a1.5 1.5 0 0 1 3 0v1" /></>,
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  plus_circle: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M9 15.5l2 2 4-4" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  shield_check: <><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
  coins_check: <><ellipse cx="10" cy="7" rx="7" ry="3" /><path d="M3 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7" /><path d="M3 12v5c0 1.7 3.1 3 7 3 .9 0 1.8-.1 2.6-.2" /><circle cx="18" cy="18" r="4" /><path d="M16.3 18l1.2 1.2 2.3-2.4" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18 13.5a6 6 0 0 1 3.5 6.5" /></>,
  truck: <><rect x="1" y="6" width="13" height="10" rx="1" /><path d="M14 10h4l3 3v3h-7" /><circle cx="5.5" cy="19" r="2" /><circle cx="17.5" cy="19" r="2" /></>,
  tag: <><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  bell: <><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
  check_circle: <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5.5" /></>
};

/** The glyph for a whitelisted key; any other value draws the default glyph. */
export function HowItWorksIcon({ icon, size }: { icon: string; size?: number }) {
  const key: HowItWorksIconKey = isHowItWorksIconKey(icon) ? icon : HOW_IT_WORKS_DEFAULT_ICON;
  return (
    <svg viewBox="0 0 24 24" width={size || 24} height={size || 24} fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon={key}>
      {GLYPHS[key]}
    </svg>
  );
}
