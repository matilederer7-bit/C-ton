// Product catalog (071) — the seller Product Library inside the canonical
// seller command center: reusable Products (name, copy, category, typed
// attributes, fulfillment defaults) that Deals are created FROM. A Deal
// freezes the Product presentation it was created with; editing a Product
// creates revision N+1 and never changes a published Deal.
//
// Ported from the shelf branch codex/amazon-benchmark-upgrade (legacy
// frontend/app.js Product Library) onto the React web app. Server routes:
// GET /api/seller/products, GET /api/seller/products/:id (reads),
// POST /api/seller/products, PATCH /api/seller/products/:id (writes).
import React, { useEffect, useMemo, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, StatusPill, Toast, useToast } from "../components";
import { dealTypeIcon, dealTypeLabel, fmtDate, ils, num } from "../util";
import {
  PRODUCT_TYPE_LABELS, applyProductLibraryFilters, productDealRevisionStatus, productLibraryEmptyKind, validateEstimateRange,
  type ProductLibraryFilters
} from "../productLibrary";
import { attention, focusField } from "../fieldAttention";

type ProductType = "physical_product" | "voucher" | "ticket";

function FieldError({ msg }: { msg?: string }) {
  return msg ? <span className="field-error" role="alert">{msg}</span> : null;
}

// ── product form (create + edit share one form; type is locked after creation) ─
type ProductFormValue = {
  name: string; short_description: string; long_description: string; category: string;
  product_type: ProductType;
  est_min: string; est_max: string;
  // physical
  stock_note: string; weight_grams: string; dimensions: string; color: string; size: string;
  // voucher
  redemption_location: string; redemption_instructions: string; usage_restrictions: string; valid_until: string;
  // ticket
  event_name: string; event_starts_at: string; event_ends_at: string; venue_name: string; venue_address: string; venue_city: string; entry_instructions: string;
};

const EMPTY_FORM: ProductFormValue = {
  name: "", short_description: "", long_description: "", category: "", product_type: "physical_product",
  est_min: "", est_max: "",
  stock_note: "", weight_grams: "", dimensions: "", color: "", size: "",
  redemption_location: "", redemption_instructions: "", usage_restrictions: "", valid_until: "",
  event_name: "", event_starts_at: "", event_ends_at: "", venue_name: "", venue_address: "", venue_city: "", entry_instructions: ""
};

function toLocalDateTime(iso: unknown): string {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function productToForm(product: Json): ProductFormValue {
  const attrs = (product?.type_attributes || {}) as Json;
  const defaults = (product?.fulfillment_defaults || {}) as Json;
  return {
    ...EMPTY_FORM,
    name: String(product?.name || ""),
    short_description: String(product?.short_description || ""),
    long_description: String(product?.long_description || ""),
    category: String(product?.category || ""),
    product_type: (["physical_product", "voucher", "ticket"].includes(String(product?.product_type)) ? String(product.product_type) : "physical_product") as ProductType,
    est_min: defaults.estimated_min_business_days == null ? "" : String(defaults.estimated_min_business_days),
    est_max: defaults.estimated_max_business_days == null ? "" : String(defaults.estimated_max_business_days),
    stock_note: String(attrs.stock_note || ""), weight_grams: attrs.weight_grams == null ? "" : String(attrs.weight_grams),
    dimensions: String(attrs.dimensions || ""), color: String(attrs.color || ""), size: String(attrs.size || ""),
    redemption_location: String(attrs.redemption_location || ""), redemption_instructions: String(attrs.redemption_instructions || ""),
    usage_restrictions: String(attrs.usage_restrictions || ""), valid_until: attrs.valid_until ? String(attrs.valid_until).slice(0, 10) : "",
    event_name: String(attrs.event_name || ""), event_starts_at: toLocalDateTime(attrs.event_starts_at), event_ends_at: toLocalDateTime(attrs.event_ends_at),
    venue_name: String(attrs.venue_name || ""), venue_address: String(attrs.venue_address || ""), venue_city: String(attrs.venue_city || ""),
    entry_instructions: String(attrs.entry_instructions || "")
  };
}

export function validateProductForm(f: ProductFormValue): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!f.name.trim()) errs.name = "יש להזין שם למוצר";
  if (!f.short_description.trim()) errs.short_description = "יש להזין תיאור קצר — המשפט שמוכר את המוצר";
  const est = validateEstimateRange(f.est_min, f.est_max);
  if (est) errs.est = est;
  if (f.product_type === "physical_product" && f.weight_grams.trim() && !(Number(f.weight_grams) > 0)) errs.weight_grams = "משקל חייב להיות מספר חיובי (גרם)";
  if (f.product_type === "voucher") {
    if (!f.redemption_location.trim()) errs.redemption_location = "יש להזין מקום מימוש";
    if (!f.redemption_instructions.trim()) errs.redemption_instructions = "יש להזין הוראות מימוש";
  }
  if (f.product_type === "ticket") {
    if (!f.event_name.trim()) errs.event_name = "יש להזין שם אירוע";
    if (!f.event_starts_at) errs.event_starts_at = "יש לבחור מועד לאירוע";
    if (!f.venue_name.trim()) errs.venue_name = "יש להזין את מקום האירוע";
    if (!f.entry_instructions.trim()) errs.entry_instructions = "יש להזין הוראות כניסה";
    if (f.event_ends_at && f.event_starts_at && new Date(f.event_ends_at).getTime() <= new Date(f.event_starts_at).getTime()) errs.event_ends_at = "מועד הסיום חייב להיות אחרי ההתחלה";
  }
  return errs;
}

export function formToPayload(f: ProductFormValue): Json {
  const typeAttributes: Json = f.product_type === "physical_product"
    ? { stock_note: f.stock_note.trim(), weight_grams: f.weight_grams.trim() ? Number(f.weight_grams) : null, dimensions: f.dimensions.trim(), color: f.color.trim(), size: f.size.trim() }
    : f.product_type === "voucher"
      ? { redemption_location: f.redemption_location.trim(), redemption_instructions: f.redemption_instructions.trim(), usage_restrictions: f.usage_restrictions.trim(), valid_until: f.valid_until ? new Date(`${f.valid_until}T23:59:59`).toISOString() : null }
      : {
        event_name: f.event_name.trim(), event_starts_at: f.event_starts_at ? new Date(f.event_starts_at).toISOString() : null,
        event_ends_at: f.event_ends_at ? new Date(f.event_ends_at).toISOString() : null, venue_name: f.venue_name.trim(),
        venue_address: f.venue_address.trim(), venue_city: f.venue_city.trim(), entry_instructions: f.entry_instructions.trim()
      };
  return {
    name: f.name.trim(),
    short_description: f.short_description.trim(),
    long_description: f.long_description.trim(),
    category: f.category.trim(),
    product_type: f.product_type,
    type_attributes: typeAttributes,
    fulfillment_defaults: {
      estimated_min_business_days: f.est_min.trim() ? Number(f.est_min) : null,
      estimated_max_business_days: f.est_max.trim() ? Number(f.est_max) : null
    }
  };
}

function ProductForm({ initial, lockType, busy, onSubmit, submitLabel }: {
  initial: ProductFormValue; lockType: boolean; busy: boolean; submitLabel: string;
  onSubmit: (payload: Json) => Promise<void>;
}) {
  const [f, setF] = useState<ProductFormValue>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<ProductFormValue>) => setF({ ...f, ...patch });
  const submit = async () => {
    const errs = validateProductForm(f);
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) { focusField(first); return; }
    await onSubmit(formToPayload(f));
  };
  return (
    <div className="stack" style={{ gap: 4 }} data-testid="product-form">
      <div className="field">
        <label htmlFor="product-type">סוג המוצר</label>
        <select id="product-type" data-testid="product-type" value={f.product_type} disabled={lockType || busy} onChange={(e) => set({ product_type: e.target.value as ProductType })}>
          <option value="physical_product">מוצר פיזי</option>
          <option value="voucher">שובר</option>
          <option value="ticket">כרטיס לאירוע</option>
        </select>
        <span className="hint">{lockType ? "סוג המוצר נקבע ביצירה ואינו משתנה." : "כל העסקאות שייווצרו מהמוצר יהיו מסוג זה."}</span>
      </div>
      <div className="field">
        <label htmlFor="f-name">שם המוצר <span className="req">*</span></label>
        <input {...attention(errors, "name")} data-testid="product-name" value={f.name} maxLength={200} disabled={busy} onChange={(e) => set({ name: e.target.value })} placeholder="למשל: מארז זיתי סורי 5 ק״ג" />
        <FieldError msg={errors.name} />
      </div>
      <div className="field">
        <label htmlFor="f-short_description">תיאור קצר <span className="req">*</span> <span className="hint">(עד 200 תווים)</span></label>
        <input {...attention(errors, "short_description")} data-testid="product-short" value={f.short_description} maxLength={200} disabled={busy} onChange={(e) => set({ short_description: e.target.value })} />
        <FieldError msg={errors.short_description} />
      </div>
      <div className="field">
        <label htmlFor="f-long_description">תיאור מלא <span className="hint">(לא חובה)</span></label>
        <textarea id="f-long_description" data-testid="product-long" rows={5} value={f.long_description} maxLength={4000} disabled={busy} onChange={(e) => set({ long_description: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="f-category">קטגוריה <span className="hint">(לחיפוש בספרייה)</span></label>
        <input id="f-category" data-testid="product-category" value={f.category} maxLength={160} disabled={busy} onChange={(e) => set({ category: e.target.value })} placeholder="למשל: מזון, אלקטרוניקה, בילויים" />
      </div>

      {f.product_type === "physical_product" ? (
        <>
          <div className="field-row">
            <div className="field"><label htmlFor="f-weight_grams">משקל (גרם)</label><input {...attention(errors, "weight_grams")} dir="ltr" type="number" min={1} value={f.weight_grams} disabled={busy} onChange={(e) => set({ weight_grams: e.target.value })} /><FieldError msg={errors.weight_grams} /></div>
            <div className="field"><label htmlFor="f-dimensions">מידות</label><input id="f-dimensions" value={f.dimensions} maxLength={160} disabled={busy} onChange={(e) => set({ dimensions: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-color">צבע</label><input id="f-color" value={f.color} maxLength={120} disabled={busy} onChange={(e) => set({ color: e.target.value })} /></div>
            <div className="field"><label htmlFor="f-size">גודל</label><input id="f-size" value={f.size} maxLength={120} disabled={busy} onChange={(e) => set({ size: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="f-stock_note">הערת מלאי <span className="hint">(פנימי)</span></label><input id="f-stock_note" value={f.stock_note} maxLength={300} disabled={busy} onChange={(e) => set({ stock_note: e.target.value })} /></div>
        </>
      ) : null}

      {f.product_type === "voucher" ? (
        <>
          <div className="field"><label htmlFor="f-redemption_location">מקום מימוש <span className="req">*</span></label><input {...attention(errors, "redemption_location")} data-testid="product-voucher-location" value={f.redemption_location} maxLength={500} disabled={busy} onChange={(e) => set({ redemption_location: e.target.value })} /><FieldError msg={errors.redemption_location} /></div>
          <div className="field"><label htmlFor="f-redemption_instructions">הוראות מימוש <span className="req">*</span></label><textarea {...attention(errors, "redemption_instructions")} data-testid="product-voucher-instructions" rows={3} value={f.redemption_instructions} maxLength={1000} disabled={busy} onChange={(e) => set({ redemption_instructions: e.target.value })} /><FieldError msg={errors.redemption_instructions} /></div>
          <div className="field"><label htmlFor="f-usage_restrictions">תנאי השובר</label><textarea id="f-usage_restrictions" rows={3} value={f.usage_restrictions} maxLength={2000} disabled={busy} onChange={(e) => set({ usage_restrictions: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-valid_until">בתוקף עד <span className="hint">(ברירת מחדל לעסקאות)</span></label><input id="f-valid_until" dir="ltr" type="date" value={f.valid_until} disabled={busy} onChange={(e) => set({ valid_until: e.target.value })} /></div>
        </>
      ) : null}

      {f.product_type === "ticket" ? (
        <>
          <div className="field"><label htmlFor="f-event_name">שם האירוע <span className="req">*</span></label><input {...attention(errors, "event_name")} data-testid="product-ticket-event" value={f.event_name} maxLength={200} disabled={busy} onChange={(e) => set({ event_name: e.target.value })} /><FieldError msg={errors.event_name} /></div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-event_starts_at">מתי מתחיל <span className="req">*</span></label><input {...attention(errors, "event_starts_at")} dir="ltr" type="datetime-local" value={f.event_starts_at} disabled={busy} onChange={(e) => set({ event_starts_at: e.target.value })} /><FieldError msg={errors.event_starts_at} /></div>
            <div className="field"><label htmlFor="f-event_ends_at">מתי מסתיים</label><input {...attention(errors, "event_ends_at")} dir="ltr" type="datetime-local" value={f.event_ends_at} disabled={busy} onChange={(e) => set({ event_ends_at: e.target.value })} /><FieldError msg={errors.event_ends_at} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-venue_name">מקום האירוע <span className="req">*</span></label><input {...attention(errors, "venue_name")} value={f.venue_name} maxLength={200} disabled={busy} onChange={(e) => set({ venue_name: e.target.value })} /><FieldError msg={errors.venue_name} /></div>
            <div className="field"><label htmlFor="f-venue_city">עיר</label><input id="f-venue_city" value={f.venue_city} maxLength={100} disabled={busy} onChange={(e) => set({ venue_city: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="f-venue_address">כתובת</label><input id="f-venue_address" value={f.venue_address} maxLength={300} disabled={busy} onChange={(e) => set({ venue_address: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-entry_instructions">הוראות כניסה <span className="req">*</span></label><textarea {...attention(errors, "entry_instructions")} rows={3} value={f.entry_instructions} maxLength={1000} disabled={busy} onChange={(e) => set({ entry_instructions: e.target.value })} /><FieldError msg={errors.entry_instructions} /></div>
        </>
      ) : null}

      <div className="field">
        <label>זמן אספקה משוער <span className="hint">(ימי עסקים מהשלמת העסקה — ברירת מחדל לכל אפשרות אספקה)</span></label>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <input {...attention(errors, "est")} data-testid="product-est-min" dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 110 }} value={f.est_min} disabled={busy} onChange={(e) => set({ est_min: e.target.value })} aria-label="מינימום ימי עסקים" />
          <span>עד</span>
          <input data-testid="product-est-max" dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 110 }} value={f.est_max} disabled={busy} onChange={(e) => set({ est_max: e.target.value })} aria-label="מקסימום ימי עסקים" />
        </div>
        <FieldError msg={errors.est} />
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" data-testid="product-save" disabled={busy} onClick={() => void submit()}>{busy ? "שומרים…" : submitLabel}</button>
      </div>
    </div>
  );
}

// ── library ────────────────────────────────────────────────────────────────
export function SellerProductLibraryPage({ navigate }: { navigate: (h: string) => void }) {
  const [rows, setRows] = useState<Json[] | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<ProductLibraryFilters>({ query: "", status: "active", type: "", sort: "updated" });
  const [toast, showToast] = useToast();

  const load = () => api.sellerProducts("all").then((r) => { setRows(r.products || []); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => applyProductLibraryFilters((rows || []) as any[], filters), [rows, filters]);
  const emptyKind = productLibraryEmptyKind((rows || []) as any[], visible as any[], filters);

  const toggleArchive = async (row: Json) => {
    const next = String(row.status) === "archived" ? "active" : "archived";
    try {
      await api.updateProduct(String(row.product_id), { status: next });
      showToast(next === "archived" ? "המוצר הועבר לארכיון" : "המוצר שוחזר לספרייה");
      await load();
    } catch (e: any) { showToast(e.message || "הפעולה נכשלה"); }
  };

  if (error) return <EmptyState icon="⚠️" title="לא ניתן לטעון את ספריית המוצרים" body={error} />;
  if (!rows) return <BrandLoader label="טוענים את ספריית המוצרים…" minHeight={320} />;

  return (
    <div data-testid="product-library">
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>→ לדשבורד</a>
      <div className="dash-head">
        <div>
          <h1>ספריית המוצרים שלי</h1>
          <span className="dash-updated">מוצר אחד — הרבה עסקאות. עסקה שנוצרת מהמוצר מקפיאה את הפרטים שלו; עריכת המוצר לא משנה עסקאות שכבר פורסמו.</span>
        </div>
        <div className="row" style={{ marginInlineStart: "auto" }}>
          <button className="btn btn-primary" data-testid="product-new" onClick={() => navigate("#/seller/products/new")}>+ מוצר חדש</button>
        </div>
      </div>

      <div className="panel product-library-controls" data-testid="product-library-controls">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input data-testid="product-search" style={{ flex: "2 1 220px" }} value={filters.query || ""} onChange={(e) => setFilters({ ...filters, query: e.target.value })} placeholder="חיפוש לפי שם או קטגוריה" aria-label="חיפוש מוצר" />
          <select data-testid="product-status-filter" style={{ flex: "1 1 130px" }} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="סטטוס">
            <option value="active">פעילים</option>
            <option value="archived">בארכיון</option>
            <option value="all">הכול</option>
          </select>
          <select data-testid="product-type-filter" style={{ flex: "1 1 130px" }} value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} aria-label="סוג">
            <option value="">כל הסוגים</option>
            <option value="physical_product">מוצר פיזי</option>
            <option value="voucher">שובר</option>
            <option value="ticket">כרטיס לאירוע</option>
          </select>
          <select data-testid="product-sort" style={{ flex: "1 1 130px" }} value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} aria-label="מיון">
            <option value="updated">עודכן לאחרונה</option>
            <option value="deals">הכי הרבה עסקאות</option>
            <option value="name">לפי שם</option>
          </select>
        </div>
      </div>

      {emptyKind === "library-empty" ? (
        <EmptyState icon="📦" title="עדיין אין מוצרים בספרייה" body="הוסיפו מוצר אחד ותוכלו ליצור ממנו עסקאות שוב ושוב — או שמרו טיוטה קיימת כמוצר מתוך מסך העסקה."
          action={<button className="btn btn-primary" onClick={() => navigate("#/seller/products/new")}>+ מוצר חדש</button>} />
      ) : emptyKind === "search-empty" ? (
        <EmptyState icon="🔍" title="לא נמצאו מוצרים לחיפוש הזה" body="נסו מילה אחרת או נקו את החיפוש." action={<button className="btn btn-ghost" onClick={() => setFilters({ ...filters, query: "" })}>ניקוי החיפוש</button>} />
      ) : emptyKind === "filter-empty" ? (
        <EmptyState icon="🗂️" title="אין מוצרים שמתאימים לסינון" body="שנו את הסטטוס או את סוג המוצר." action={<button className="btn btn-ghost" onClick={() => setFilters({ query: filters.query, status: "all", type: "", sort: filters.sort })}>הצגת הכול</button>} />
      ) : (
        <div className="sd-grid" data-testid="product-grid">
          {visible.map((p: any) => (
            <div className="sd-card product-library-card" key={p.product_id} data-testid="product-card" data-product-status={String(p.status)}>
              <div className="sd-top">
                <div className="sd-thumb">{p.primary_image_url ? <img src={p.primary_image_url} alt="" /> : dealTypeIcon(String(p.product_type || "physical_product"))}</div>
                <div className="grow">
                  <b>{p.name}</b>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className="muted small">{PRODUCT_TYPE_LABELS[String(p.product_type)] || dealTypeLabel(String(p.product_type))}</span>
                    {p.category ? <span className="muted small">· {p.category}</span> : null}
                    {String(p.status) === "archived" ? <span className="stale-badge">בארכיון</span> : null}
                  </div>
                </div>
              </div>
              <div className="kv" style={{ margin: "10px 0" }}>
                <span className="k">עסקאות מהמוצר</span><span className="v">{num(p.deals_count || 0)}</span>
                <span className="k">גרסה</span><span className="v">{num(p.revision || 1)}</span>
                <span className="k">עודכן</span><span className="v">{fmtDate(p.updated_at)}</span>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {String(p.status) === "archived"
                  ? <button className="btn btn-sm btn-primary" data-testid="product-restore-and-create" onClick={() => void toggleArchive(p).then(() => navigate(`#/seller/new?product=${p.product_id}`))}>שחזור ויצירת עסקה</button>
                  : <button className="btn btn-sm btn-primary" data-testid="product-create-deal" onClick={() => navigate(`#/seller/new?product=${p.product_id}`)}>יצירת עסקה מהמוצר</button>}
                <button className="btn btn-sm btn-ghost" data-testid="product-open" onClick={() => navigate(`#/seller/products/${p.product_id}`)}>פרטים ועריכה</button>
                <button className="btn btn-sm btn-ghost" data-testid="product-archive-toggle" onClick={() => void toggleArchive(p)}>{String(p.status) === "archived" ? "שחזור" : "לארכיון"}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Toast msg={toast} />
    </div>
  );
}

// ── create ─────────────────────────────────────────────────────────────────
export function SellerProductCreatePage({ navigate }: { navigate: (h: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (payload: Json) => {
    setBusy(true); setError("");
    try {
      const r = await api.createProduct(payload);
      const id = r?.product?.product_id;
      if (!id) throw new Error("יצירת המוצר נכשלה — נסו שוב");
      navigate(`#/seller/products/${id}`);
    } catch (e: any) { setError(e.message || "השמירה נכשלה"); setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <a className="back" href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>→ לספריית המוצרים</a>
      <div className="panel">
        <h2>מוצר חדש</h2>
        <p className="muted small">המוצר הוא התיאור הקבוע. מחיר, כמויות, מועד סיום ואספקה נקבעים בכל עסקה בנפרד. תמונות מתווספות לעסקה, ונשמרות למוצר כששומרים טיוטה כמוצר.</p>
        {error ? <div className="notice err">{error}</div> : null}
        <ProductForm initial={EMPTY_FORM} lockType={false} busy={busy} submitLabel="שמירת המוצר" onSubmit={submit} />
      </div>
    </div>
  );
}

// ── detail: edit + deal history ───────────────────────────────────────────
export function SellerProductPage({ productId, navigate }: { productId: string; navigate: (h: string) => void }) {
  const [product, setProduct] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [toast, showToast] = useToast();

  const load = () => api.sellerProduct(productId).then((r) => { setProduct(r.product); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [productId]);

  if (error) return <EmptyState icon="⚠️" title="לא ניתן לטעון את המוצר" body={error} action={<button className="btn btn-ghost" onClick={() => navigate("#/seller/products")}>לספריית המוצרים</button>} />;
  if (!product) return <BrandLoader label="טוענים את המוצר…" minHeight={320} />;

  const revision = Number(product.revision || 1);
  const deals: Json[] = product.deals || [];
  const archived = String(product.status) === "archived";
  const est = product.fulfillment_defaults || {};

  const save = async (payload: Json) => {
    setBusy(true);
    try {
      await api.updateProduct(productId, payload);
      showToast("המוצר עודכן (גרסה חדשה). עסקאות קיימות שפורסמו לא השתנו.");
      setEditing(false);
      await load();
    } catch (e: any) { showToast(e.message || "השמירה נכשלה"); }
    setBusy(false);
  };
  const toggleArchive = async () => {
    setBusy(true);
    try {
      await api.updateProduct(productId, { status: archived ? "active" : "archived" });
      showToast(archived ? "המוצר שוחזר לספרייה" : "המוצר הועבר לארכיון");
      await load();
    } catch (e: any) { showToast(e.message || "הפעולה נכשלה"); }
    setBusy(false);
  };

  return (
    <div data-testid="product-detail">
      <a className="back" href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>→ לספריית המוצרים</a>
      <div className="panel">
        <div className="sd-top product-detail-header">
          <div className="sd-thumb">{product.images?.[0]?.url ? <img src={product.images[0].url} alt="" /> : dealTypeIcon(String(product.product_type || "physical_product"))}</div>
          <div className="grow">
            <h1 style={{ margin: 0, fontSize: "1.3rem" }} data-testid="product-title">{product.name}</h1>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="muted small">{PRODUCT_TYPE_LABELS[String(product.product_type)] || dealTypeLabel(String(product.product_type))}</span>
              {product.category ? <span className="muted small">· {product.category}</span> : null}
              <span className="muted small">· גרסה {num(revision)}</span>
              {archived ? <span className="stale-badge">בארכיון</span> : null}
            </div>
          </div>
        </div>
        {product.short_description ? <p style={{ marginTop: 12, fontWeight: 600 }}>{product.short_description}</p> : null}
        {product.long_description ? <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{product.long_description}</p> : null}
        {est.estimated_min_business_days != null || est.estimated_max_business_days != null ? (
          <p className="muted small">זמן אספקה משוער (ברירת מחדל): {est.estimated_min_business_days ?? "?"}–{est.estimated_max_business_days ?? "?"} ימי עסקים מהשלמת העסקה</p>
        ) : null}
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {archived
            ? <button className="btn btn-primary" data-testid="product-restore-and-create" disabled={busy} onClick={() => void toggleArchive().then(() => navigate(`#/seller/new?product=${productId}`))}>שחזור ויצירת עסקה</button>
            : <button className="btn btn-primary" data-testid="product-create-deal" disabled={busy} onClick={() => navigate(`#/seller/new?product=${productId}`)}>יצירת עסקה מהמוצר</button>}
          {!editing ? <button className="btn btn-ghost" data-testid="product-edit-open" disabled={busy} onClick={() => setEditing(true)}>עריכת המוצר</button> : null}
          <button className="btn btn-ghost" data-testid="product-archive-toggle" disabled={busy} onClick={() => void toggleArchive()}>{archived ? "שחזור מהארכיון" : "העברה לארכיון"}</button>
        </div>
      </div>

      {editing ? (
        <div className="panel" data-testid="product-edit-panel">
          <div className="panel-title">עריכת המוצר</div>
          <div className="notice info">כל שמירה יוצרת גרסה חדשה של המוצר. עסקאות שכבר פורסמו נשארות עם הגרסה שהוקפאה בהן; טיוטות חדשות ייווצרו מהגרסה החדשה.</div>
          <ProductForm initial={productToForm(product)} lockType busy={busy} submitLabel="שמירת גרסה חדשה" onSubmit={save} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>ביטול</button>
          </div>
        </div>
      ) : null}

      {product.images?.length ? (
        <div className="panel">
          <div className="panel-title">תמונות המוצר</div>
          <div className="img-strip">
            {product.images.map((img: Json) => (
              <span key={img.product_image_id} className={`img-strip-thumb${img.is_primary ? " primary" : ""}`}><img src={img.url} alt="" />{img.is_primary ? <em>ראשית</em> : null}</span>
            ))}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>התמונות מועתקות לכל עסקה שנוצרת מהמוצר.</p>
        </div>
      ) : (
        <div className="panel"><div className="panel-title">תמונות המוצר</div><p className="muted small" style={{ margin: 0 }}>למוצר אין עדיין תמונות — הן יתווספו בעסקה הראשונה שתיצרו ממנו, או כששומרים טיוטה קיימת כמוצר.</p></div>
      )}

      <div className="panel" data-testid="product-deal-history">
        <div className="panel-title">עסקאות מהמוצר <span className="count">({deals.length})</span></div>
        {deals.length === 0 ? (
          <EmptyState icon="🏷️" title="עדיין לא נוצרו עסקאות מהמוצר הזה" body="צרו את העסקה הראשונה — המחיר, הכמויות והמועד נקבעים בעסקה."
            action={!archived ? <button className="btn btn-primary" onClick={() => navigate(`#/seller/new?product=${productId}`)}>יצירת עסקה מהמוצר</button> : undefined} />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {deals.map((d) => {
              const rev = productDealRevisionStatus(d as any, revision);
              return (
                <div className="delivery-view-row product-history-row" key={String(d.deal_id)} data-testid="product-history-row" data-snapshot-status={rev.isCurrent ? "current" : rev.isHistorical ? "historical" : "unknown"}>
                  <span className="grow">
                    <a href={`#/seller/deal/${d.deal_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${d.deal_id}`); }}><b>{d.title}</b></a>
                    <span className="muted small"> · {ils(d.price_per_unit)} · {num(d.min_units)}–{num(d.max_units)} יח׳ · {fmtDate(d.created_at)}</span>
                    {rev.isHistorical ? <span className="muted small" data-testid="product-history-historical"> · העסקה פורסמה על בסיס גרסה {rev.snapshotRevision} (הנוכחית: {revision})</span> : null}
                  </span>
                  <StatusPill state={String(d.state)} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Toast msg={toast} />
    </div>
  );
}
