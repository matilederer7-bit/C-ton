// SPRINT 4 (A5) — TRUE back/forward scroll restoration for the hash router.
//
// Owner scenario: the buyer is deep in a long deal page, opens Support, presses
// Back — and must land EXACTLY where they were, not at the top. Forward must
// restore its own position too. A deliberate navigation to a NEW page still
// starts at the top.
//
// How it works (per HISTORY ENTRY, not per route string):
//   • every history entry gets a private key stamped into `history.state`
//     (`replaceState` — no extra entries, no URL change);
//   • the scroll position is remembered per key while the user scrolls and
//     again the instant a navigation starts;
//   • a hash change whose target entry already carries a key is a traversal
//     (browser Back / Forward / Android back) → its position is restored;
//     an entry without a key is brand new → top of page;
//   • restoration waits for the asynchronous page render: it re-tries on
//     animation frames until the document is tall enough to reach the target
//     (or a short budget expires), and scrolls WITHOUT smooth-scrolling so
//     there is no visible glide.
//
// The core is DOM-free (every browser touch goes through `ScrollDeps`) so the
// state machine is unit-testable in node; `installScrollRestoration` binds it
// to the real window.

export interface ScrollDeps {
  readState(): unknown;
  replaceState(state: Record<string, unknown>): void;
  scrollY(): number;
  scrollTo(y: number): void;
  scrollHeight(): number;
  innerHeight(): number;
  now(): number;
  requestFrame(cb: () => void): void;
  readStore(): string | null;
  writeStore(value: string): void;
  newKey(): string;
}

export const SCROLL_STATE_FIELD = "__siton_scroll_key";
export const SCROLL_STORE_KEY = "siton_scroll_positions_v1";
export const SCROLL_RESTORE_BUDGET_MS = 3000;
/** frames the restored position must hold (document stable, user idle) before the restore is considered settled */
export const SCROLL_SETTLE_FRAMES = 12;
export const SCROLL_MEMORY_LIMIT = 60;

export type NavigationKind = "new" | "traverse" | "reload";

export interface NavigationPlan {
  kind: NavigationKind;
  key: string;
  target: number;
}

export function readScrollKey(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[SCROLL_STATE_FIELD];
  return typeof value === "string" && value ? value : null;
}

export function parsePositions(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(value);
      if (typeof key === "string" && key && Number.isFinite(n) && n >= 0) out[key] = Math.round(n);
    }
    return out;
  } catch {
    return {};
  }
}

/** Keep the map small: drop the oldest keys once the limit is exceeded. */
export function trimPositions(positions: Record<string, number>, order: string[], limit = SCROLL_MEMORY_LIMIT): void {
  while (order.length > limit) {
    const oldest = order.shift();
    if (oldest !== undefined) delete positions[oldest];
  }
}

export class ScrollMemory {
  private positions: Record<string, number>;
  private order: string[];
  private currentKey: string | null = null;
  private restoreToken = 0;
  /** a restore that has not reached its target yet — the saved position must not be overwritten meanwhile */
  private pending: { key: string; target: number } | null = null;

  constructor(private readonly deps: ScrollDeps) {
    this.positions = parsePositions(deps.readStore());
    this.order = Object.keys(this.positions);
  }

  /** The key of the entry the document is currently showing (null before boot). */
  key(): string | null { return this.currentKey; }

  savedPosition(key: string): number | null {
    return Object.prototype.hasOwnProperty.call(this.positions, key) ? this.positions[key]! : null;
  }

  /** Called once when the app boots: adopt the entry's key (reload / bfcache) or stamp a fresh one. */
  boot(): NavigationPlan {
    const existing = readScrollKey(this.deps.readState());
    if (existing) {
      this.currentKey = existing;
      const saved = this.savedPosition(existing);
      if (saved !== null && saved > 0) {
        this.restore(saved);
        return { kind: "reload", key: existing, target: saved };
      }
      return { kind: "reload", key: existing, target: 0 };
    }
    const key = this.stampFreshKey();
    return { kind: "new", key, target: 0 };
  }

  /** Remember where the CURRENT entry is scrolled to (scroll listener + navigation start). */
  remember(): void {
    if (!this.currentKey) return;
    // while a restore is still waiting for the page to grow, the live scrollY is
    // the loader's offset, not the user's position — keep the target instead
    if (this.pending && this.pending.key === this.currentKey) return;
    this.set(this.currentKey, this.deps.scrollY());
  }

  /** Explicit input, unlike browser scroll anchoring, gives control to the user. */
  userInteracted(): void {
    this.restoreToken += 1;
    this.pending = null;
    this.remember();
  }

  /**
   * The URL just changed (hashchange). Decide whether this is a traversal to a
   * known entry (restore) or a brand-new entry (top), and act on it.
   * `previousScrollY` is the position the OLD document was at when the change
   * fired — hashchange runs after the URL flipped, but before React re-renders,
   * so `scrollY` still belongs to the page the user left.
   */
  navigated(previousScrollY: number = this.deps.scrollY()): NavigationPlan {
    if (this.currentKey && !(this.pending && this.pending.key === this.currentKey)) this.set(this.currentKey, previousScrollY);
    const key = readScrollKey(this.deps.readState());
    if (key && key !== this.currentKey) {
      this.currentKey = key;
      const target = this.savedPosition(key) ?? 0;
      this.restore(target);
      return { kind: "traverse", key, target };
    }
    if (key && key === this.currentKey) {
      // same entry, same key (e.g. a replaceState by someone else) — nothing to restore
      return { kind: "traverse", key, target: previousScrollY };
    }
    const fresh = this.stampFreshKey();
    this.restore(0);
    return { kind: "new", key: fresh, target: 0 };
  }

  /** Scroll to `target` as soon as the document can reach it (async page render), within a budget. */
  restore(target: number): void {
    const token = ++this.restoreToken;
    const started = this.deps.now();
    const key = this.currentKey;
    this.pending = key ? { key, target } : null;
    let achieved = false;
    let clamped = false;
    let settledFrames = 0;
    // `pending` (which blocks remember()) is held ONLY while scrollY does not
    // reflect the user's position: before the target is reachable, and while
    // the new page's loader has clamped the document. In between, the user's
    // own scrolls are real and must be remembered.
    const block = () => { if (key) this.pending = { key, target }; };
    const unblock = () => { if (this.pending && this.pending.key === key) this.pending = null; };
    const attempt = () => {
      if (token !== this.restoreToken) return; // superseded by a newer navigation
      const reachable = Math.max(0, this.deps.scrollHeight() - this.deps.innerHeight());
      const elapsed = this.deps.now() - started;
      if (!achieved) {
        if (target <= reachable || elapsed >= SCROLL_RESTORE_BUDGET_MS) {
          this.deps.scrollTo(Math.min(target, reachable));
          achieved = true;
          if (target === 0 || elapsed >= SCROLL_RESTORE_BUDGET_MS) unblock();
          if (elapsed >= SCROLL_RESTORE_BUDGET_MS) return;
        }
        this.deps.requestFrame(attempt);
        return;
      }
      // HOLD phase: the hashchange fires while the OLD document is still on
      // screen, so a tall old page lets the scroll happen before the new page
      // replaces it with a short loader. The browser then clamps scrollY to the
      // loader's height; when the real content renders the page grows back and
      // nobody would put the user back at their position. Watch for exactly
      // that shrink → grow sequence within the budget and re-apply once.
      if (elapsed >= SCROLL_RESTORE_BUDGET_MS) { unblock(); return; }
      const y = this.deps.scrollY();
      if (reachable < target) {
        clamped = true;
        block();
        this.deps.requestFrame(attempt);
        return;
      }
      if (clamped && y < target) {
        this.deps.scrollTo(target);
        clamped = false;
        if (target === 0) unblock();
        settledFrames = 0;
        this.deps.requestFrame(attempt);
        return;
      }
      // Images, fonts and sticky controls can move the viewport after the
      // loader has gone. A changed scrollY alone is not evidence of user input.
      if (Math.abs(y - target) > 2) {
        if (target === 0) return;
        this.deps.scrollTo(target);
      }
      settledFrames += 1;
      if (target === 0 && settledFrames >= SCROLL_SETTLE_FRAMES) return;
      this.deps.requestFrame(attempt);
    };
    // scroll immediately (top / already-tall documents) and keep re-trying while the page grows
    attempt();
  }

  persist(): void {
    try { this.deps.writeStore(JSON.stringify(this.positions)); } catch { /* storage may be unavailable */ }
  }

  private set(key: string, y: number): void {
    const value = Math.max(0, Math.round(Number(y) || 0));
    if (!Object.prototype.hasOwnProperty.call(this.positions, key)) this.order.push(key);
    this.positions[key] = value;
    trimPositions(this.positions, this.order);
  }

  private stampFreshKey(): string {
    const key = this.deps.newKey();
    const state = this.deps.readState();
    const base = state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
    this.deps.replaceState({ ...base, [SCROLL_STATE_FIELD]: key });
    this.currentKey = key;
    this.set(key, 0);
    return key;
  }
}

export function browserScrollDeps(): ScrollDeps {
  const root = () => document.documentElement;
  let counter = 0;
  return {
    readState: () => window.history.state,
    replaceState: (state) => { try { window.history.replaceState(state, "", window.location.href); } catch { /* sandboxed history */ } },
    scrollY: () => window.scrollY || root().scrollTop || 0,
    scrollTo: (y) => {
      // never glide: the global `html { scroll-behavior: smooth }` would animate the restore
      const prev = root().style.scrollBehavior;
      root().style.scrollBehavior = "auto";
      try { window.scrollTo({ top: y, left: 0, behavior: "auto" }); } catch { window.scrollTo(0, y); }
      root().style.scrollBehavior = prev;
    },
    scrollHeight: () => Math.max(root().scrollHeight, document.body?.scrollHeight || 0),
    innerHeight: () => window.innerHeight,
    now: () => Date.now(),
    requestFrame: (cb) => { window.requestAnimationFrame(cb); },
    readStore: () => { try { return window.sessionStorage.getItem(SCROLL_STORE_KEY); } catch { return null; } },
    writeStore: (value) => { try { window.sessionStorage.setItem(SCROLL_STORE_KEY, value); } catch { /* private mode */ } },
    newKey: () => `${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  };
}

export interface ScrollRestorationHandle {
  memory: ScrollMemory;
  /** call from the hashchange handler, BEFORE the route state update */
  onHashChange(): NavigationPlan;
  dispose(): void;
}

let installed: ScrollRestorationHandle | null = null;

export function installScrollRestoration(deps: ScrollDeps = browserScrollDeps()): ScrollRestorationHandle {
  if (installed) return installed;
  if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
    try { window.history.scrollRestoration = "manual"; } catch { /* read-only in some embedders */ }
  }
  const memory = new ScrollMemory(deps);
  memory.boot();
  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => { frame = 0; memory.remember(); });
  };
  const onHide = () => { memory.remember(); memory.persist(); };
  const onUserInput = () => memory.userInteracted();
  const onKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) onUserInput();
  };
  window.addEventListener("wheel", onUserInput, { passive: true });
  window.addEventListener("touchstart", onUserInput, { passive: true });
  window.addEventListener("pointerdown", onUserInput, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pagehide", onHide);
  window.addEventListener("visibilitychange", onHide);
  installed = {
    memory,
    onHashChange: () => { const plan = memory.navigated(); memory.persist(); return plan; },
    dispose: () => {
      memory.userInteracted();
      window.removeEventListener("wheel", onUserInput);
      window.removeEventListener("touchstart", onUserInput);
      window.removeEventListener("pointerdown", onUserInput);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("visibilitychange", onHide);
      installed = null;
    }
  };
  return installed;
}
