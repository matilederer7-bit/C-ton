// ── "How it works" infographic — the DATA CONTRACT ──────────────────────────
//
// The home page carries an infographic with two tracks (buyers / sellers),
// four numbered steps each and one summary line each. Its words AND its icons
// are editable in the content editor; this module is the one place that knows
// how that content is shaped:
//
//   * `HowItWorksContent` — what the React component renders (typed, nested);
//   * the FLAT CMS field names — how the same content is stored in the
//     `how_it_works` block of the home page (one string per field, the shape
//     the template library validates and the editor generates a form from);
//   * the two conversions between them, each total: a missing or unknown value
//     falls back to the canonical default, so the component can never render
//     an empty step or an unknown icon.
//
// PURE: no React, no DOM, no database. Imported by the template library, the
// backend validator, the renderer and the tests.
import { HOW_IT_WORKS_DEFAULT_ICON, isHowItWorksIconKey, type HowItWorksIconKey } from "./howItWorksIcons.js";

export interface HowItWorksStep { text: string; icon: HowItWorksIconKey }
export interface HowItWorksTrack { title: string; steps: HowItWorksStep[]; summary: HowItWorksStep }
export interface HowItWorksContent { title: string; buyers: HowItWorksTrack; sellers: HowItWorksTrack }

export type HowItWorksAudience = "buyers" | "sellers";
export const HOW_IT_WORKS_AUDIENCES: readonly HowItWorksAudience[] = ["buyers", "sellers"];
export const HOW_IT_WORKS_STEP_COUNT = 4;
export const HOW_IT_WORKS_STEP_NUMBERS = [1, 2, 3, 4] as const;

/** The id of the infographic block on the home page (locked: always present, right after the hero). */
export const HOW_IT_WORKS_BLOCK_ID = "how";

// ── Flat field names ────────────────────────────────────────────────────────
const prefix = (audience: HowItWorksAudience) => (audience === "buyers" ? "buyer" : "seller");
export const howItWorksField = {
  title: "title",
  trackTitle: (audience: HowItWorksAudience) => `${audience}_title`,
  stepText: (audience: HowItWorksAudience, n: number) => `${prefix(audience)}_step_${n}`,
  stepIcon: (audience: HowItWorksAudience, n: number) => `${prefix(audience)}_icon_${n}`,
  summaryText: (audience: HowItWorksAudience) => `${audience}_summary`,
  summaryIcon: (audience: HowItWorksAudience) => `${audience}_summary_icon`
} as const;

/** Every field name of the block, in the order the editor shows them. */
export function howItWorksFieldNames(): string[] {
  const names: string[] = [howItWorksField.title];
  for (const audience of HOW_IT_WORKS_AUDIENCES) {
    names.push(howItWorksField.trackTitle(audience));
    for (const n of HOW_IT_WORKS_STEP_NUMBERS) names.push(howItWorksField.stepText(audience, n), howItWorksField.stepIcon(audience, n));
    names.push(howItWorksField.summaryText(audience), howItWorksField.summaryIcon(audience));
  }
  return names;
}

/** The icon fields (structural: the same key in every language). */
export function howItWorksIconFieldNames(): string[] {
  return howItWorksFieldNames().filter((name) => /_icon(_\d)?$/.test(name));
}

// ── Conversions ─────────────────────────────────────────────────────────────

/** The stored (flat) shape of a content object — words and icons. */
export function howItWorksFieldsOf(content: HowItWorksContent): Record<string, string> {
  const out: Record<string, string> = { [howItWorksField.title]: content.title };
  for (const audience of HOW_IT_WORKS_AUDIENCES) {
    const track = content[audience];
    out[howItWorksField.trackTitle(audience)] = track.title;
    HOW_IT_WORKS_STEP_NUMBERS.forEach((n, i) => {
      const step = track.steps[i];
      out[howItWorksField.stepText(audience, n)] = step?.text ?? "";
      out[howItWorksField.stepIcon(audience, n)] = step?.icon ?? HOW_IT_WORKS_DEFAULT_ICON;
    });
    out[howItWorksField.summaryText(audience)] = track.summary.text;
    out[howItWorksField.summaryIcon(audience)] = track.summary.icon;
  }
  return out;
}

/** The English sibling of the stored shape: words only (icons are structural and live on the Hebrew side). */
export function howItWorksEnglishFieldsOf(content: HowItWorksContent): Record<string, string> {
  const fields = howItWorksFieldsOf(content);
  const icons = new Set(howItWorksIconFieldNames());
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !icons.has(name)));
}

/**
 * The renderable content of a block's (localized) fields. TOTAL: a blank word
 * or an unknown icon key falls back to the canonical default for that slot, so
 * "nothing saved" and "something broken" both render the complete infographic.
 */
export function howItWorksContentOf(fields: Record<string, string> | null | undefined, fallback: HowItWorksContent): HowItWorksContent {
  const f = fields ?? {};
  const word = (name: string, def: string): string => {
    const value = f[name];
    return typeof value === "string" && value.trim() ? value : def;
  };
  const icon = (name: string, def: HowItWorksIconKey): HowItWorksIconKey => {
    const value = f[name];
    return isHowItWorksIconKey(value) ? value : def;
  };
  const track = (audience: HowItWorksAudience): HowItWorksTrack => {
    const base = fallback[audience];
    return {
      title: word(howItWorksField.trackTitle(audience), base.title),
      steps: HOW_IT_WORKS_STEP_NUMBERS.map((n, i) => {
        const def = base.steps[i] ?? { text: "", icon: HOW_IT_WORKS_DEFAULT_ICON };
        return { text: word(howItWorksField.stepText(audience, n), def.text), icon: icon(howItWorksField.stepIcon(audience, n), def.icon) };
      }),
      summary: { text: word(howItWorksField.summaryText(audience), base.summary.text), icon: icon(howItWorksField.summaryIcon(audience), base.summary.icon) }
    };
  };
  return { title: word(howItWorksField.title, fallback.title), buyers: track("buyers"), sellers: track("sellers") };
}
