// SPRINT 4 (A6) — intent-sensitive admin buyer search.
//
// Owner reproduction: typing the Hebrew letter "ש" returned a buyer whose
// DISPLAYED name had no ש, because the roster searched four hidden fields at
// once and then displayed a different aggregate value than the one that
// matched. The rule is now literal and explainable:
//
//   letters / Hebrew text  → the buyer NAME only
//   digits                 → phone (and the buyer id when it is a phone)
//   something@something    → e-mail
//   CT-1234-5678           → the human order code
//   a UUID / long hex id   → technical ids only when the input really is one
//
// and every hit says WHY it matched ("התאמה בשם" …). The predicate is applied
// to the value the admin will SEE for that buyer, so a name query can never
// surface a displayed name that does not contain the query.
//
// Pure module: no DOM, no DB — the SQL fragments are built here and bound by
// the route, so the semantics are unit-testable.

export type BuyerSearchIntent = "empty" | "name" | "phone" | "email" | "order_code" | "id";

export interface BuyerSearchPlan {
  intent: BuyerSearchIntent;
  raw: string;
  /** what the SQL actually compares against (normalized) */
  normalized: string;
  /** name intent: whitespace-separated tokens, every one must match the displayed name */
  tokens: string[];
  label_he: string;
  match_label_he: string;
}

export const BUYER_SEARCH_INTENT_COPY: Record<BuyerSearchIntent, string> = {
  empty: "",
  name: "חיפוש לפי שם",
  phone: "חיפוש לפי טלפון",
  email: "חיפוש לפי אימייל",
  order_code: "חיפוש לפי קוד הזמנה",
  id: "חיפוש לפי מזהה טכני"
};

export const BUYER_MATCH_COPY: Record<Exclude<BuyerSearchIntent, "empty">, string> = {
  name: "התאמה בשם",
  phone: "התאמה בטלפון",
  email: "התאמה במייל",
  order_code: "התאמה בקוד הזמנה",
  id: "התאמה במזהה"
};

/** Hebrew points + cantillation marks (U+0591–U+05C7) — deleted before comparing names. */
export const HEBREW_MARKS: string = (() => {
  let out = "";
  for (let code = 0x0591; code <= 0x05c7; code += 1) out += String.fromCharCode(code);
  return out;
})();

const HEBREW_FINALS = "ךםןףץ";
const HEBREW_REGULAR = "כמנפצ";

/** NFKC, trim, collapse whitespace, strip Hebrew marks, fold final letters, lowercase Latin. */
export function normalizeSearchText(raw: unknown): string {
  let text = String(raw ?? "");
  try { text = text.normalize("NFKC"); } catch { /* environments without ICU keep the raw text */ }
  // control characters, DEL and bidi marks become plain spaces (escaped so git never sees a raw control byte)
  text = text.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, " ").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of text) {
    if (HEBREW_MARKS.includes(ch)) continue;
    const finalIndex = HEBREW_FINALS.indexOf(ch);
    out += finalIndex >= 0 ? HEBREW_REGULAR[finalIndex]! : ch;
  }
  return out.toLowerCase();
}

/** Escape LIKE metacharacters so the query is literal (bound with ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function classifyBuyerSearch(rawInput: unknown): BuyerSearchPlan {
  const raw = String(rawInput ?? "").trim().slice(0, 120);
  const done = (intent: BuyerSearchIntent, normalized: string, tokens: string[] = []): BuyerSearchPlan => ({
    intent, raw, normalized, tokens,
    label_he: BUYER_SEARCH_INTENT_COPY[intent],
    match_label_he: intent === "empty" ? "" : BUYER_MATCH_COPY[intent]
  });
  if (!raw) return done("empty", "");
  if (raw.includes("@")) return done("email", normalizeSearchText(raw).replace(/\s+/g, ""));
  const code = raw.match(/^\s*ct[\s-]*(\d{4})[\s-]*(\d{4})\s*$/i);
  if (code) return done("order_code", `CT-${code[1]}-${code[2]}`);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) || /^[0-9a-f]{16,}$/i.test(raw)) {
    return done("id", raw.toLowerCase());
  }
  const digitsOnly = raw.replace(/[\s\-+().]/g, "");
  if (/^\d+$/.test(digitsOnly)) {
    if (digitsOnly.length >= 2) return done("phone", digitsOnly);
    return done("phone", digitsOnly); // a single digit is still a phone prefix — never a name
  }
  const normalized = normalizeSearchText(raw);
  const tokens = normalized.split(" ").filter(Boolean);
  return done("name", normalized, tokens);
}

/**
 * SQL for the displayed-value predicate. `alias` is the row alias whose
 * buyer_id / buyer_name / buyer_phone / buyer_email are the DISPLAYED values.
 * Parameters are appended starting at `firstParam` and returned in order.
 */
export function buyerSearchPredicateSql(plan: BuyerSearchPlan, alias: string, firstParam: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const next = (value: unknown) => { params.push(value); return `$${firstParam + params.length - 1}`; };
  const marks = () => next(HEBREW_MARKS);
  const normName = (marksParam: string) =>
    `lower(translate(translate(COALESCE(${alias}.buyer_name, ''), ${marksParam}, ''), '${HEBREW_FINALS}', '${HEBREW_REGULAR}'))`;
  switch (plan.intent) {
    case "empty":
      return { sql: "TRUE", params };
    case "name": {
      const marksParam = marks();
      const clauses = plan.tokens.map((token) => `${normName(marksParam)} LIKE ${next(`%${escapeLike(token)}%`)} ESCAPE '\\'`);
      return { sql: clauses.length ? `(${clauses.join(" AND ")})` : "FALSE", params };
    }
    case "phone":
      return { sql: `regexp_replace(COALESCE(${alias}.buyer_phone, ${alias}.buyer_id, ''), '\\D', '', 'g') LIKE ${next(`%${escapeLike(plan.normalized)}%`)} ESCAPE '\\'`, params };
    case "email":
      return { sql: `lower(COALESCE(${alias}.buyer_email, '')) LIKE ${next(`%${escapeLike(plan.normalized)}%`)} ESCAPE '\\'`, params };
    case "order_code":
      return {
        sql: `EXISTS (SELECT 1 FROM siton.participants px JOIN siton.fulfillment_units fu ON fu.participant_id = px.participant_id
                WHERE px.buyer_id = ${alias}.buyer_id AND fu.metadata_jsonb->>'order_code' = ${next(plan.normalized)})`,
        params
      };
    case "id": {
      const idParam = next(plan.normalized);
      return {
        sql: `(lower(${alias}.buyer_id) = ${idParam} OR EXISTS (SELECT 1 FROM siton.participants px WHERE px.buyer_id = ${alias}.buyer_id AND px.participant_id::text = ${idParam}))`,
        params
      };
    }
  }
}

/** ORDER BY fragment that surfaces the participation name that MATCHES first (name intent), so display = match. */
export function buyerNameRankSql(plan: BuyerSearchPlan, alias: string, firstParam: number): { sql: string; params: unknown[] } {
  if (plan.intent !== "name" || plan.tokens.length === 0) return { sql: "", params: [] };
  const params: unknown[] = [HEBREW_MARKS, `%${escapeLike(plan.tokens[0]!)}%`];
  const marksParam = `$${firstParam}`;
  const likeParam = `$${firstParam + 1}`;
  return {
    sql: `(lower(translate(translate(COALESCE(${alias}.buyer_name, ''), ${marksParam}, ''), '${HEBREW_FINALS}', '${HEBREW_REGULAR}')) LIKE ${likeParam} ESCAPE '\\') DESC, `,
    params
  };
}
