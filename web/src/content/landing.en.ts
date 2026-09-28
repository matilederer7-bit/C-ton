// ── Canonical ENGLISH content for the public landing page ───────────────────
// The English sibling of `landing.he.ts`, section for section and key for key.
// It is a faithful rendering of the same product claims, not a looser rewrite:
// every sentence about money says exactly what the Hebrew says — an
// authorization is placed, and nothing is charged unless the group reaches its
// target. A section the owner has not written yet stays EMPTY in both files,
// so an unwritten section is hidden rather than invented.
import type { LandingFaqItem, LandingSectionContent } from "./landing.he.js";

export const LANDING_EN = {
  hero: {
    title: "Sell as a group. Close in volume.",
    sub: "C-ton (Siton) is a group-buying platform: a seller opens a deal with a unit target, buyers join and share it, and the charge happens only if the group reaches the target. If it doesn't — nobody pays.",
    note: "Got a link to a deal? Open it directly — joining does not require an account."
  },

  buyerEntry: {
    title: "Buying? Here's how you join",
    body: "Open the deal link you got from the seller or from a friend, choose a quantity and confirm — no account needed. Joining places a card authorization only; the charge happens only if the group reaches its target.",
    cta: "See open deals"
  },
  pilot: {
    note: "Closed pilot — no real charges are being made at this stage."
  },

  howItWorks: {
    title: "How it works",
    steps: [
      { title: "Open a deal", body: "A product, a voucher or a ticket — set a price per unit, a minimum quantity and a deadline. Under 5 minutes." },
      { title: "The group joins", body: "Share one link. Everyone who joins gets a personal link of their own — and the sharing does the work for you." },
      { title: "Reach the target — close", body: "Until the target is reached only a card authorization is held. Group reached the target? The charge goes through and the deal goes ahead." }
    ]
  },

  // OWNER copy pending in Hebrew as well — hidden while empty in both languages.
  whyGroupBuying: { title: "Why group buying pays off", body: "" } as LandingSectionContent,

  forBuyers: {
    title: "For buyers",
    body: "You join a deal through a link, choose a quantity and a delivery method — and at that point only a card authorization is placed, with no charge. From the moment you join you have a personal tracking screen with the live state of the deal, and a personal link of your own: everyone who joins through you is credited to you."
  } as LandingSectionContent,

  forSellers: {
    title: "For sellers",
    body: "You open a group deal with a target and a deadline, get a link to share, and follow the joins in a full management dashboard — how many joined, how many units are left to the target, and what is happening with the money. The charge happens only when the deal closes successfully."
  } as LandingSectionContent,

  trust: {
    title: "What happens if the target isn't reached?",
    body: "Nothing — and that is exactly the point. Until the deal closes, only a card authorization is held and no charge is made. If the deal does not reach its target by the deadline, the authorization on every participant's card is released automatically and nobody pays."
  } as LandingSectionContent,

  // OWNER copy pending — hidden while empty (ABOUT_CONTENT_PENDING_OWNER).
  about: { title: "About C-ton", body: "" } as LandingSectionContent,

  faq: {
    title: "Frequently asked questions",
    items: [
      { q: "Am I paying when I join a deal?", a: "No. Joining places a card authorization only. The charge happens only if the deal reaches its target and closes successfully." },
      { q: "What happens if the deal doesn't reach its target?", a: "The authorization is released automatically and nobody is charged." },
      { q: "Do I need an account to join a deal?", a: "No. You join straight through the deal link. An account is needed only for sellers." },
      { q: "How do I follow a deal I joined?", a: "Right after you join you get a link to a personal tracking screen that shows the live state of the deal." },
      { q: "What is my personal link?", a: "Everyone who joins gets a share link of their own. When friends join through your link, the join is credited to you and you can see your effect on the deal." },
      { q: "How do I open a deal as a seller?", a: "Sign up free in the sellers area, fill in the deal details — price, minimum quantity and deadline — and publish. Creating a deal takes under 5 minutes." }
    ] as LandingFaqItem[]
  }
};
