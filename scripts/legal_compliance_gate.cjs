// Legal / lean-compliance gate.
//
// Proves the lean legal posture (no age gate, no forced terms popup, no
// marketing opt-in, no default deal-approval queue, no free manual refund
// surface, distributor attribution-only, buyer disclosure copy present,
// required policy documents present) against the product code.
//
// Hardened from the original text scanner:
//   - The raw-card term check is delegated to the shared SEMANTIC scanner
//     (scripts/lib/raw_card_terms.cjs via compliance_payment_scan.run). A
//     legal sentence stating that CVV is NOT stored is no longer a finding.
//   - Several regexes used `[^\\n]` (a JS regex class meaning "not a backslash
//     or the letter n", which spans lines) where `[^\n]` was intended. Fixed.
//   - The affiliate API block extraction fails explicitly when the route is
//     not found instead of slicing garbage.
//   - The seller KYC check is now an intentional, narrower invariant: a KYC
//     approval requirement must never apply outside production-like
//     environments (lean pilot/demo onboarding). The production-only approval
//     gate that exists in src/app.ts is reported as a WARNING carrying an
//     owner decision, not silently accepted and not falsely failed.
// Controls live in tests/release_tools/legal_gate.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const ast = require("./lib/ts_ast.cjs");
const paymentScan = require("./compliance_payment_scan.cjs");

const ts = ast.ts;
const root = process.cwd();
const requiredDocs = [
  "docs/ACCESSIBILITY_COMPLIANCE.md",
  "docs/PRIVACY_DATA_MAP.md",
  "docs/PRIVACY_POLICY_HE.md",
  "docs/INFORMATION_SECURITY_POLICY.md",
  "docs/PAYMENT_SECURITY_AND_PCI_SCOPE.md",
  "docs/BUYER_TERMS_HE.md",
  "docs/CANCELLATION_REFUND_POLICY_HE.md",
  "docs/SELLER_TERMS_HE.md",
  "docs/SELLER_KYC_POLICY.md",
  "docs/DISTRIBUTOR_TERMS_HE.md",
  "docs/ADMIN_LEGAL_OPS_POLICY.md"
];

const failures = [];
const warnings = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const has = (text, pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern));
const norm = (text) => String(text).replace(/\s+/g, " ");

for (const doc of requiredDocs) if (!exists(doc)) failures.push("missing required document: " + doc);

const app = read("frontend/app.js");
const runtime = read("src/frontend_runtime.ts") + "\n" + read("src/admin_mission_control_routes.ts") + "\n" + read("src/support_routes.ts") + "\n" + read("src/seller_fulfillment_routes.ts") + "\n" + read("src/admin_control_center_routes.ts") + "\n" + read("src/admin_growth_routes.ts") + "\n" + read("src/admin_demo_readiness_routes.ts"); // Mission Control, support, seller fulfillment, admin control-center (R6), admin growth and admin demo-readiness routes moved out of frontend_runtime.ts (Lean Refactor); they stay in the product scan
// The server-rendered legal shell moved out of frontend_runtime.ts (Lean Refactor); it stays in the product surface.
const legalShell = read("src/legal_html.ts");
const server = read("src/app.ts") + "\n" + read("src/http_security_headers.ts") + "\n" + read("src/operational_health_routes.ts") + "\n" + read("src/seller_deal_image_routes.ts"); // extracted app route modules stay in the server scan
const buyerTerms = norm(read("docs/BUYER_TERMS_HE.md"));
const privacy = norm(read("docs/PRIVACY_POLICY_HE.md"));
const sellerTerms = norm(read("docs/SELLER_TERMS_HE.md"));
const sellerKyc = norm(read("docs/SELLER_KYC_POLICY.md"));
const refundPolicy = norm(read("docs/CANCELLATION_REFUND_POLICY_HE.md"));
const distributionTerms = norm(read("docs/DISTRIBUTOR_TERMS_HE.md"));
const legalPages = norm(read("src/legal_pages.ts"));
const combinedProduct = app + "\n" + runtime + "\n" + legalShell + "\n" + server;
const combinedProductNoComments = ast.stripComments(app, "app.js") + "\n" + ast.stripComments(runtime, "frontend_runtime.ts") + "\n" + ast.stripComments(legalShell, "legal_html.ts") + "\n" + ast.stripComments(server, "app.ts");

for (const forbidden of ["שלם עכשיו", "התשלום בוצע", "רכישה הושלמה"]) {
  if (app.includes(forbidden)) failures.push("forbidden auth-hold copy appears in frontend: " + forbidden);
}

for (const forbidden of [/age[_-]?gate/i, /בן 18/, /18 ומעלה/, /אני בן.*18/, /גיל 18/]) {
  if (has(combinedProduct, forbidden) || has(buyerTerms + "\n" + privacy + "\n" + sellerTerms, forbidden)) failures.push("age gate / 18+ language found: " + forbidden);
}

if (/buyer_terms_accepted/.test(app + "\n" + server) || /buyer_terms_required/.test(server)) failures.push("forced buyer terms consent is still enforced in product flow");

if (/terms[^\n]{0,80}(modal|popup)|modal[^\n]{0,80}terms|popup[^\n]{0,80}terms/i.test(combinedProductNoComments)) failures.push("forced terms popup/modal pattern found");

for (const link of ["/app/terms", "/app/privacy", "/app/refunds", "/app/accessibility", "/app/seller-terms"]) {
  if (!app.includes(link) && !runtime.includes(link)) failures.push("missing policy link: " + link);
}

// Distribution-link terms keep the legacy /legal/affiliates compatibility path,
// but the product must not reintroduce a distributor/affiliate business role.
{
  if (!/slug:\s*"affiliates"/.test(legalPages)) failures.push("distribution-link legal page compatibility slug \"affiliates\" is missing from src/legal_pages.ts");
  if (!/title:\s*"תנאי לינקי הפצה"/.test(legalPages)) failures.push("distribution-link legal page must be titled תנאי לינקי הפצה");
  if (/title:\s*"תנאי מפיצים"/.test(legalPages)) failures.push("obsolete distributor-role title returned to the legal page");
  if (!/אין בסיטון משתמש או תפקיד עסקי בשם "מפיץ"/.test(legalPages)) failures.push("legal page must explicitly state that Siton has no distributor business role");
  if (!app.includes("/legal/affiliates")) failures.push("missing compatibility policy link: /legal/affiliates");
}

for (const requiredCopy of ["מחיר ליחידה", "כמות", "משלוח", "סך הכול", "תפיסת מסגרת בלבד"]) {
  if (!app.includes(requiredCopy)) failures.push("missing buyer price/auth-hold disclosure copy: " + requiredCopy);
}

if (!/90%/.test(app) || !/90%/.test(buyerTerms) || !/90%/.test(sellerTerms)) failures.push("90% rule is missing from buyer/seller surfaces");

if (/manual refund|refund button|free refund|כפתור החזר חופשי|החזר ידני חופשי/i.test(combinedProductNoComments) && !/אין כפתור החזר חופשי/.test(refundPolicy)) failures.push("manual free refund surface found");

if (/deal[^\n]{0,80}(approval queue|approval flow|required approval)|approval[^\n]{0,80}(every deal|all deals)/i.test(combinedProductNoComments)) failures.push("deal approval flow appears to be required");

// Seller KYC: lean onboarding. An approval requirement must never apply outside
// production-like environments. Each refusal site is located by AST and must be
// nested under a condition that references the production-like predicate.
{
  const serverFile = ast.parse(path.join(root, "src/app.ts"), server);
  const refusalSites = ast.collect(serverFile, (node) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "code"
    && ast.stringLiteralValue(node.right) === "seller_kyc_not_approved");
  for (const site of refusalSites) {
    let guarded = false;
    let cursor = site.parent;
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isIfStatement(cursor) && /isProductionLike|IS_PRODUCTION_LIKE|productionLike/.test(cursor.expression.getText(serverFile))) { guarded = true; break; }
      if (ts.isFunctionLike(cursor)) break;
      cursor = cursor.parent;
    }
    const pos = serverFile.getLineAndCharacterOfPosition(site.getStart(serverFile));
    if (!guarded) failures.push("seller KYC approval refusal at src/app.ts:" + (pos.line + 1) + " is not restricted to production-like environments (lean onboarding requires no KYC gate in demo/pilot)");
    else warnings.push("OWNER_DECISION seller publish requires verification_status=approved in production-like environments (src/app.ts:" + (pos.line + 1) + "). Lean onboarding holds outside production; confirm the production approval step is intended before launch.");
  }
  if (/cannot publish.*basic approval/i.test(sellerKyc) || /manual admin approval requirement for every seller/i.test(server)) failures.push("heavy seller KYC/admin approval gate wording is present");
}

for (const forbidden of [/marketing_consent/i, /newsletter/i, /marketing opt[-_ ]?in/i, /שיווקי[^\n]{0,40}checkbox/, /דיוור עסקאות אחרות/]) {
  if (has(combinedProductNoComments, forbidden)) failures.push("marketing opt-in/product marketing surface found: " + forbidden);
}
if (!privacy.includes("C-ton אינה שולחת הודעות שיווקיות") || !privacy.includes("הודעות תפעוליות")) failures.push("privacy policy does not state no marketing and operational messages only");
if (!buyerTerms.includes("C-ton אינה שולחת הודעות שיווקיות")) failures.push("buyer terms do not state no marketing messages");

// Raw cardholder data: shared semantic scanner (identifiers, keys, columns,
// form fields), never prose.
{
  const scan = paymentScan.run();
  for (const hit of scan.findings) failures.push(hit.rel + ":" + hit.line + ": " + hit.kind + " \"" + hit.identifier + "\" matches forbidden raw payment term " + hit.term);
  for (const entry of scan.unusedAllowListEntries) failures.push("stale raw-card allow-list entry: " + entry.file + " " + entry.identifier);
}

const distributionModule = runtime + "\n" + app;
for (const term of ["commission", "balance", "withdrawal", "affiliate_fee", "distributor_commission"]) {
  const re = new RegExp("affiliate[^\\n]{0,80}" + term + "|distributor[^\\n]{0,80}" + term, "i");
  if (re.test(distributionModule)) failures.push("distribution-link module contains forbidden external-money term: " + term);
}
// The distribution-link terms posture (no role / aggregate-only / no
// commission) is pinned word for word in the distribution-link block below.

{
  // The only remaining affiliate route is the anonymous visit recorder. It
  // measures clicks/entries by source code and must never touch buyer PII.
  const routeStart = runtime.indexOf('app.post("/api/affiliate/links/visit"');
  if (routeStart < 0) failures.push("legacy affiliate visit route not found in src/frontend_runtime.ts (cannot verify distribution-link PII boundary)");
  else {
    const routeEnd = runtime.indexOf("\n  });\n", routeStart);
    const affiliateBlock = runtime.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 4000);
    for (const pii of ["buyer_id", "buyer_phone", "buyer_email", "buyer_name", "delivery_address"]) {
      if (affiliateBlock.includes(pii)) failures.push("buyer PII appears in distribution-link API block: " + pii);
    }
  }
}

// ── Distribution-link model and the fixed 8% fee (owner rules) ─────────────
// Siton has no distributor/affiliate business role; it never calculates,
// accrues, collects or pays an external party for distribution; an external
// link viewer sees aggregates only; its fee is a system constant with no
// per-deal or contractual override; a buyer join is an authorization hold
// only. These rules are enforced over EVERY reader-visible surface — all
// runtime source under src/ (served legal pages, API copy, notification and
// receipt templates), the legacy shell and its HTML, the React app and its
// HTML entry, the i18n sources and every Hebrew legal document — line by
// line, so old wording restored anywhere (title, nav label, heading,
// definition, an override before or after "8%", a positive commission line)
// fails. A missing surface fails closed.
{
  const REQUIRED_SURFACES = [
    "src/legal_pages.ts", "frontend/app.js", "src/frontend_runtime.ts", "src/app.ts",
    "src/seller_analytics.ts", "src/distribution_hub.ts",
    "docs/DISTRIBUTOR_TERMS_HE.md", "docs/SELLER_TERMS_HE.md", "docs/BUYER_TERMS_HE.md",
    "docs/PRIVACY_POLICY_HE.md", "docs/CANCELLATION_REFUND_POLICY_HE.md",
    "web/src/i18n/dictionaries/he.ts", "web/src/i18n/dictionaries/en.ts",
    "scripts/i18n/seed.he.json", "scripts/i18n/extracted.he.json", "scripts/i18n/en.json"
  ];
  const SURFACE_TREES = [
    { rel: "src", ext: /\.(?:ts|js|cjs|mjs|html)$/, skipDirs: new Set(["migrations"]) },
    { rel: "frontend", ext: /\.(?:js|html)$/, skipDirs: new Set() },
    { rel: "web/src", ext: /\.(?:ts|tsx|js|jsx|json|html)$/, skipDirs: new Set() }
  ];
  const OPTIONAL_SURFACES = ["web/index.html"];
  // Gershayim and typographic quotes are the same character for these rules.
  const quoteNorm = (text) => String(text).replace(/[״“”]/g, "\"");
  const surfaces = new Map();
  const addSurface = (rel) => { if (!surfaces.has(rel)) surfaces.set(rel, quoteNorm(read(rel))); };
  for (const rel of REQUIRED_SURFACES) {
    if (!exists(rel)) failures.push("distribution-link rule surface missing: " + rel);
    else addSurface(rel);
  }
  for (const rel of OPTIONAL_SURFACES) if (exists(rel)) addSurface(rel);
  for (const name of fs.readdirSync(path.join(root, "docs"))) if (/_HE\.md$/.test(name)) addSurface("docs/" + name);
  const walk = (rel, tree) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && !tree.skipDirs.has(entry.name)) walk(child, tree); }
      else if (tree.ext.test(entry.name)) addSurface(child);
    }
  };
  for (const tree of SURFACE_TREES) {
    if (!exists(tree.rel)) failures.push("distribution-link rule surface tree missing: " + tree.rel);
    else walk(tree.rel, tree);
  }

  // The only Hebrew "distributor" words a reader may meet: the canonical
  // NEGATION ("Siton has no user or business role named distributor") and
  // the verb "(you) distribute the link". The negation is matched with its
  // negative opening so a positive role sentence reusing the tail is caught;
  // the verb is matched without a definite article (המפיצים = "the
  // distributors") and never on a line that also talks about a fee.
  const ROLE_NEGATION = /(?:אין בסיטון|אינה יוצרת בסיטון) משתמש או תפקיד עסקי בשם "?מפיץ"?/g;
  const DISTRIBUTE_VERB = /(?<![֐-׿])[וש]?מפיצים (?:את )?ה?(?:לינק(?:ים)?|קישור(?:ים)?|עסקה|עסקאות)(?![֐-׿])/g;
  // A reward for distributing ("you distribute the link and receive a
  // commission") is the external commission coming back through the verb.
  const DISTRIBUTION_REWARD = /מקבל(?:ים|ת)? (?:עמל|תגמול|בונוס|תשלום|אחוז)|זכאי(?:ם|ת)? ל(?:עמל|תגמול|בונוס|תשלום)|תגמול|בונוס|עמלת הפצה|עמלה למ/;
  const HEBREW_FEE = /עמל|8%|8 אחוז/;
  // The authorization hold ("תפיסת (ה)מסגרת") anchors the hold-only rule; a
  // bare "חיוב" is too broad (seller-side lock clauses legitimately qualify
  // themselves near the word).
  // Fee anchors use the ±WINDOW search in legal documents; hold anchors are
  // same-line only (refund / cancellation conditions near "חיוב בפועל" are
  // legitimate).
  // "חיוב בפועל" anchors only in its "no actual charge before / until" sense.
  const HOLD_ANCHOR = /תפיסת (?:ה)?מסגרת|מסגרת (?:ה)?אשראי|יתפוס מסגרת|חיוב בפועל[^.]{0,40}(?:לפני|עד|רק|לאחר)|(?:לפני|עד|רק|לאחר)[^.]{0,40}חיוב בפועל|(?:לא|אין) (?:מתבצע|יתבצע|יבוצע|נעשה) חיוב/;
  // In legal documents the authorization-hold term itself also anchors within
  // the ±WINDOW, like the fee.
  const HOLD_WINDOW_ANCHOR = /תפיסת (?:ה)?מסגרת/;
  // An exception clause that would let the fixed fee or the hold-only rule
  // vary: found within WINDOW lines (before or after) of a fee / hold mention
  // in a legal document, or on the same line anywhere else.
  const HEBREW_EXCEPTION = /אלא אם|ככל שלא|בכפוף להסכמה|הסכמה אחרת|סוכם|יוסכם|הוסכם|שיוסכם|בכתב|הסכם/;
  // Rate-variation wording: a finding on any line that names the fee, unless
  // a negation or "fixed" governs it ("8% קבוע לכל עסקה", "לא ישתנה" and
  // "אינה מותאמת לפי מוכר" affirm the rule).
  const RATE_VARIATION = /שיעור אחר|שיעור (?:ה)?עמלה (?:ה)?שונה(?! לעסקה)|עמל\S*\s+(?:\S+\s+){0,2}מופחת|שיעור מופחת|הנחה\s+(?:\S+\s+){0,3}(?:על\s+|ב)ה?עמל|אחרת|ייקבע|יקבע|יוגדר|תיקבע|תוגדר|ישתנה|ישתנו|משתנה|משתנים|להשתנות|לשנות|לעדכן|תלוי|תלויה|בהתאם ל|(?:לא|אינ[הו]) (?:קבוע|אחיד|זהה)|עד 8%|לפחות 8%|(?:לא|ולא) (?:תפחת|יפחת|פחות) מ-?8%|8% ומעלה|מותאמ|לפי עסקה|לכל עסקה|לכל מוכר|לפי מוכר|למעט (?:אם|במקרים|ב|עבור|לגבי)/g;
  // Fee waivers / exemptions are a different rate (0%) for some sellers or
  // periods; a finding on any fee line, whatever governs them.
  const FEE_WAIVER = /פטור מ?עמלה|ללא עמלה (?:ל|ב)|אינה גובה עמלה (?:ב|מ|ל)/;
  // Governing: the CLOSEST negation before a variation word (at most two
  // words between, only the fillers below, never a hedge) affirms the fixed
  // rule; "קבוע(ה)" governs only "לכל עסקה / לכל מוכר" — a "fixed rate per
  // deal" or a "fixed different rate" is still a variation. Fillers: modal
  // words, the fee itself, or another negated variation word ("אינה מותאמת
  // לפי מוכר"); a content word such as "זהה / אחיד" reverses the sense.
  const GOVERNOR_FILLER = /^(?:(?:ניתן|יכול|יכולה|רשאי|רשאית|עשוי|עשויה|תהיה|יהיה|את|גובה|עמלה|C-ton|סיטון|מותאמ\S*|משתנה|שונה)\s+){0,2}$/;
  const HEDGE = /(?:^|\s)(?:בהכרח|תמיד|רק|בדרך כלל|לרוב)\s/;
  const hasUngovernedVariation = (text) => {
    for (const match of text.matchAll(RATE_VARIATION)) {
      if (/^(?:לא|אינ[הו]) (?:קבוע|אחיד|זהה)/.test(match[0])) return true;
      // An AMOUNT may vary ("סכום העמלה בשקלים משתנה לפי מספר המשתתפים") and
      // a fee is computed according to the collected sum ("מחושבת בהתאם
      // לסכום שנגבה"); only the RATE or the fee itself may not vary.
      if (/^(?:משתנ|תלוי|בהתאם ל)/.test(match[0])) {
        if (/^בהתאם ל/.test(match[0]) && /^ה?סכום/.test(text.slice(match.index + match[0].length))) continue;
        const before = text.slice(Math.max(0, match.index - 60), match.index).trim().split(/\s+/).slice(-4).join(" ");
        if (/(?:^|\s)ה?סכום/.test(before) && !/שיעור/.test(before)) continue;
      }
      // The CLOSEST governing word wins ("עמלה קבועה שלא ניתן לשנות" is
      // governed by "שלא", not by "קבועה").
      const words = text.slice(Math.max(0, match.index - 60), match.index).trim().split(/\s+/).filter(Boolean);
      let governed = false;
      for (let k = 0; k <= 2 && k < words.length; k++) {
        const word = words[words.length - 1 - k].replace(/[,(]/g, "");
        const middle = words.slice(words.length - k).join(" ");
        const isNegation = /^[וש]?(?:לא|אין|אינה|אינו|ללא)$/.test(word);
        const isFixed = /^קבועה?$/.test(word);
        if (!isNegation && !isFixed) continue;
        if (HEDGE.test(" " + middle + " ")) break;
        if (isFixed) governed = /^לכל (?:עסקה|מוכר)$/.test(match[0]);
        else governed = GOVERNOR_FILLER.test(middle ? middle + " " : "");
        break;
      }
      if (governed) continue;
      return true;
    }
    return false;
  };
  // Structural rule: on a line that names the fee, any percentage other than
  // the fixed 8%, the 90% completion rule, 100% or a VAT rate is a different
  // fee rate (closes the long tail no word list can: "עד 5%", "5%–8%" ...).
  const OTHER_PERCENT = /(?<![\d.])(\d+(?:\.\d+)?)\s?%/g;
  const ALLOWED_PERCENT = new Set(["8", "90", "100"]);
  const VAT_PERCENT = new Set(["17", "18"]);
  // A VAT rate is allowed only right after the VAT term ("מע״מ בשיעור 18%").
  const hasOtherPercent = (text) => [...text.matchAll(OTHER_PERCENT)].some((m) =>
    !ALLOWED_PERCENT.has(m[1])
    && !(VAT_PERCENT.has(m[1]) && /(?:מע"מ|מע״מ|VAT) (?:בשיעור |של )?$/i.test(text.slice(Math.max(0, m.index - 40), m.index))));
  const LAWFUL_EXCEPTION = /אלא אם (?:הדבר )?נדרש(?:ת)? (?:לפי|על פי) (?:ה)?דין/g;
  const ENGLISH_ROLE = /\b(?:distributors?|affiliates?)\b/i;
  const ENGLISH_FEE = /8\s?%|\bfee\b|commission/i;
  const ENGLISH_EXCEPTION = /\bunless\b|otherwise agreed|written (?:agreement|contract)|negotiat|discounted|custom rate|per[- ]deal rate|different rate/i;
  const isEnglishCopySurface = (rel) => /(?:^web\/src\/i18n\/dictionaries\/en\.ts|^scripts\/i18n\/en\.json|\.md|\.html)$/.test(rel) || rel === "src/legal_pages.ts";
  // A positive external-money statement: a fee / payment / balance / reward
  // whose RECIPIENT is an external party or the distribution itself, in a
  // clause whose negation (if any) does not precede the money term. Money
  // that buyers who came through a link pay as usual names no recipient and
  // is not a finding.
  const EXTERNAL_MONEY = /עמל|תשלומ|תשלום|משלמ|יתר[הת]|תגמול|זיכוי|בונוס|payout/;
  const EXTERNAL_PARTY = /גורמ(?:ים)? חיצוני|לגורם (?:ה)?חיצוני|ללינק(?:י)? (?:ה)?הפצה|בעל(?:י)? (?:ה)?(?:לינק|קישור)|בגין (?:ה)?הפצה|למפיצ|למפיץ|עבורו|למקור(?:ות)? (?:ה)?הפצה/;
  // A commission / reward computed for a distribution link or source needs no
  // explicit recipient ("עמלה לכל הצטרפות שהגיעה מלינק הפצה"); plain buyer
  // payments through a link do.
  const REWARD_MONEY = /עמל|תגמול|בונוס/;
  // A sentence describing Siton's OWN fee being collected / applied / computed
  // is not a distribution reward; the phrase is removed before the test.
  const SITON_OWN_FEE = /(?:^|\s)[והמבלש]?עמלת (?:C-ton|סיטון|הפלטפורמה)(?= (?:נגבית|חלה|מחושבת))/g;
  const DISTRIBUTION_SOURCE = /לינק(?:י)? (?:ה)?הפצה|מקור(?:ות)? (?:ה)?הפצה/;
  const NEGATION = /(?:^|[\s,("])ו?(?:אינה|אינו|אין|אינם|אינן|לא|ללא)(?=[\s,.)"])/;
  const WINDOW = 3;
  for (const [rel, text] of surfaces) {
    const lines = text.split(/\r?\n/);
    const isLegalDoc = /^docs\/.*_HE\.md$/.test(rel) || rel === "src/legal_pages.ts";
    lines.forEach((line, index) => {
      const where = rel + ":" + (index + 1);
      const around = lines.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).join("\n");
      let stripped = line.replace(ROLE_NEGATION, "");
      const verbStripped = stripped.replace(DISTRIBUTE_VERB, "");
      if (verbStripped !== stripped && DISTRIBUTION_REWARD.test(line)) failures.push("distribution wording tied to a fee (no external distribution commission exists): " + where);
      stripped = verbStripped;
      if (/מפיצ|מפיץ/.test(stripped)) failures.push("distributor-role wording returned (no distributor business role exists; say לינק הפצה / מקור הפצה or use the canonical negation): " + where);
      if (/^(?:web\/src\/i18n\/dictionaries\/en\.ts|scripts\/i18n\/en\.json)$/.test(rel)) {
        const entry = /^\s*"[^"]+"\s*:\s*"(.*)"\s*,?\s*$/.exec(line);
        if (entry && ENGLISH_ROLE.test(entry[1])) failures.push("distributor/affiliate role wording returned in English copy: " + where);
      }
      // Fee / hold exceptions: the qualifier anywhere within WINDOW lines of a
      // fee or charge mention, before or after it.
      const lawful = line.replace(LAWFUL_EXCEPTION, "");
      if ((HEBREW_EXCEPTION.test(lawful) && ((isLegalDoc ? (HEBREW_FEE.test(around) || HOLD_WINDOW_ANCHOR.test(around)) : HEBREW_FEE.test(line)) || HOLD_ANCHOR.test(line)))
          || (HEBREW_FEE.test(line) && (hasUngovernedVariation(lawful) || hasOtherPercent(line) || FEE_WAIVER.test(lawful)))) {
        failures.push("legal copy makes the fixed 8% Siton fee overridable or adds an exception to the authorization-hold-only rule: " + where);
      }
      if (isEnglishCopySurface(rel) && ENGLISH_EXCEPTION.test(line) && ENGLISH_FEE.test(around)) {
        failures.push("English copy makes the fixed 8% Siton fee overridable: " + where);
      }
      for (const sentence of line.split(/[.!?;]|\s(?:אך|אבל|אולם|ואילו)\s/)) {
        // The negation must govern the money term: it has to come BEFORE it
        // ("C-ton computes a commission …, and does not issue an invoice" is
        // positive even though the sentence contains a negation).
        const moneyAt = sentence.search(EXTERNAL_MONEY);
        const rewardText = sentence.replace(SITON_OWN_FEE, " ");
        const external = EXTERNAL_PARTY.test(sentence) || (REWARD_MONEY.test(rewardText) && DISTRIBUTION_SOURCE.test(rewardText));
        if (moneyAt >= 0 && external && !NEGATION.test(" " + sentence.slice(0, moneyAt))) {
          failures.push("positive external-distribution money statement (Siton never calculates, accrues, collects or pays for distribution): " + where);
          break;
        }
      }
    });
  }

  // Exact pins: the canonical sentences must stay word for word.
  const pins = [
    ["src/legal_pages.ts", "אין שיעור עמלה שונה לעסקה", "the fixed 8% fee (no per-deal rate)"],
    ["docs/SELLER_TERMS_HE.md", "אין שיעור עמלה שונה לעסקה", "the fixed 8% fee (no per-deal rate)"],
    ["frontend/app.js", "אין שיעור עמלה שונה לעסקה", "the fixed 8% fee (no per-deal rate)"],
    ["src/legal_pages.ts", "בהצטרפות לעסקה מתבצעת תפיסת מסגרת אשראי בלבד", "authorization hold only on join"],
    ["src/legal_pages.ts", "חיוב בפועל אינו מתבצע לפני שהעסקה נסגרת להצטרפות וננעלת", "no charge before close/lock"],
    ["src/legal_pages.ts", "אין בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\"", "no distributor business role"],
    ["docs/DISTRIBUTOR_TERMS_HE.md", "אין בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\"", "no distributor business role"],
    ["src/legal_pages.ts", "C-ton אינה מחשבת עמלה לגורם חיצוני בגין הפצה", "no external distribution commission"],
    ["src/legal_pages.ts", "C-ton אינה צוברת עבורו יתרה", "no external distribution balance"],
    ["src/legal_pages.ts", "C-ton אינה גובה עבורו עמלה ואינה מעבירה לו תשלום", "no external distribution payment"],
    ["src/legal_pages.ts", "C-ton אינה מחשבת, אינה צוברת, אינה גובה ואינה משלמת עמלה לגורם חיצוני בגין הפצה", "no external distribution commission"],
    ["docs/DISTRIBUTOR_TERMS_HE.md", "C-ton אינה מחשבת, צוברת, גובה או משלמת עמלה לגורם חיצוני בגין הפצה", "no external distribution commission"],
    ["docs/SELLER_TERMS_HE.md", "C-ton אינה מחשבת, צוברת, גובה או משלמת עמלה לגורם חיצוני בגין הפצה", "no external distribution commission"],
    ["src/legal_pages.ts", "היא אינה כוללת מידע אישי על קונים", "aggregate-only link viewer (no buyer personal data)"],
    ["src/legal_pages.ts", "הגישה אינה כוללת שמות, טלפונים, אימיילים, כתובות, אמצעי תשלום או סטטוסי חיוב אישיים של קונים", "aggregate-only link viewer (no buyer personal data)"],
    ["docs/DISTRIBUTOR_TERMS_HE.md", "אין גישה למידע אישי על קונים", "aggregate-only link viewer (no buyer personal data)"],
    ["docs/PRIVACY_POLICY_HE.md", "ואינו מקבל מידע אישי על קונים", "aggregate-only link viewer (no buyer personal data)"]
  ];
  for (const [rel, phrase, rule] of pins) {
    if (surfaces.has(rel) && !norm(surfaces.get(rel)).includes(phrase)) failures.push("legal copy no longer pins " + rule + ": " + rel);
  }
  if (!/8%[^\n]{0,260}למעט רכיב המע"מ של הלקוח/.test(norm(surfaces.get("src/legal_pages.ts") || ""))
      || !/8%[^\n]{0,260}למעט רכיב המע"מ של הלקוח/.test(norm(surfaces.get("docs/SELLER_TERMS_HE.md") || ""))) {
    failures.push("legal copy does not pin the 8% fee base to collected amount excluding the customer's VAT component");
  }
}

if (!app.includes("sellerPublishCriticalTermsAccepted") || !app.includes("sellerPublishThresholdAccepted")) failures.push("seller publish operational confirmations are missing");
if (!server.includes("seller_critical_terms_accepted") || !server.includes("seller_threshold_90_accepted")) failures.push("server publish endpoint does not require seller critical-terms and 90% confirmations");
if (!sellerKyc.includes("basic identification details") || !sellerKyc.includes("can continue automatically")) failures.push("lean seller identification policy is missing or too heavy");
for (const required of ["לא חוקי", "מזויף", "מפר זכויות", "להסיר עסקה", "לחסום מוכר", "בדיעבד"]) {
  if (!sellerTerms.includes(required)) failures.push("seller terms missing enforcement/product legality language: " + required);
}

const indexHtml = read("frontend/index.html");
if (!app.includes("aria-live=\"polite\"") || !indexHtml.includes("skip-link") || !indexHtml.includes("main-content")) failures.push("accessibility baseline is incomplete");

if (failures.length) {
  console.error("LEGAL_COMPLIANCE_GATE_FAIL");
  for (const failure of failures) console.error("- " + failure);
  for (const warning of warnings) console.error("- WARNING " + warning);
  process.exit(1);
}

console.log(warnings.length ? "LEGAL_COMPLIANCE_GATE_PASS_WITH_WARNINGS" : "LEGAL_COMPLIANCE_GATE_PASS");
for (const warning of warnings) console.log("- WARNING " + warning);
