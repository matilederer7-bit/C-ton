// Product catalog (072) — the seller Product Library inside the canonical
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
import { dealTypeLabel, fmtDate, ils, num } from "../util";
import {
  PRODUCT_TYPE_LABELS, applyProductLibraryFilters, productDealRevisionStatus, productLibraryEmptyKind, validateEstimateRange,
  type ProductLibraryFilters
} from "../productLibrary";
import { t } from "../i18n";
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
  if (!f.name.trim()) errs.name = t("pages.seller_products.e3c27321");
  if (!f.short_description.trim()) errs.short_description = t("pages.seller_products.23b82d6a");
  const est = validateEstimateRange(f.est_min, f.est_max);
  if (est) errs.est = est;
  if (f.product_type === "physical_product" && f.weight_grams.trim() && !(Number(f.weight_grams) > 0)) errs.weight_grams = t("pages.seller_products.206c5cba");
  if (f.product_type === "voucher") {
    if (!f.redemption_location.trim()) errs.redemption_location = t("pages.seller_products.5e121497");
    if (!f.redemption_instructions.trim()) errs.redemption_instructions = t("pages.seller_products.c164cc8c");
  }
  if (f.product_type === "ticket") {
    if (!f.event_name.trim()) errs.event_name = t("pages.seller_products.018096b9");
    if (!f.event_starts_at) errs.event_starts_at = t("pages.seller_products.d1343da5");
    if (!f.venue_name.trim()) errs.venue_name = t("pages.seller_products.c2e0fc70");
    if (!f.entry_instructions.trim()) errs.entry_instructions = t("pages.seller_products.069b556b");
    if (f.event_ends_at && f.event_starts_at && new Date(f.event_ends_at).getTime() <= new Date(f.event_starts_at).getTime()) errs.event_ends_at = t("pages.seller_products.cce60aad");
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
        <label htmlFor="product-type">{t("pages.seller_products.419b01c2")}</label>
        <select id="product-type" data-testid="product-type" value={f.product_type} disabled={lockType || busy} onChange={(e) => set({ product_type: e.target.value as ProductType })}>
          <option value="physical_product">{t("pages.seller_products.8479bde7")}</option>
          <option value="voucher">{t("pages.seller_products.a3a06e68")}</option>
          <option value="ticket">{t("pages.seller_products.d83a090b")}</option>
        </select>
        <span className="hint">{lockType ? t("pages.seller_products.92cfdada") : t("pages.seller_products.c4081c7b")}</span>
      </div>
      <div className="field">
        <label htmlFor="f-name">{t("pages.seller_products.adedbbfc")} <span className="req">*</span></label>
        <input {...attention(errors, "name")} data-testid="product-name" value={f.name} maxLength={200} disabled={busy} onChange={(e) => set({ name: e.target.value })} placeholder={t("pages.seller_products.759b4106")} />
        <FieldError msg={errors.name} />
      </div>
      <div className="field">
        <label htmlFor="f-short_description">{t("pages.seller_products.5b561b20")} <span className="req">*</span> <span className="hint">{t("pages.seller_products.4a4852ff")}</span></label>
        <input {...attention(errors, "short_description")} data-testid="product-short" value={f.short_description} maxLength={200} disabled={busy} onChange={(e) => set({ short_description: e.target.value })} />
        <FieldError msg={errors.short_description} />
      </div>
      <div className="field">
        <label htmlFor="f-long_description">{t("pages.seller_products.4dc3b47c")} <span className="hint">{t("pages.seller_products.9fbd1f49")}</span></label>
        <textarea id="f-long_description" data-testid="product-long" rows={5} value={f.long_description} maxLength={4000} disabled={busy} onChange={(e) => set({ long_description: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="f-category">{t("pages.seller_products.b593ae97")} <span className="hint">{t("pages.seller_products.e810ed27")}</span></label>
        <input id="f-category" data-testid="product-category" value={f.category} maxLength={160} disabled={busy} onChange={(e) => set({ category: e.target.value })} placeholder={t("pages.seller_products.8afd2149")} />
      </div>

      {f.product_type === "physical_product" ? (
        <>
          <div className="field-row">
            <div className="field"><label htmlFor="f-weight_grams">{t("pages.seller_products.b6d187de")}</label><input {...attention(errors, "weight_grams")} dir="ltr" type="number" min={1} value={f.weight_grams} disabled={busy} onChange={(e) => set({ weight_grams: e.target.value })} /><FieldError msg={errors.weight_grams} /></div>
            <div className="field"><label htmlFor="f-dimensions">{t("pages.seller_products.3c066d8a")}</label><input id="f-dimensions" value={f.dimensions} maxLength={160} disabled={busy} onChange={(e) => set({ dimensions: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-color">{t("pages.seller_products.be49d01c")}</label><input id="f-color" value={f.color} maxLength={120} disabled={busy} onChange={(e) => set({ color: e.target.value })} /></div>
            <div className="field"><label htmlFor="f-size">{t("pages.seller_products.a4617429")}</label><input id="f-size" value={f.size} maxLength={120} disabled={busy} onChange={(e) => set({ size: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="f-stock_note">{t("pages.seller_products.28456b54")} <span className="hint">{t("pages.seller_products.a3dfbd00")}</span></label><input id="f-stock_note" value={f.stock_note} maxLength={300} disabled={busy} onChange={(e) => set({ stock_note: e.target.value })} /></div>
        </>
      ) : null}

      {f.product_type === "voucher" ? (
        <>
          <div className="field"><label htmlFor="f-redemption_location">{t("pages.seller_products.2461095e")} <span className="req">*</span></label><input {...attention(errors, "redemption_location")} data-testid="product-voucher-location" value={f.redemption_location} maxLength={500} disabled={busy} onChange={(e) => set({ redemption_location: e.target.value })} /><FieldError msg={errors.redemption_location} /></div>
          <div className="field"><label htmlFor="f-redemption_instructions">{t("pages.seller_products.119fefce")} <span className="req">*</span></label><textarea {...attention(errors, "redemption_instructions")} data-testid="product-voucher-instructions" rows={3} value={f.redemption_instructions} maxLength={1000} disabled={busy} onChange={(e) => set({ redemption_instructions: e.target.value })} /><FieldError msg={errors.redemption_instructions} /></div>
          <div className="field"><label htmlFor="f-usage_restrictions">{t("pages.seller_products.c6d02b8f")}</label><textarea id="f-usage_restrictions" rows={3} value={f.usage_restrictions} maxLength={2000} disabled={busy} onChange={(e) => set({ usage_restrictions: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-valid_until">{t("pages.seller_products.03baa387")} <span className="hint">{t("pages.seller_products.ccaa8b7e")}</span></label><input id="f-valid_until" dir="ltr" type="date" value={f.valid_until} disabled={busy} onChange={(e) => set({ valid_until: e.target.value })} /></div>
        </>
      ) : null}

      {f.product_type === "ticket" ? (
        <>
          <div className="field"><label htmlFor="f-event_name">{t("pages.seller_products.1acb417f")} <span className="req">*</span></label><input {...attention(errors, "event_name")} data-testid="product-ticket-event" value={f.event_name} maxLength={200} disabled={busy} onChange={(e) => set({ event_name: e.target.value })} /><FieldError msg={errors.event_name} /></div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-event_starts_at">{t("pages.seller_products.2ac887ba")} <span className="req">*</span></label><input {...attention(errors, "event_starts_at")} dir="ltr" type="datetime-local" value={f.event_starts_at} disabled={busy} onChange={(e) => set({ event_starts_at: e.target.value })} /><FieldError msg={errors.event_starts_at} /></div>
            <div className="field"><label htmlFor="f-event_ends_at">{t("pages.seller_products.341ea200")}</label><input {...attention(errors, "event_ends_at")} dir="ltr" type="datetime-local" value={f.event_ends_at} disabled={busy} onChange={(e) => set({ event_ends_at: e.target.value })} /><FieldError msg={errors.event_ends_at} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-venue_name">{t("pages.seller_products.acc2a875")} <span className="req">*</span></label><input {...attention(errors, "venue_name")} value={f.venue_name} maxLength={200} disabled={busy} onChange={(e) => set({ venue_name: e.target.value })} /><FieldError msg={errors.venue_name} /></div>
            <div className="field"><label htmlFor="f-venue_city">{t("pages.seller_products.b2136c90")}</label><input id="f-venue_city" value={f.venue_city} maxLength={100} disabled={busy} onChange={(e) => set({ venue_city: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="f-venue_address">{t("pages.seller_products.daab1ad0")}</label><input id="f-venue_address" value={f.venue_address} maxLength={300} disabled={busy} onChange={(e) => set({ venue_address: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-entry_instructions">{t("pages.seller_products.21a635a8")} <span className="req">*</span></label><textarea {...attention(errors, "entry_instructions")} rows={3} value={f.entry_instructions} maxLength={1000} disabled={busy} onChange={(e) => set({ entry_instructions: e.target.value })} /><FieldError msg={errors.entry_instructions} /></div>
        </>
      ) : null}

      <div className="field">
        <label>{t("pages.seller_products.7115a7f8")} <span className="hint">{t("pages.seller_products.28b1adb1")}</span></label>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <input {...attention(errors, "est")} data-testid="product-est-min" dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 110 }} value={f.est_min} disabled={busy} onChange={(e) => set({ est_min: e.target.value })} aria-label={t("pages.seller_products.8a7a1302")} />
          <span>{t("pages.seller_products.344c1d0e")}</span>
          <input data-testid="product-est-max" dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 110 }} value={f.est_max} disabled={busy} onChange={(e) => set({ est_max: e.target.value })} aria-label={t("pages.seller_products.4b28237d")} />
        </div>
        <FieldError msg={errors.est} />
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" data-testid="product-save" disabled={busy} onClick={() => void submit()}>{busy ? t("pages.seller_products.cafc2ef5") : submitLabel}</button>
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
      showToast(next === "archived" ? t("pages.seller_products.792f4ea1") : t("pages.seller_products.5157e559"));
      await load();
    } catch (e: any) { showToast(e.message || t("pages.seller_products.d11a2bcd")); }
  };

  if (error) return <EmptyState title={t("pages.seller_products.ae947af7")} body={error} />;
  if (!rows) return <BrandLoader label={t("pages.seller_products.585bb1d3")} minHeight={320} />;

  return (
    <div data-testid="product-library">
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("pages.seller_products.227cf122")}</a>
      <div className="dash-head">
        <div>
          <h1>{t("pages.seller_products.4e0999e0")}</h1>
          <span className="dash-updated">{t("pages.seller_products.ad7dbf35")}</span>
        </div>
        <div className="row" style={{ marginInlineStart: "auto" }}>
          <button className="btn btn-primary" data-testid="product-new" onClick={() => navigate("#/seller/products/new")}>{t("pages.seller_products.f1aa5e5e")}</button>
        </div>
      </div>

      <div className="panel product-library-controls" data-testid="product-library-controls">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input data-testid="product-search" style={{ flex: "2 1 220px" }} value={filters.query || ""} onChange={(e) => setFilters({ ...filters, query: e.target.value })} placeholder={t("pages.seller_products.19ff751e")} aria-label={t("pages.seller_products.dbecfc28")} />
          <select data-testid="product-status-filter" style={{ flex: "1 1 130px" }} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label={t("pages.seller_products.c184d0ed")}>
            <option value="active">{t("pages.seller_products.17127579")}</option>
            <option value="archived">{t("pages.seller_products.e61abceb")}</option>
            <option value="all">{t("pages.seller_products.d0940366")}</option>
          </select>
          <select data-testid="product-type-filter" style={{ flex: "1 1 130px" }} value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} aria-label={t("pages.seller_products.f45000d5")}>
            <option value="">{t("pages.seller_products.49c19a2a")}</option>
            <option value="physical_product">{t("pages.seller_products.8479bde7")}</option>
            <option value="voucher">{t("pages.seller_products.a3a06e68")}</option>
            <option value="ticket">{t("pages.seller_products.d83a090b")}</option>
          </select>
          <select data-testid="product-sort" style={{ flex: "1 1 130px" }} value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} aria-label={t("pages.seller_products.1df7e5cb")}>
            <option value="updated">{t("pages.seller_products.58093ce9")}</option>
            <option value="deals">{t("pages.seller_products.dc0608b0")}</option>
            <option value="name">{t("pages.seller_products.51e36e5e")}</option>
          </select>
        </div>
      </div>

      {emptyKind === "library-empty" ? (
        <EmptyState title={t("pages.seller_products.2da27f1c")} body={t("pages.seller_products.7ee5f93a")}
          action={<button className="btn btn-primary" onClick={() => navigate("#/seller/products/new")}>{t("pages.seller_products.f1aa5e5e")}</button>} />
      ) : emptyKind === "search-empty" ? (
        <EmptyState title={t("pages.seller_products.8daabb8b")} body={t("pages.seller_products.523fd23f")} action={<button className="btn btn-ghost" onClick={() => setFilters({ ...filters, query: "" })}>{t("pages.seller_products.642ebf84")}</button>} />
      ) : emptyKind === "filter-empty" ? (
        <EmptyState title={t("pages.seller_products.e4581610")} body={t("pages.seller_products.9f9450d2")} action={<button className="btn btn-ghost" onClick={() => setFilters({ query: filters.query, status: "all", type: "", sort: filters.sort })}>{t("pages.seller_products.35683f55")}</button>} />
      ) : (
        <div className="sd-grid" data-testid="product-grid">
          {visible.map((p: any) => (
            <div className="sd-card product-library-card" key={p.product_id} data-testid="product-card" data-product-status={String(p.status)}>
              <div className="sd-top">
                <div className="sd-thumb">{p.primary_image_url ? <img src={p.primary_image_url} alt="" /> : <span className="sd-thumb-type">{dealTypeLabel(String(p.product_type || "physical_product"))}</span>}</div>
                <div className="grow">
                  <b>{p.name}</b>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className="muted small">{PRODUCT_TYPE_LABELS[String(p.product_type)] || dealTypeLabel(String(p.product_type))}</span>
                    {p.category ? <span className="muted small">· {p.category}</span> : null}
                    {String(p.status) === "archived" ? <span className="stale-badge">{t("pages.seller_products.e61abceb")}</span> : null}
                  </div>
                </div>
              </div>
              <div className="kv" style={{ margin: "10px 0" }}>
                <span className="k">{t("pages.seller_products.29f91e47")}</span><span className="v">{num(p.deals_count || 0)}</span>
                <span className="k">{t("pages.seller_products.d977983d")}</span><span className="v">{num(p.revision || 1)}</span>
                <span className="k">{t("pages.seller_products.9c743519")}</span><span className="v">{fmtDate(p.updated_at)}</span>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {String(p.status) === "archived"
                  ? <button className="btn btn-sm btn-primary" data-testid="product-restore-and-create" onClick={() => void toggleArchive(p).then(() => navigate(`#/seller/new?product=${p.product_id}`))}>{t("pages.seller_products.a3b85188")}</button>
                  : <button className="btn btn-sm btn-primary" data-testid="product-create-deal" onClick={() => navigate(`#/seller/new?product=${p.product_id}`)}>{t("pages.seller_products.5d9396f1")}</button>}
                <button className="btn btn-sm btn-ghost" data-testid="product-open" onClick={() => navigate(`#/seller/products/${p.product_id}`)}>{t("pages.seller_products.146735c0")}</button>
                <button className="btn btn-sm btn-ghost" data-testid="product-archive-toggle" onClick={() => void toggleArchive(p)}>{String(p.status) === "archived" ? t("pages.seller_products.ad349c23") : t("pages.seller_products.ba71513b")}</button>
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
      if (!id) throw new Error(t("pages.seller_products.8af22d59"));
      navigate(`#/seller/products/${id}`);
    } catch (e: any) { setError(e.message || t("pages.seller_products.1072e99d")); setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <a className="back" href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>{t("pages.seller_products.ddf57f31")}</a>
      <div className="panel">
        <h2>{t("pages.seller_products.31a0866a")}</h2>
        <p className="muted small">{t("pages.seller_products.2be62828")}</p>
        {error ? <div className="notice err">{error}</div> : null}
        <ProductForm initial={EMPTY_FORM} lockType={false} busy={busy} submitLabel={t("pages.seller_products.c50ebb26")} onSubmit={submit} />
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

  if (error) return <EmptyState title={t("pages.seller_products.3116ae3f")} body={error} action={<button className="btn btn-ghost" onClick={() => navigate("#/seller/products")}>{t("pages.seller_products.820d7c7e")}</button>} />;
  if (!product) return <BrandLoader label={t("pages.seller_products.28eb5686")} minHeight={320} />;

  const revision = Number(product.revision || 1);
  const deals: Json[] = product.deals || [];
  const archived = String(product.status) === "archived";
  const est = product.fulfillment_defaults || {};

  const save = async (payload: Json) => {
    setBusy(true);
    try {
      await api.updateProduct(productId, payload);
      showToast(t("pages.seller_products.821e82d0"));
      setEditing(false);
      await load();
    } catch (e: any) { showToast(e.message || t("pages.seller_products.1072e99d")); }
    setBusy(false);
  };
  const toggleArchive = async () => {
    setBusy(true);
    try {
      await api.updateProduct(productId, { status: archived ? "active" : "archived" });
      showToast(archived ? t("pages.seller_products.5157e559") : t("pages.seller_products.792f4ea1"));
      await load();
    } catch (e: any) { showToast(e.message || t("pages.seller_products.d11a2bcd")); }
    setBusy(false);
  };

  return (
    <div data-testid="product-detail">
      <a className="back" href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>{t("pages.seller_products.ddf57f31")}</a>
      <div className="panel">
        <div className="sd-top product-detail-header">
          <div className="sd-thumb">{product.images?.[0]?.url ? <img src={product.images[0].url} alt="" /> : <span className="sd-thumb-type">{dealTypeLabel(String(product.product_type || "physical_product"))}</span>}</div>
          <div className="grow">
            <h1 style={{ margin: 0, fontSize: "1.3rem" }} data-testid="product-title">{product.name}</h1>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="muted small">{PRODUCT_TYPE_LABELS[String(product.product_type)] || dealTypeLabel(String(product.product_type))}</span>
              {product.category ? <span className="muted small">· {product.category}</span> : null}
              <span className="muted small">{t("pages.seller_products.aefbf0df", { revision: num(revision) })}</span>
              {archived ? <span className="stale-badge">{t("pages.seller_products.e61abceb")}</span> : null}
            </div>
          </div>
        </div>
        {product.short_description ? <p style={{ marginTop: 12, fontWeight: 600 }}>{product.short_description}</p> : null}
        {product.long_description ? <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{product.long_description}</p> : null}
        {est.estimated_min_business_days != null || est.estimated_max_business_days != null ? (
          <p className="muted small">{t("pages.seller_products.7553e405", { v0: est.estimated_min_business_days ?? "?", v1: est.estimated_max_business_days ?? "?" })}</p>
        ) : null}
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {archived
            ? <button className="btn btn-primary" data-testid="product-restore-and-create" disabled={busy} onClick={() => void toggleArchive().then(() => navigate(`#/seller/new?product=${productId}`))}>{t("pages.seller_products.a3b85188")}</button>
            : <button className="btn btn-primary" data-testid="product-create-deal" disabled={busy} onClick={() => navigate(`#/seller/new?product=${productId}`)}>{t("pages.seller_products.5d9396f1")}</button>}
          {!editing ? <button className="btn btn-ghost" data-testid="product-edit-open" disabled={busy} onClick={() => setEditing(true)}>{t("pages.seller_products.ead9c5fd")}</button> : null}
          <button className="btn btn-ghost" data-testid="product-archive-toggle" disabled={busy} onClick={() => void toggleArchive()}>{archived ? t("pages.seller_products.5ae1346c") : t("pages.seller_products.ed0727e5")}</button>
        </div>
      </div>

      {editing ? (
        <div className="panel" data-testid="product-edit-panel">
          <div className="panel-title">{t("pages.seller_products.ead9c5fd")}</div>
          <div className="notice info">{t("pages.seller_products.5c8b6a50")}</div>
          <ProductForm initial={productToForm(product)} lockType busy={busy} submitLabel={t("pages.seller_products.71e2798e")} onSubmit={save} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>{t("pages.seller_products.a7c55a8d")}</button>
          </div>
        </div>
      ) : null}

      {product.images?.length ? (
        <div className="panel">
          <div className="panel-title">{t("pages.seller_products.24b1b3af")}</div>
          <div className="img-strip">
            {product.images.map((img: Json) => (
              <span key={img.product_image_id} className={`img-strip-thumb${img.is_primary ? " primary" : ""}`}><img src={img.url} alt="" />{img.is_primary ? <em>{t("pages.seller_products.7e35e511")}</em> : null}</span>
            ))}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>{t("pages.seller_products.b007845f")}</p>
        </div>
      ) : (
        <div className="panel"><div className="panel-title">{t("pages.seller_products.24b1b3af")}</div><p className="muted small" style={{ margin: 0 }}>{t("pages.seller_products.f4cae880")}</p></div>
      )}

      <div className="panel" data-testid="product-deal-history">
        <div className="panel-title">{t("pages.seller_products.29f91e47")} <span className="count">({deals.length})</span></div>
        {deals.length === 0 ? (
          <EmptyState title={t("pages.seller_products.53a1f9a0")} body={t("pages.seller_products.d8941c5a")}
            action={!archived ? <button className="btn btn-primary" onClick={() => navigate(`#/seller/new?product=${productId}`)}>{t("pages.seller_products.5d9396f1")}</button> : undefined} />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {deals.map((d) => {
              const rev = productDealRevisionStatus(d as any, revision);
              return (
                <div className="delivery-view-row product-history-row" key={String(d.deal_id)} data-testid="product-history-row" data-snapshot-status={rev.isCurrent ? "current" : rev.isHistorical ? "historical" : "unknown"}>
                  <span className="grow">
                    <a href={`#/seller/deal/${d.deal_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${d.deal_id}`); }}><b>{d.title}</b></a>
                    <span className="muted small"> {t("pages.seller_products.cacb7ae6", { price_per_unit: ils(d.price_per_unit), min_units: num(d.min_units), max_units: num(d.max_units), created_at: fmtDate(d.created_at) })}</span>
                    {rev.isHistorical ? <span className="muted small" data-testid="product-history-historical"> {t("pages.seller_products.90dc86cb", { snapshotRevision: rev.snapshotRevision ?? "", revision: revision })}</span> : null}
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
