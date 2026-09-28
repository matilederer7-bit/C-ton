// ── English sibling of howItWorks.he.ts — the same infographic, same claims ──
// Icons are structural (the same key in both languages) and are therefore
// NOT part of the English sibling; only the words are.
import type { HowItWorksContent } from "./howItWorks.js";

export const HOW_IT_WORKS_EN: HowItWorksContent = {
  title: "How does it work?",
  buyers: {
    title: "For buyers",
    steps: [
      { text: "Find a deal", icon: "search" },
      { text: "Choose quantity and delivery", icon: "cart" },
      { text: "Only an authorization is held", icon: "card_hold" },
      { text: "Follow it live", icon: "pulse" }
    ],
    summary: { text: "No charge until the deal closes successfully", icon: "shield_check" }
  },
  sellers: {
    title: "For sellers",
    steps: [
      { text: "Open a deal", icon: "plus_circle" },
      { text: "Set quantity and date", icon: "calendar" },
      { text: "Share the link", icon: "link" },
      { text: "Track and manage", icon: "dashboard" }
    ],
    summary: { text: "The charge happens only when the deal closes successfully", icon: "coins_check" }
  }
};
