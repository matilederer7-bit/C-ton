// ── ניהול תוכן האתר — the template-driven site editor ──────────────────────
//
// The owner picks a PAGE, sees its blocks in visual order as editor cards, and
// edits fields defined by the template library (web/src/content/cmsTemplates).
// Nothing here knows about JSON or the database: the forms are generated from
// the same schema the server validates with. Workflow: שמור טיוטה →
// תצוגה מקדימה → פרסם באתר. The public site keeps the last published page
// until publish succeeds; a stale revision is refused by the server (409) and
// surfaced here instead of silently overwriting another admin's work.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { productRequest as request, type Json } from "../api";
import { BRAND_LOGO_URL } from "../config";
import { IMAGE_ACCEPT, VIDEO_ACCEPT, uploadImageAsset, uploadVideoAsset } from "../contentAssets";
import { SITE_CONTENT_UPDATED_EVENT } from "../siteContent";
import {
  TEMPLATES, contractFor, describeValidationError, emptyBlock, emptyItem, newBlockId, normalizePage, validatePage,
  type Block, type FieldDef, type PageContent, type PageContract, type TemplateId
} from "../content/cmsTemplates";

type Section = {
  label: string; description: string; contract: PageContract;
  published: PageContent; draft: PageContent | null; revision: number;
  updated_at: string | null; updated_by: string | null; draft_updated_at: string | null; draft_updated_by: string | null; published_at: string | null;
};
type Message = { tone: "ok" | "err" | "info"; text: string } | null;

const LOAD_ERROR = "לא ניתן לטעון את התוכן כרגע. נסו לרענן את העמוד.";
const CONFLICT = "התוכן עודכן בידי מנהל אחר. רעננו את העמוד לפני השמירה.";
const PAGE_ORDER = ["home", "deal_page", "seller_area", "support_page", "about", "footer"];
// Product surfaces have no standalone public URL that shows their copy to an
// admin (a deal page needs a deal, the seller dashboard needs a seller). They
// preview INSIDE the editor instead of opening a tab that would not show them.
const IN_EDITOR_PREVIEW = new Set(["deal_page", "seller_area"]);

function toSection(key: string, raw: Json): Section {
  const base = contractFor(key);
  const contract: PageContract = raw?.contract ? { ...base, label: raw.label || base.label, description: raw.description || base.description, locked: raw.contract.locked || base.locked, addable: raw.contract.addable || base.addable, maxBlocks: raw.contract.maxBlocks || base.maxBlocks } : base;
  const published = normalizePage(raw?.published ?? raw?.value, contract);
  return {
    label: raw?.label || contract.label, description: raw?.description || contract.description, contract,
    published, draft: raw?.draft ? normalizePage(raw.draft, contract) : null, revision: Number(raw?.revision || 0),
    updated_at: raw?.updated_at || null, updated_by: raw?.updated_by || null, draft_updated_at: raw?.draft_updated_at || null, draft_updated_by: raw?.draft_updated_by || null, published_at: raw?.published_at || null
  };
}
function toSections(raw: Json): Record<string, Section> {
  const entries = Object.entries(raw || {}).map(([key, value]) => [key, toSection(key, value as Json)] as const);
  entries.sort(([a], [b]) => (PAGE_ORDER.indexOf(a) + 1 || 99) - (PAGE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return Object.fromEntries(entries);
}
function previewHashFor(key: string): string {
  if (key === "home" || key === "footer") return "#/?cms_preview=1";
  if (key === "support_page") return "#/support?cms_preview=1";
  return `#/content/${key}?cms_preview=1`;
}
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("he-IL") : "";
const move = <T,>(list: T[], from: number, to: number): T[] => { if (to < 0 || to >= list.length) return list; const next = list.slice(); const [item] = next.splice(from, 1); next.splice(to, 0, item as T); return next; };

export function ContentAdmin() {
  const [sections, setSections] = useState<Record<string, Section>>({});
  const [key, setKey] = useState("home");
  const [working, setWorking] = useState<PageContent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [addType, setAddType] = useState<TemplateId | "">("");
  const [inlinePreview, setInlinePreview] = useState(false);
  // the revisions the server last returned — a save followed by a publish in one
  // click must send the NEW revision, not the one this render closed over
  const revisions = useRef<Record<string, number>>({});

  const adopt = (raw: Json, nextKey?: string) => {
    const next = toSections(raw);
    revisions.current = Object.fromEntries(Object.entries(next).map(([k, s]) => [k, s.revision]));
    setSections(next);
    const k = nextKey && next[nextKey] ? nextKey : next[key] ? key : Object.keys(next)[0] || "";
    if (!k) { setWorking(null); setMessage({ tone: "info", text: "אין כרגע אזורי תוכן לעריכה." }); return; }
    setKey(k); setWorking(next[k]!.draft || next[k]!.published); setDirty(false);
  };
  useEffect(() => { request("/api/admin/site-content", {}, "admin").then(r => adopt(r.sections || {}, "home")).catch(() => setMessage({ tone: "err", text: LOAD_ERROR })); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const section = sections[key];
  const contract = section?.contract;
  const choosePage = (k: string) => { if (busy || !sections[k]) return; if (dirty && !window.confirm("יש שינויים שלא נשמרו בעמוד הנוכחי. לעבור בלי לשמור?")) return; setKey(k); setWorking(sections[k]!.draft || sections[k]!.published); setDirty(false); setMessage(null); setAddType(""); };
  const update = (fn: (page: PageContent) => PageContent) => { setWorking(p => p ? fn(p) : p); setDirty(true); };

  const mutate = async (path: string, method: "PUT" | "POST", body: Json, okText: string) => {
    if (!section) return null;
    setBusy(true); setMessage(null);
    try {
      const r = await request(path, { method, body: JSON.stringify({ ...body, revision: revisions.current[key] ?? section.revision }) }, "admin");
      adopt(r.sections || {}, key);
      window.dispatchEvent(new Event(SITE_CONTENT_UPDATED_EVENT));
      setMessage({ tone: "ok", text: okText });
      return r;
    } catch (e: any) {
      setMessage({ tone: "err", text: e.status === 409 ? (e.body?.error === "no_draft_to_publish" ? "אין טיוטה לפרסום — שמרו טיוטה תחילה." : e.body?.error === "draft_invalid" ? "הטיוטה השמורה אינה תקינה — תקנו ושמרו שוב לפני הפרסום." : CONFLICT) : e.body?.error && /content|block|item|template|field/.test(String(e.body.error)) ? describeValidationError({ code: e.body.error }) : e.message });
      return null;
    } finally { setBusy(false); }
  };
  const validateLocally = (): PageContent | null => {
    if (!working || !contract) return null;
    try { return validatePage(working, contract); } catch (err) { setMessage({ tone: "err", text: describeValidationError(err) }); return null; }
  };
  const saveDraft = async () => { const page = validateLocally(); if (!page) return null; return mutate(`/api/admin/site-content/${key}/draft`, "PUT", { value: page }, "הטיוטה נשמרה. האתר הציבורי לא השתנה עדיין."); };
  const preview = async () => {
    if (IN_EDITOR_PREVIEW.has(key)) {
      setInlinePreview(v => !v);
      setMessage({ tone: "info", text: inlinePreview ? "" : "התצוגה המקדימה מציגה את המשפטים כפי שהם מופיעים במסך עצמו." });
      return;
    }
    if (dirty) { const r = await saveDraft(); if (!r) return; }
    window.open(`${window.location.origin}${window.location.pathname}${previewHashFor(key)}`, "siton-cms-preview");
    setMessage({ tone: "info", text: "התצוגה המקדימה נפתחה בלשונית חדשה. היא מציגה את הטיוטה רק לכם." });
  };
  const publish = async () => {
    if (!section) return;
    if (dirty || !section.draft) { const page = validateLocally(); if (!page) return; const r = await mutate(`/api/admin/site-content/${key}/draft`, "PUT", { value: page }, ""); if (!r) return; }
    await mutate(`/api/admin/site-content/${key}/publish`, "POST", {}, "התוכן פורסם ומוצג באתר.");
  };
  const discard = async () => { if (!window.confirm("לבטל את הטיוטה ולחזור לתוכן שמפורסם באתר?")) return; await mutate(`/api/admin/site-content/${key}/discard`, "POST", {}, "הטיוטה בוטלה. מוצג התוכן המפורסם."); };

  const addable = contract?.addable || [];
  const canAdd = working && contract && working.blocks.length < contract.maxBlocks && addable.length > 0;
  const addBlock = () => { if (!working || !addType || !addable.includes(addType)) return; const block = emptyBlock(addType, newBlockId(addType, working.blocks)); update(p => ({ blocks: [...p.blocks, block] })); setAddType(""); };
  const lockedIds = useMemo(() => new Set((contract?.locked || []).map(l => l.id)), [contract]);
  const firstFree = contract?.locked.length || 0;

  return <div className="cms" data-testid="cms-admin">
    <h1>ניהול תוכן האתר</h1>
    <p className="muted">העיצוב קבוע; כאן עורכים את התוכן בתוך התבניות של Siton. שינויים נשמרים כטיוטה, נבדקים בתצוגה מקדימה ורק "פרסם באתר" משנה את מה שהגולשים רואים.</p>
    <div className="cms-pages" role="tablist" aria-label="בחירת עמוד">
      {Object.entries(sections).map(([k, s]) => <button key={k} type="button" role="tab" aria-selected={k === key} className={`chip${k === key ? " active" : ""}`} data-testid={`cms-page-${k}`} disabled={busy} onClick={() => choosePage(k)}>{s.label}{s.draft ? " · טיוטה" : ""}</button>)}
    </div>
    {section && working && contract ? <>
      <section className="panel cms-status" data-testid="cms-status" data-dirty={dirty ? "1" : "0"} data-has-draft={section.draft ? "1" : "0"}>
        <div className="cms-status-text">
          <b>{section.label}</b> <span className="muted small">{section.description}</span>
          <div className="small muted">{section.published_at || section.updated_at ? `פורסם: ${when(section.published_at || section.updated_at)}` : "מוצג התוכן המקורי של האתר"}{section.draft ? ` · טיוטה נשמרה: ${when(section.draft_updated_at)}` : ""}{dirty ? " · יש שינויים שלא נשמרו" : ""}</div>
        </div>
        <div className="cms-actions">
          <button type="button" className="btn btn-ghost btn-sm" data-testid="cms-save-draft" disabled={busy || !dirty} onClick={() => void saveDraft()}>שמור טיוטה</button>
          <button type="button" className="btn btn-ghost btn-sm" data-testid="cms-preview" disabled={busy} onClick={() => void preview()}>תצוגה מקדימה</button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="cms-publish" disabled={busy || (!dirty && !section.draft)} onClick={() => void publish()}>פרסם באתר</button>
          {section.draft || dirty ? <button type="button" className="btn btn-danger-ghost btn-sm" data-testid="cms-discard" disabled={busy} onClick={() => dirty && !section.draft ? (setWorking(section.published), setDirty(false)) : void discard()}>ביטול הטיוטה</button> : null}
        </div>
      </section>
      {inlinePreview && IN_EDITOR_PREVIEW.has(key) ? <CopyPreview page={working} /> : null}
      <div className="stack cms-blocks">
        {working.blocks.map((block, index) => {
          const locked = lockedIds.has(block.id);
          return <BlockCard key={block.id} block={block} index={index} locked={locked} busy={busy}
            canUp={!locked && index > firstFree} canDown={!locked && index < working.blocks.length - 1}
            onChange={next => update(p => ({ blocks: p.blocks.map(b => b.id === block.id ? next : b) }))}
            onMove={dir => update(p => ({ blocks: move(p.blocks, index, index + dir) }))}
            onRemove={() => { if (window.confirm(`להסיר את המקטע "${TEMPLATES[block.type].name}"?`)) update(p => ({ blocks: p.blocks.filter(b => b.id !== block.id) })); }}
            onMessage={text => setMessage({ tone: "err", text })} />;
        })}
      </div>
      {addable.length ? <section className="panel cms-add" data-testid="cms-add-block">
        <div className="panel-title">הוספת מקטע מהתבניות של Siton</div>
        <div className="row">
          <select aria-label="בחירת תבנית" value={addType} disabled={busy || !canAdd} onChange={e => setAddType(e.target.value as TemplateId)}>
            <option value="">בחרו תבנית…</option>
            {addable.map(t => <option key={t} value={t}>{TEMPLATES[t].name}</option>)}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" data-testid="cms-add-block-confirm" disabled={busy || !canAdd || !addType} onClick={addBlock}>הוספה</button>
        </div>
        {addType ? <p className="muted small">{TEMPLATES[addType].description}</p> : null}
        {!canAdd && working.blocks.length >= contract.maxBlocks ? <p className="muted small">העמוד הגיע למספר המקטעים המקסימלי ({contract.maxBlocks}).</p> : null}
      </section> : null}
    </> : null}
    <p role="status" data-testid="cms-message" className={message ? `notice ${message.tone}` : ""}>{message?.text || ""}</p>
  </div>;
}

// ── In-editor preview of the fixed product copy ────────────────────────────
// Shows the sentences the way the buyer / seller meets them on screen, so the
// owner can judge the wording in context before publishing.
function CopyPreview({ page }: { page: PageContent }) {
  const f = (id: string, name: string) => String(page.blocks.find(b => b.id === id)?.fields?.[name] || "");
  const steps = page.blocks.find(b => b.id === "how")?.items || [];
  const seller = page.blocks.find(b => b.id === "seller");
  return <section className="panel cms-copy-preview" data-testid="cms-copy-preview">
    <div className="panel-title">תצוגה מקדימה</div>
    {seller ? <div className="stack">
      <div className="notice info"><b>{f("seller", "pending_title")}</b> {f("seller", "pending_body")}</div>
      <div className="notice err"><b>{f("seller", "rejected_title")}</b> {f("seller", "rejected_body")} <a href="#/support">תמיכה</a></div>
      <div className="notice info"><b>{f("seller", "profile_incomplete_title")}</b></div>
      <div className="center" style={{ padding: 12 }}>
        <div style={{ fontSize: "2rem" }}>🏷️</div>
        <h3 style={{ marginTop: 6 }}>{f("seller", "empty_title")}</h3>
        <p className="muted">{f("seller", "empty_body")}</p>
        <span className="btn btn-primary btn-sm">{f("seller", "empty_cta")}</span>
      </div>
      <p className="muted small">כותרת ההכוונה: {f("seller", "journey_title")}</p>
    </div> : <div className="stack">
      <p className="deal-explainer">{f("deal", "explainer")}</p>
      <p className="muted small">{f("deal", "why_group_price")}</p>
      <p className="muted small">{f("deal", "after_tap")}</p>
      <div className="notice info">{f("deal", "hold_notice")}</div>
      <div><b>{f("how", "title")}</b>
        <ol className="how-strip">{steps.map((s, i) => <li className="how-step" key={i}><span className="how-n" aria-hidden="true">{i + 1}</span><div><b>{s.title}</b><p>{s.body}</p></div></li>)}</ol>
      </div>
      <p><b>{f("deal", "share_title")}</b></p>
      <div className="notice info">{f("track", "hold_note")}</div>
      <p><b>{f("track", "return_title")}</b></p>
      <p className="muted small">Empty States: {f("track", "no_access_title")} · {f("track", "network_title")} · {f("track", "busy_title")}</p>
    </div>}
  </section>;
}

function BlockCard({ block, index, locked, busy, canUp, canDown, onChange, onMove, onRemove, onMessage }: {
  block: Block; index: number; locked: boolean; busy: boolean; canUp: boolean; canDown: boolean;
  onChange: (b: Block) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void; onMessage: (text: string) => void;
}) {
  const t = TEMPLATES[block.type];
  const [open, setOpen] = useState(true);
  const setField = (name: string, value: string) => onChange({ ...block, fields: { ...block.fields, [name]: value } });
  const items = block.items || [];
  const setItems = (next: Record<string, string>[]) => onChange({ ...block, items: next });
  return <section className={`panel cms-block${block.enabled ? "" : " cms-block-off"}`} data-testid={`cms-block-${block.id}`} data-block-type={block.type} data-enabled={block.enabled ? "1" : "0"} data-position={index}>
    <div className="cms-block-head">
      <button type="button" className="cms-block-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "▾" : "▸"}</button>
      <div className="cms-block-title"><b>{t.name}</b>{locked ? <span className="chip cms-chip">קבוע</span> : null}{!block.enabled ? <span className="chip cms-chip">מוסתר</span> : null}</div>
      <div className="cms-block-tools">
        {!locked ? <label className="cms-switch"><input type="checkbox" data-testid={`cms-block-enabled-${block.id}`} checked={block.enabled} disabled={busy} onChange={e => onChange({ ...block, enabled: e.target.checked })} /> מוצג באתר</label> : null}
        <button type="button" className="btn btn-ghost btn-sm" aria-label="הזזה למעלה" data-testid={`cms-block-up-${block.id}`} disabled={busy || !canUp} onClick={() => onMove(-1)}>▲</button>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="הזזה למטה" data-testid={`cms-block-down-${block.id}`} disabled={busy || !canDown} onClick={() => onMove(1)}>▼</button>
        {!locked ? <button type="button" className="btn btn-danger-ghost btn-sm" data-testid={`cms-block-remove-${block.id}`} disabled={busy} onClick={onRemove}>הסרה</button> : null}
      </div>
    </div>
    {open ? <div className="cms-fields">
      {Object.entries(t.fields).map(([name, def]) => {
        if (def.showWhen && block.fields[def.showWhen.field] !== def.showWhen.value) return null;
        return <Field key={name} id={`cms-field-${block.id}-${name}`} def={def} value={block.fields[name] ?? ""} busy={busy} onChange={v => setField(name, v)} onMessage={onMessage} />;
      })}
      {t.items ? <div className="cms-items" data-testid={`cms-items-${block.id}`}>
        <div className="cms-items-head"><b>{t.items.label}</b> <span className="muted small">({items.length}/{t.items.max})</span></div>
        {items.map((item, i) => <div className="cms-item" key={i} data-testid={`cms-item-${block.id}-${i}`}>
          <div className="cms-item-tools">
            <span className="muted small">{i + 1}</span>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="הזזה למעלה" data-testid={`cms-item-up-${block.id}-${i}`} disabled={busy || i === 0} onClick={() => setItems(move(items, i, i - 1))}>▲</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="הזזה למטה" data-testid={`cms-item-down-${block.id}-${i}`} disabled={busy || i === items.length - 1} onClick={() => setItems(move(items, i, i + 1))}>▼</button>
            <button type="button" className="btn btn-danger-ghost btn-sm" data-testid={`cms-item-remove-${block.id}-${i}`} disabled={busy || items.length <= t.items!.min} onClick={() => setItems(items.filter((_, j) => j !== i))}>מחיקה</button>
          </div>
          {Object.entries(t.items!.fields).map(([name, def]) => <Field key={name} id={`cms-item-${block.id}-${i}-${name}`} def={def} value={item[name] ?? ""} busy={busy} onChange={v => setItems(items.map((it, j) => j === i ? { ...it, [name]: v } : it))} onMessage={onMessage} />)}
        </div>)}
        <button type="button" className="btn btn-ghost btn-sm" data-testid={`cms-item-add-${block.id}`} disabled={busy || items.length >= t.items.max} onClick={() => setItems([...items, emptyItem(block.type)])}>+ {t.items.addLabel}</button>
      </div> : null}
    </div> : null}
  </section>;
}

function Field({ id, def, value, busy, onChange, onMessage }: { id: string; def: FieldDef; value: string; busy: boolean; onChange: (v: string) => void; onMessage: (text: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const label = <span>{def.label}{def.required ? " *" : ""}{def.hint ? <span className="hint"> · {def.hint}</span> : null}</span>;
  if (def.kind === "image" || def.kind === "video") {
    const isVideo = def.kind === "video";
    const pick = async (file: File | undefined) => {
      if (!file) return;
      setUploading(true);
      try { const asset = isVideo ? await uploadVideoAsset(file) : await uploadImageAsset(file, "admin"); onChange(asset.url); }
      catch (err: any) { onMessage(err?.message || "ההעלאה נכשלה"); }
      finally { setUploading(false); }
    };
    return <div className="field cms-media" data-testid={id}>
      <label htmlFor={`${id}-file`}>{label}</label>
      {isVideo ? (value ? <video className="cms-media-preview" style={{ maxWidth: "100%", maxHeight: 220 }} src={value} muted playsInline controls preload="metadata" data-testid={`${id}-preview`} /> : <p className="muted small">לא נבחר וידאו — יוצג הלוגו עד שיועלה קובץ.</p>)
        : <img className="cms-media-preview" style={{ maxWidth: "100%", maxHeight: 220 }} src={value || BRAND_LOGO_URL} alt={value ? "התמונה הנוכחית" : "ברירת המחדל של האתר"} data-testid={`${id}-preview`} data-from-cms={value ? "1" : "0"} />}
      <div className="row">
        <input id={`${id}-file`} type="file" accept={isVideo ? VIDEO_ACCEPT : IMAGE_ACCEPT} disabled={busy || uploading} onChange={e => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        {value ? <button type="button" className="btn btn-ghost btn-sm" data-testid={`${id}-clear`} disabled={busy || uploading} onClick={() => onChange("")}>הסרה</button> : null}
        {uploading ? <span className="muted small">מעלים…</span> : null}
      </div>
    </div>;
  }
  if (def.kind === "select") {
    return <div className="field"><label htmlFor={id}>{label}</label>
      <select id={id} data-testid={id} value={value} disabled={busy} onChange={e => onChange(e.target.value)}>{(def.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
  }
  if (def.kind === "multiline") {
    return <div className="field"><label htmlFor={id}>{label}</label>
      <textarea id={id} data-testid={id} rows={def.rows || 4} maxLength={def.max} value={value} disabled={busy} onChange={e => onChange(e.target.value)} />
      <span className="hint">{value.length}/{def.max}</span></div>;
  }
  return <div className="field"><label htmlFor={id}>{label}</label>
    <input id={id} data-testid={id} type="text" dir={def.kind === "link" ? "ltr" : undefined} placeholder={def.kind === "link" ? "#/seller או https://…" : undefined} maxLength={def.max} value={value} disabled={busy} onChange={e => onChange(e.target.value)} /></div>;
}
