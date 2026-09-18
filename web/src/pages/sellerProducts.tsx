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
import { t } from "../i18n/index.js";
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
  if (!f.name.trim()) errs.name = t("seller_products.enter_name_product");
  if (!f.short_description.trim()) errs.short_description = t("seller_products.enter_short_description_sentence_sells");
  const est = validateEstimateRange(f.est_min, f.est_max);
  if (est) errs.est = est;
  if (f.product_type === "physical_product" && f.weight_grams.trim() && !(Number(f.weight_grams) > 0)) errs.weight_grams = t("seller_products.the_weight_must_positive_number");
  if (f.product_type === "voucher") {
    if (!f.redemption_location.trim()) errs.redemption_location = t("seller_products.enter_redemption_place");
    if (!f.redemption_instructions.trim()) errs.redemption_instructions = t("seller_products.enter_redemption_instructions");
  }
  if (f.product_type === "ticket") {
    if (!f.event_name.trim()) errs.event_name = t("seller_products.enter_event_name");
    if (!f.event_starts_at) errs.event_starts_at = t("seller_products.choose_date_event");
    if (!f.venue_name.trim()) errs.venue_name = t("seller_products.enter_event_venue");
    if (!f.entry_instructions.trim()) errs.entry_instructions = t("seller_products.enter_entry_instructions");
    if (f.event_ends_at && f.event_starts_at && new Date(f.event_ends_at).getTime() <= new Date(f.event_starts_at).getTime()) errs.event_ends_at = t("seller_products.the_deadline_must_after_start");
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
        <label htmlFor="product-type">{t("seller_products.product_type")}</label>
        <select id="product-type" data-testid="product-type" value={f.product_type} disabled={lockType || busy} onChange={(e) => set({ product_type: e.target.value as ProductType })}>
          <option value="physical_product">{t("seller_products.physical_product")}</option>
          <option value="voucher">{t("seller_products.voucher")}</option>
          <option value="ticket">{t("seller_products.event_ticket")}</option>
        </select>
        <span className="hint">{lockType ? t("seller_products.the_product_type_set_creation") : t("seller_products.every_deal_created_product_type")}</span>
      </div>
      <div className="field">
        <label htmlFor="f-name">{t("seller_products.product_name")} <span className="req">*</span></label>
        <input {...attention(errors, "name")} data-testid="product-name" value={f.name} maxLength={200} disabled={busy} onChange={(e) => set({ name: e.target.value })} placeholder={t("seller_products.for_example_5_kg_pack")} />
        <FieldError msg={errors.name} />
      </div>
      <div className="field">
        <label htmlFor="f-short_description">{t("seller_products.short_description")} <span className="req">*</span> <span className="hint">{t("seller_products.up_200_characters")}</span></label>
        <input {...attention(errors, "short_description")} data-testid="product-short" value={f.short_description} maxLength={200} disabled={busy} onChange={(e) => set({ short_description: e.target.value })} />
        <FieldError msg={errors.short_description} />
      </div>
      <div className="field">
        <label htmlFor="f-long_description">{t("seller_products.full_description")} <span className="hint">{t("seller_products.optional")}</span></label>
        <textarea id="f-long_description" data-testid="product-long" rows={5} value={f.long_description} maxLength={4000} disabled={busy} onChange={(e) => set({ long_description: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="f-category">{t("seller_products.category")} <span className="hint">{t("seller_products.for_searching_library")}</span></label>
        <input id="f-category" data-testid="product-category" value={f.category} maxLength={160} disabled={busy} onChange={(e) => set({ category: e.target.value })} placeholder={t("seller_products.for_example_food_electronics_leisure")} />
      </div>

      {f.product_type === "physical_product" ? (
        <>
          <div className="field-row">
            <div className="field"><label htmlFor="f-weight_grams">{t("seller_products.weight_grams")}</label><input {...attention(errors, "weight_grams")} dir="ltr" type="number" min={1} value={f.weight_grams} disabled={busy} onChange={(e) => set({ weight_grams: e.target.value })} /><FieldError msg={errors.weight_grams} /></div>
            <div className="field"><label htmlFor="f-dimensions">{t("seller_products.dimensions")}</label><input id="f-dimensions" value={f.dimensions} maxLength={160} disabled={busy} onChange={(e) => set({ dimensions: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-color">{t("seller_products.colour")}</label><input id="f-color" value={f.color} maxLength={120} disabled={busy} onChange={(e) => set({ color: e.target.value })} /></div>
            <div className="field"><label htmlFor="f-size">{t("seller_products.size")}</label><input id="f-size" value={f.size} maxLength={120} disabled={busy} onChange={(e) => set({ size: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="f-stock_note">{t("seller_products.stock_note")} <span className="hint">{t("seller_products.internal")}</span></label><input id="f-stock_note" value={f.stock_note} maxLength={300} disabled={busy} onChange={(e) => set({ stock_note: e.target.value })} /></div>
        </>
      ) : null}

      {f.product_type === "voucher" ? (
        <>
          <div className="field"><label htmlFor="f-redemption_location">{t("seller_products.redemption_place")} <span className="req">*</span></label><input {...attention(errors, "redemption_location")} data-testid="product-voucher-location" value={f.redemption_location} maxLength={500} disabled={busy} onChange={(e) => set({ redemption_location: e.target.value })} /><FieldError msg={errors.redemption_location} /></div>
          <div className="field"><label htmlFor="f-redemption_instructions">{t("seller_products.redemption_instructions")} <span className="req">*</span></label><textarea {...attention(errors, "redemption_instructions")} data-testid="product-voucher-instructions" rows={3} value={f.redemption_instructions} maxLength={1000} disabled={busy} onChange={(e) => set({ redemption_instructions: e.target.value })} /><FieldError msg={errors.redemption_instructions} /></div>
          <div className="field"><label htmlFor="f-usage_restrictions">{t("seller_products.voucher_terms")}</label><textarea id="f-usage_restrictions" rows={3} value={f.usage_restrictions} maxLength={2000} disabled={busy} onChange={(e) => set({ usage_restrictions: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-valid_until">{t("seller_products.valid_until")} <span className="hint">{t("seller_products.the_default_deals")}</span></label><input id="f-valid_until" dir="ltr" type="date" value={f.valid_until} disabled={busy} onChange={(e) => set({ valid_until: e.target.value })} /></div>
        </>
      ) : null}

      {f.product_type === "ticket" ? (
        <>
          <div className="field"><label htmlFor="f-event_name">{t("seller_products.event_name")} <span className="req">*</span></label><input {...attention(errors, "event_name")} data-testid="product-ticket-event" value={f.event_name} maxLength={200} disabled={busy} onChange={(e) => set({ event_name: e.target.value })} /><FieldError msg={errors.event_name} /></div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-event_starts_at">{t("seller_products.starts")} <span className="req">*</span></label><input {...attention(errors, "event_starts_at")} dir="ltr" type="datetime-local" value={f.event_starts_at} disabled={busy} onChange={(e) => set({ event_starts_at: e.target.value })} /><FieldError msg={errors.event_starts_at} /></div>
            <div className="field"><label htmlFor="f-event_ends_at">{t("seller_products.ends")}</label><input {...attention(errors, "event_ends_at")} dir="ltr" type="datetime-local" value={f.event_ends_at} disabled={busy} onChange={(e) => set({ event_ends_at: e.target.value })} /><FieldError msg={errors.event_ends_at} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="f-venue_name">{t("seller_products.event_venue")} <span className="req">*</span></label><input {...attention(errors, "venue_name")} value={f.venue_name} maxLength={200} disabled={busy} onChange={(e) => set({ venue_name: e.target.value })} /><FieldError msg={errors.venue_name} /></div>
            <div className="field"><label htmlFor="f-venue_city">{t("seller_products.city")}</label><input id="f-venue_city" value={f.venue_city} maxLength={100} disabled={busy} onChange={(e) => set({ venue_city: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="f-venue_address">{t("seller_products.address")}</label><input id="f-venue_address" value={f.venue_address} maxLength={300} disabled={busy} onChange={(e) => set({ venue_address: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-entry_instructions">{t("seller_products.entry_instructions")} <span className="req">*</span></label><textarea {...attention(errors, "entry_instructions")} rows={3} value={f.entry_instructions} maxLength={1000} disabled={busy} onChange={(e) => set({ entry_instructions: e.target.value })} /><FieldError msg={errors.entry_instructions} /></div>
        </>
      ) : null}

      <div className="field">
        <label>{t("seller_products.estimated_delivery_time")} <span className="hint">{t("seller_products.business_days_deal_completing_default")}</span></label>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <input {...attention(errors, "est")} data-testid="product-est-min" dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 110 }} value={f.est_min} disabled={busy} onChange={(e) => set({ est_min: e.target.value })} aria-label={t("seller_products.minimum_business_days")} />
          <span>{t("seller_products.until")}</span>
          <input data-testid="product-est-max" dir="ltr" type="number" min={0} max={365} style={{ maxWidth: 110 }} value={f.est_max} disabled={busy} onChange={(e) => set({ est_max: e.target.value })} aria-label={t("seller_products.maximum_business_days")} />
        </div>
        <FieldError msg={errors.est} />
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" data-testid="product-save" disabled={busy} onClick={() => void submit()}>{busy ? t("seller_products.saving") : submitLabel}</button>
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
      showToast(next === "archived" ? t("seller_products.the_product_archived") : t("seller_products.the_product_restored_library"));
      await load();
    } catch (e: any) { showToast(e.message || t("seller_products.the_action_failed")); }
  };

  if (error) return <EmptyState title={t("seller_products.the_product_library_cannot_loaded")} body={error} />;
  if (!rows) return <BrandLoader label={t("seller_products.loading_product_library")} minHeight={320} />;

  return (
    <div data-testid="product-library">
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("seller_products.to_dashboard")}</a>
      <div className="dash-head">
        <div>
          <h1>{t("seller_products.my_product_library")}</h1>
          <span className="dash-updated">{t("seller_products.one_product_many_deals_deal")}</span>
        </div>
        <div className="row" style={{ marginInlineStart: "auto" }}>
          <button className="btn btn-primary" data-testid="product-new" onClick={() => navigate("#/seller/products/new")}>{t("seller_products.new_product_2")}</button>
        </div>
      </div>

      <div className="panel product-library-controls" data-testid="product-library-controls">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input data-testid="product-search" style={{ flex: "2 1 220px" }} value={filters.query || ""} onChange={(e) => setFilters({ ...filters, query: e.target.value })} placeholder={t("seller_products.search_name_category")} aria-label={t("seller_products.find_product")} />
          <select data-testid="product-status-filter" style={{ flex: "1 1 130px" }} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label={t("seller_products.status")}>
            <option value="active">{t("seller_products.active")}</option>
            <option value="archived">{t("seller_products.archived")}</option>
            <option value="all">{t("seller_products.all")}</option>
          </select>
          <select data-testid="product-type-filter" style={{ flex: "1 1 130px" }} value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} aria-label={t("seller_products.type")}>
            <option value="">{t("seller_products.all_types")}</option>
            <option value="physical_product">{t("seller_products.physical_product")}</option>
            <option value="voucher">{t("seller_products.voucher")}</option>
            <option value="ticket">{t("seller_products.event_ticket")}</option>
          </select>
          <select data-testid="product-sort" style={{ flex: "1 1 130px" }} value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} aria-label={t("seller_products.sort")}>
            <option value="updated">{t("seller_products.last_updated")}</option>
            <option value="deals">{t("seller_products.most_deals")}</option>
            <option value="name">{t("seller_products.by_name")}</option>
          </select>
        </div>
      </div>

      {emptyKind === "library-empty" ? (
        <EmptyState title={t("seller_products.no_products_library_yet")} body={t("seller_products.add_one_product_create_deals")}
          action={<button className="btn btn-primary" onClick={() => navigate("#/seller/products/new")}>{t("seller_products.new_product_2")}</button>} />
      ) : emptyKind === "search-empty" ? (
        <EmptyState title={t("seller_products.no_products_found_search")} body={t("seller_products.try_another_word_clear_search")} action={<button className="btn btn-ghost" onClick={() => setFilters({ ...filters, query: "" })}>{t("seller_products.clear_search")}</button>} />
      ) : emptyKind === "filter-empty" ? (
        <EmptyState title={t("seller_products.no_products_match_filter")} body={t("seller_products.change_status_product_type")} action={<button className="btn btn-ghost" onClick={() => setFilters({ query: filters.query, status: "all", type: "", sort: filters.sort })}>{t("seller_products.show_all")}</button>} />
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
                    {String(p.status) === "archived" ? <span className="stale-badge">{t("seller_products.archived")}</span> : null}
                  </div>
                </div>
              </div>
              <div className="kv" style={{ margin: "10px 0" }}>
                <span className="k">{t("seller_products.deals_product")}</span><span className="v">{num(p.deals_count || 0)}</span>
                <span className="k">{t("seller_products.revision")}</span><span className="v">{num(p.revision || 1)}</span>
                <span className="k">{t("seller_products.updated")}</span><span className="v">{fmtDate(p.updated_at)}</span>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {String(p.status) === "archived"
                  ? <button className="btn btn-sm btn-primary" data-testid="product-restore-and-create" onClick={() => void toggleArchive(p).then(() => navigate(`#/seller/new?product=${p.product_id}`))}>{t("seller_products.restore_create_deal")}</button>
                  : <button className="btn btn-sm btn-primary" data-testid="product-create-deal" onClick={() => navigate(`#/seller/new?product=${p.product_id}`)}>{t("seller_products.create_deal_product")}</button>}
                <button className="btn btn-sm btn-ghost" data-testid="product-open" onClick={() => navigate(`#/seller/products/${p.product_id}`)}>{t("seller_products.details_editing")}</button>
                <button className="btn btn-sm btn-ghost" data-testid="product-archive-toggle" onClick={() => void toggleArchive(p)}>{String(p.status) === "archived" ? t("seller_products.restore") : t("seller_products.archive")}</button>
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
      if (!id) throw new Error(t("seller_products.creating_product_failed_try_again"));
      navigate(`#/seller/products/${id}`);
    } catch (e: any) { setError(e.message || t("seller_products.saving_failed")); setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <a className="back" href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>{t("seller_products.to_product_library_2")}</a>
      <div className="panel">
        <h2>{t("seller_products.new_product")}</h2>
        <p className="muted small">{t("seller_products.the_product_fixed_description_price")}</p>
        {error ? <div className="notice err">{error}</div> : null}
        <ProductForm initial={EMPTY_FORM} lockType={false} busy={busy} submitLabel={t("seller_products.save_product")} onSubmit={submit} />
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

  if (error) return <EmptyState title={t("seller_products.the_product_cannot_loaded")} body={error} action={<button className="btn btn-ghost" onClick={() => navigate("#/seller/products")}>{t("seller_products.to_product_library")}</button>} />;
  if (!product) return <BrandLoader label={t("seller_products.loading_product")} minHeight={320} />;

  const revision = Number(product.revision || 1);
  const deals: Json[] = product.deals || [];
  const archived = String(product.status) === "archived";
  const est = product.fulfillment_defaults || {};

  const save = async (payload: Json) => {
    setBusy(true);
    try {
      await api.updateProduct(productId, payload);
      showToast(t("seller_products.the_product_updated_new_revision"));
      setEditing(false);
      await load();
    } catch (e: any) { showToast(e.message || t("seller_products.saving_failed")); }
    setBusy(false);
  };
  const toggleArchive = async () => {
    setBusy(true);
    try {
      await api.updateProduct(productId, { status: archived ? "active" : "archived" });
      showToast(archived ? t("seller_products.the_product_restored_library") : t("seller_products.the_product_archived"));
      await load();
    } catch (e: any) { showToast(e.message || t("seller_products.the_action_failed")); }
    setBusy(false);
  };

  return (
    <div data-testid="product-detail">
      <a className="back" href="#/seller/products" onClick={(e) => { e.preventDefault(); navigate("#/seller/products"); }}>{t("seller_products.to_product_library_2")}</a>
      <div className="panel">
        <div className="sd-top product-detail-header">
          <div className="sd-thumb">{product.images?.[0]?.url ? <img src={product.images[0].url} alt="" /> : <span className="sd-thumb-type">{dealTypeLabel(String(product.product_type || "physical_product"))}</span>}</div>
          <div className="grow">
            <h1 style={{ margin: 0, fontSize: "1.3rem" }} data-testid="product-title">{product.name}</h1>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="muted small">{PRODUCT_TYPE_LABELS[String(product.product_type)] || dealTypeLabel(String(product.product_type))}</span>
              {product.category ? <span className="muted small">· {product.category}</span> : null}
              <span className="muted small">{t("seller_products.revision_revision", { revision: num(revision) })}</span>
              {archived ? <span className="stale-badge">{t("seller_products.archived")}</span> : null}
            </div>
          </div>
        </div>
        {product.short_description ? <p style={{ marginTop: 12, fontWeight: 600 }}>{product.short_description}</p> : null}
        {product.long_description ? <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{product.long_description}</p> : null}
        {est.estimated_min_business_days != null || est.estimated_max_business_days != null ? (
          <p className="muted small">{t("seller_products.estimated_delivery_time_default_v0", { v0: est.estimated_min_business_days ?? "?", v1: est.estimated_max_business_days ?? "?" })}</p>
        ) : null}
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {archived
            ? <button className="btn btn-primary" data-testid="product-restore-and-create" disabled={busy} onClick={() => void toggleArchive().then(() => navigate(`#/seller/new?product=${productId}`))}>{t("seller_products.restore_create_deal")}</button>
            : <button className="btn btn-primary" data-testid="product-create-deal" disabled={busy} onClick={() => navigate(`#/seller/new?product=${productId}`)}>{t("seller_products.create_deal_product")}</button>}
          {!editing ? <button className="btn btn-ghost" data-testid="product-edit-open" disabled={busy} onClick={() => setEditing(true)}>{t("seller_products.edit_product")}</button> : null}
          <button className="btn btn-ghost" data-testid="product-archive-toggle" disabled={busy} onClick={() => void toggleArchive()}>{archived ? t("seller_products.restore_archive") : t("seller_products.move_archive")}</button>
        </div>
      </div>

      {editing ? (
        <div className="panel" data-testid="product-edit-panel">
          <div className="panel-title">{t("seller_products.edit_product")}</div>
          <div className="notice info">{t("seller_products.every_save_creates_new_revision")}</div>
          <ProductForm initial={productToForm(product)} lockType busy={busy} submitLabel={t("seller_products.save_new_revision")} onSubmit={save} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>{t("seller_products.cancel")}</button>
          </div>
        </div>
      ) : null}

      {product.images?.length ? (
        <div className="panel">
          <div className="panel-title">{t("seller_products.the_product_s_images")}</div>
          <div className="img-strip">
            {product.images.map((img: Json) => (
              <span key={img.product_image_id} className={`img-strip-thumb${img.is_primary ? " primary" : ""}`}><img src={img.url} alt="" />{img.is_primary ? <em>{t("seller_products.main")}</em> : null}</span>
            ))}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>{t("seller_products.the_images_copied_into_every")}</p>
        </div>
      ) : (
        <div className="panel"><div className="panel-title">{t("seller_products.the_product_s_images")}</div><p className="muted small" style={{ margin: 0 }}>{t("seller_products.the_product_images_yet_they")}</p></div>
      )}

      <div className="panel" data-testid="product-deal-history">
        <div className="panel-title">{t("seller_products.deals_product")} <span className="count">({deals.length})</span></div>
        {deals.length === 0 ? (
          <EmptyState title={t("seller_products.no_deals_been_created_product")} body={t("seller_products.create_first_deal_price_quantities")}
            action={!archived ? <button className="btn btn-primary" onClick={() => navigate(`#/seller/new?product=${productId}`)}>{t("seller_products.create_deal_product")}</button> : undefined} />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {deals.map((d) => {
              const rev = productDealRevisionStatus(d as any, revision);
              return (
                <div className="delivery-view-row product-history-row" key={String(d.deal_id)} data-testid="product-history-row" data-snapshot-status={rev.isCurrent ? "current" : rev.isHistorical ? "historical" : "unknown"}>
                  <span className="grow">
                    <a href={`#/seller/deal/${d.deal_id}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${d.deal_id}`); }}><b>{d.title}</b></a>
                    <span className="muted small"> {t("seller_products.price_per_unit_min_units", { price_per_unit: ils(d.price_per_unit), min_units: num(d.min_units), max_units: num(d.max_units), created_at: fmtDate(d.created_at) })}</span>
                    {rev.isHistorical ? <span className="muted small" data-testid="product-history-historical"> {t("seller_products.the_deal_published_revision_snapshotrevision", { snapshotRevision: rev.snapshotRevision ?? "", revision: revision })}</span> : null}
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
