// Seller image management (P0.3).
//
// INPUT: any normal raster image up to 50MB. The browser decodes (orientation
// corrected), resizes to a sensible product resolution and compresses to
// WebP/JPEG BEFORE upload — giant originals are never shipped or stored.
// Failures are truthful Hebrew (never a stale "2MB" message).
//
// Two modes over one visual component:
//  * local  — pre-create staging inside the wizard
//  * server — canonical Draft-deal image management against the seller API
// The PRIMARY image is chosen with the star itself (★ active / ☆ inactive) —
// no reordering needed just to pick a primary.
import { useEffect, useRef, useState } from "react";
import { getSellerToken } from "./api";

export const IMAGE_SOURCE_MAX_BYTES = 50 * 1024 * 1024; // accepted INPUT cap
export const IMAGE_UPLOAD_TARGET_BYTES = 4 * 1024 * 1024; // optimized artifact cap
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_LIMIT = 12;
const TARGET_LONG_EDGE = 2560;

export type LocalImage = { id: string; name: string; mime: string; b64: string; previewUrl: string };
export type ServerImage = { image_id: string; url: string; is_primary: boolean; sort_order: number; mime_type?: string };

export function validateSourceImageFile(file: File): string | null {
  const mime = (file.type || "").toLowerCase();
  if (/hei[cf]/.test(mime) || /\.hei[cf]$/i.test(file.name)) {
    return `הקובץ ${file.name} הוא בפורמט HEIC — המירו אותו ל-JPG (בדרך כלל: שיתוף/ייצוא מהתמונות במכשיר) והעלו שוב`;
  }
  if (!IMAGE_MIME_TYPES.includes(mime)) return `סוג הקובץ ${file.name} אינו נתמך — רק JPG / PNG / WebP`;
  if (file.size > IMAGE_SOURCE_MAX_BYTES) return `הקובץ ${file.name} גדול מ-50MB — צלמו או ייצאו גרסה קטנה יותר`;
  if (file.size <= 0) return `הקובץ ${file.name} ריק`;
  return null;
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("קריאת התמונה נכשלה"));
    reader.onload = () => {
      const b64 = String(reader.result || "").split(",")[1] || "";
      b64 ? resolve(b64) : reject(new Error("קריאת התמונה נכשלה"));
    };
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

// Decode → orientation-correct → resize → compress. Returns the optimized
// upload artifact (small originals under ~1.5MB pass through untouched).
export async function optimizeImageFile(file: File): Promise<LocalImage> {
  const invalid = validateSourceImageFile(file);
  if (invalid) throw new Error(invalid);
  if (file.size <= 1_500_000) {
    const b64 = await blobToB64(file);
    return { id: crypto.randomUUID(), name: file.name, mime: (file.type || "image/jpeg").toLowerCase(), b64, previewUrl: URL.createObjectURL(file) };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as any);
  } catch {
    throw new Error(`עיבוד התמונה ${file.name} נכשל — ייתכן שהקובץ פגום או גדול מדי לזיכרון המכשיר`);
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, TARGET_LONG_EDGE / Math.max(1, longEdge));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("עיבוד התמונה נכשל — נסו דפדפן אחר");
    ctx.drawImage(bitmap, 0, 0, width, height);
    let blob: Blob | null = null;
    let mime = "image/webp";
    for (const quality of [0.86, 0.74, 0.62]) {
      blob = await canvasToBlob(canvas, "image/webp", quality);
      if (!blob) { mime = "image/jpeg"; blob = await canvasToBlob(canvas, "image/jpeg", quality); }
      if (blob && blob.size <= IMAGE_UPLOAD_TARGET_BYTES) break;
    }
    if (!blob) throw new Error(`דחיסת התמונה ${file.name} נכשלה — נסו קובץ אחר`);
    if (blob.size > IMAGE_UPLOAD_TARGET_BYTES) throw new Error(`התמונה ${file.name} גדולה מדי גם אחרי דחיסה — נסו גרסה קטנה יותר`);
    mime = blob.type || mime;
    const b64 = await blobToB64(blob);
    const baseName = file.name.replace(/\.[a-z0-9]+$/i, "");
    const ext = mime === "image/webp" ? "webp" : "jpg";
    return { id: crypto.randomUUID(), name: `${baseName}.${ext}`, mime, b64, previewUrl: URL.createObjectURL(blob) };
  } finally {
    bitmap.close?.();
  }
}

// Content hash for the upload idempotency key (length+prefix collided for
// same-size photos — every PNG shares the same base64 header).
function contentKey(b64: string): string {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 ^ c) >>> 0;
  }
  return `${b64.length.toString(36)}-${h1.toString(36)}${h2.toString(36)}`;
}

// XHR gives real upload progress (fetch cannot report it).
export function uploadDealImage(dealId: string, img: { name: string; mime: string; b64: string }, opts: { isPrimary?: boolean; sortOrder?: number; onProgress?: (pct: number) => void } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/seller/deals/${dealId}/images`);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("authorization", `Bearer ${getSellerToken()}`);
    xhr.setRequestHeader("idempotency-key", `img-${dealId}-${contentKey(img.b64)}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new Error("ההעלאה נכשלה — בדקו את החיבור ונסו שוב"));
    xhr.ontimeout = () => reject(new Error("ההעלאה נמשכה יותר מדי — נסו שוב"));
    xhr.onload = () => {
      let body: any = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* keep {} */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.message || body?.error || `ההעלאה נכשלה (${xhr.status})`));
    };
    xhr.timeout = 120_000;
    xhr.send(JSON.stringify({
      mime_type: img.mime,
      image_base64: img.b64,
      original_filename: img.name,
      ...(opts.isPrimary !== undefined ? { is_primary: opts.isPrimary } : {}),
      ...(opts.sortOrder !== undefined ? { sort_order: opts.sortOrder } : {})
    }));
  });
}

async function sellerReq(path: string, init: RequestInit = {}): Promise<any> {
  // JSON content-type only when a body is sent (bodyless DELETE otherwise 400s).
  const headers: Record<string, string> = { authorization: `Bearer ${getSellerToken()}`, ...(init.headers as any) };
  if (init.body != null) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || body?.error || `הפעולה נכשלה (${res.status})`);
  return body;
}

export const imageApi = {
  reorder: (dealId: string, orderedIds: string[], primaryId: string | null) =>
    sellerReq(`/api/seller/deals/${dealId}/images/order`, { method: "PATCH", body: JSON.stringify({ ordered_image_ids: orderedIds, primary_image_id: primaryId }) }),
  remove: (dealId: string, imageId: string) =>
    sellerReq(`/api/seller/deals/${dealId}/images/${imageId}`, { method: "DELETE" })
};

// The star IS the primary-image control (P0.3-17).
function PrimaryStar({ active, disabled, onSelect }: { active: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`img-star${active ? " active" : ""}`}
      aria-pressed={active}
      aria-label={active ? "תמונה ראשית" : "הגדר כתמונה ראשית"}
      title={active ? "תמונה ראשית" : "הגדר כתמונה ראשית"}
      disabled={disabled || active}
      onClick={onSelect}
    >
      {active ? "★" : "☆"}
    </button>
  );
}

// ── shared picker button (file picker; mobile browsers offer camera/library) ─
function PickButton({ disabled, onFiles, label }: { disabled?: boolean; onFiles: (files: File[]) => void; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={inputRef} type="file" accept={IMAGE_MIME_TYPES.join(",")} multiple hidden
        onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) onFiles(files); e.target.value = ""; }} />
      <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => inputRef.current?.click()}>{label}</button>
    </>
  );
}

function useDropZone(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true); },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault(); setOver(false);
        const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name));
        if (files.length) onFiles(files);
      }
    }
  };
}

// ── local mode (wizard) ─────────────────────────────────────────────────────
export function LocalImageManager({ images, onChange }: { images: LocalImage[]; onChange: (next: LocalImage[]) => void }) {
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState("");
  const dragIndex = useRef<number | null>(null);

  const addFiles = async (files: File[]) => {
    setError("");
    const room = IMAGE_LIMIT - images.length;
    if (files.length > room) setError(room <= 0 ? `אפשר עד ${IMAGE_LIMIT} תמונות` : `נוספו רק ${room} — אפשר עד ${IMAGE_LIMIT} תמונות`);
    const accepted: LocalImage[] = [];
    const batch = files.slice(0, Math.max(0, room));
    for (let i = 0; i < batch.length; i++) {
      setProcessing(`מעבדים תמונה ${i + 1} מתוך ${batch.length}…`);
      try { accepted.push(await optimizeImageFile(batch[i]!)); } catch (e: any) { setError(e.message); }
    }
    setProcessing("");
    if (accepted.length) onChange([...images, ...accepted]);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    const next = images.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };

  const drop = useDropZone(addFiles);

  return (
    <div className={`img-manager${drop.over ? " drop-over" : ""}`} {...drop.props}>
      {images.length ? (
        <div className="img-grid">
          {images.map((img, i) => (
            <div key={img.id} className={`img-card${i === 0 ? " primary" : ""}`} draggable
              onDragStart={() => { dragIndex.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragIndex.current !== null && dragIndex.current !== i) move(dragIndex.current, i); dragIndex.current = null; }}>
              <img src={img.previewUrl} alt={img.name} />
              <PrimaryStar active={i === 0} onSelect={() => move(i, 0)} />
              <div className="img-actions">
                <button type="button" title="הזז שמאלה" disabled={i === images.length - 1} onClick={() => move(i, i + 1)}>‹</button>
                <button type="button" title="הזז ימינה" disabled={i === 0} onClick={() => move(i, i - 1)}>›</button>
                <button type="button" className="danger" title="הסרה" onClick={() => { URL.revokeObjectURL(img.previewUrl); onChange(images.filter((x) => x.id !== img.id)); }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="img-empty">
          <span className="img-empty-icon">🖼️</span>
          <span>גררו תמונות לכאן או בחרו מהמכשיר</span>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <PickButton disabled={images.length >= IMAGE_LIMIT || Boolean(processing)} onFiles={addFiles} label={images.length ? "+ הוספת תמונות" : "בחירת תמונות"} />
        <span className="muted small">{images.length}/{IMAGE_LIMIT} · עד 50MB לתמונה (נדחסת אוטומטית) · ★ בוחר את התמונה הראשית</span>
      </div>
      {processing ? <div className="notice info" style={{ marginTop: 8 }}>{processing}</div> : null}
      {error ? <div className="notice err" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}

// ── server mode (Draft deal; arrangeOnly after publish) ─────────────────────
type PendingUpload = { id: string; name: string; previewUrl: string; pct: number; error: string; img: { name: string; mime: string; b64: string } };

export function DraftImageManager({ dealId, images, onChanged, arrangeOnly = false }: { dealId: string; images: ServerImage[]; onChanged: () => void; arrangeOnly?: boolean }) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState("");
  const [busy, setBusy] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const sorted = images.slice().sort((a, b) => a.sort_order - b.sort_order);

  useEffect(() => () => { pending.forEach((p) => URL.revokeObjectURL(p.previewUrl)); }, []);

  const startUpload = async (entry: PendingUpload) => {
    try {
      await uploadDealImage(dealId, entry.img, {
        onProgress: (pct) => setPending((prev) => prev.map((p) => p.id === entry.id ? { ...p, pct } : p))
      });
      URL.revokeObjectURL(entry.previewUrl);
      setPending((prev) => prev.filter((p) => p.id !== entry.id));
      onChanged();
    } catch (e: any) {
      setPending((prev) => prev.map((p) => p.id === entry.id ? { ...p, error: e.message || "ההעלאה נכשלה" } : p));
    }
  };

  const addFiles = async (files: File[]) => {
    setError("");
    const room = IMAGE_LIMIT - sorted.length - pending.length;
    if (files.length > room) setError(room <= 0 ? `אפשר עד ${IMAGE_LIMIT} תמונות` : `אפשר להוסיף עוד ${room} בלבד`);
    const batch = files.slice(0, Math.max(0, room));
    for (let i = 0; i < batch.length; i++) {
      setProcessing(`מעבדים תמונה ${i + 1} מתוך ${batch.length}…`);
      try {
        const local = await optimizeImageFile(batch[i]!);
        const entry: PendingUpload = { id: local.id, name: local.name, previewUrl: local.previewUrl, pct: 0, error: "", img: local };
        setPending((prev) => [...prev, entry]);
        void startUpload(entry);
      } catch (e: any) { setError(e.message); }
    }
    setProcessing("");
  };

  const commitOrder = async (orderedIds: string[], primaryId: string | null) => {
    setBusy(true); setError("");
    try { await imageApi.reorder(dealId, orderedIds, primaryId); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= sorted.length) return;
    const ids = sorted.map((x) => x.image_id);
    const [item] = ids.splice(from, 1);
    ids.splice(to, 0, item!);
    const primary = sorted.find((x) => x.is_primary)?.image_id || ids[0] || null;
    void commitOrder(ids, primary);
  };

  const drop = useDropZone(addFiles);

  return (
    <div className={`img-manager${drop.over ? " drop-over" : ""}`} {...drop.props}>
      {sorted.length || pending.length ? (
        <div className="img-grid">
          {sorted.map((img, i) => (
            <div key={img.image_id} className={`img-card${img.is_primary ? " primary" : ""}`} draggable={!busy}
              onDragStart={() => { dragIndex.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragIndex.current !== null && dragIndex.current !== i) move(dragIndex.current, i); dragIndex.current = null; }}>
              <img src={img.url} alt="" loading="lazy" />
              <PrimaryStar
                active={img.is_primary}
                disabled={busy}
                onSelect={() => commitOrder(sorted.map((x) => x.image_id), img.image_id)}
              />
              <div className="img-actions">
                <button type="button" disabled={busy || i === sorted.length - 1} title="הזז שמאלה" onClick={() => move(i, i + 1)}>‹</button>
                <button type="button" disabled={busy || i === 0} title="הזז ימינה" onClick={() => move(i, i - 1)}>›</button>
                {!arrangeOnly ? (
                  <button type="button" className="danger" disabled={busy} title="מחיקה" onClick={async () => {
                    setBusy(true); setError("");
                    try { await imageApi.remove(dealId, img.image_id); onChanged(); }
                    catch (e: any) { setError(e.message); }
                    finally { setBusy(false); }
                  }}>✕</button>
                ) : null}
              </div>
            </div>
          ))}
          {pending.map((p) => (
            <div key={p.id} className={`img-card uploading${p.error ? " failed" : ""}`}>
              <img src={p.previewUrl} alt={p.name} />
              {p.error ? (
                <div className="img-upload-overlay err">
                  <span className="small">{p.error}</span>
                  <div className="row" style={{ justifyContent: "center", gap: 6 }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setPending((prev) => prev.map((x) => x.id === p.id ? { ...x, error: "", pct: 0 } : x)); void startUpload(p); }}>נסו שוב</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => { URL.revokeObjectURL(p.previewUrl); setPending((prev) => prev.filter((x) => x.id !== p.id)); }}>הסרה</button>
                  </div>
                </div>
              ) : (
                <div className="img-upload-overlay">
                  <div className="img-progress"><div style={{ width: `${p.pct}%` }} /></div>
                  <span className="small">מעלים… {p.pct}%</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="img-empty">
          <span className="img-empty-icon">🖼️</span>
          <span>אין תמונות עדיין — גררו לכאן או בחרו מהמכשיר</span>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {!arrangeOnly ? <PickButton disabled={sorted.length + pending.length >= IMAGE_LIMIT || Boolean(processing)} onFiles={addFiles} label="+ הוספת תמונות" /> : null}
        <span className="muted small">
          {arrangeOnly
            ? "לאחר הפרסום אפשר לשנות סדר ולבחור תמונה ראשית (★); הוספה ומחיקה נעולות"
            : `${sorted.length + pending.length}/${IMAGE_LIMIT} · עד 50MB לתמונה (נדחסת אוטומטית) · ★ בוחר את התמונה הראשית`}
        </span>
      </div>
      {processing ? <div className="notice info" style={{ marginTop: 8 }}>{processing}</div> : null}
      {error ? <div className="notice err" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}
