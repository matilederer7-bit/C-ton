// R7 — seller image management.
//
// Two modes over one visual component:
//  * local  — pre-create staging inside the wizard (nothing on the server yet)
//  * server — canonical Draft-deal image management against the seller API
//    (upload with real progress, reorder, primary, delete, replace; the
//    server enforces ownership, Draft-only mutation, 5-image / 2MB limits)
import { useEffect, useRef, useState } from "react";
import { getSellerToken } from "./api";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_LIMIT = 5;

export type LocalImage = { id: string; name: string; mime: string; b64: string; previewUrl: string };
export type ServerImage = { image_id: string; url: string; is_primary: boolean; sort_order: number; mime_type?: string };

export function validateImageFile(file: File): string | null {
  const mime = (file.type || "").toLowerCase();
  if (!IMAGE_MIME_TYPES.includes(mime)) return `סוג הקובץ ${file.name} אינו נתמך — רק JPG / PNG / WebP`;
  if (file.size > IMAGE_MAX_BYTES) return `הקובץ ${file.name} גדול מדי (מקסימום 2MB)`;
  if (file.size <= 0) return `הקובץ ${file.name} ריק`;
  return null;
}

export function fileToLocalImage(file: File): Promise<LocalImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`קריאת ${file.name} נכשלה`));
    reader.onload = () => {
      const b64 = String(reader.result || "").split(",")[1] || "";
      if (!b64) { reject(new Error(`קריאת ${file.name} נכשלה`)); return; }
      resolve({ id: crypto.randomUUID(), name: file.name, mime: (file.type || "image/jpeg").toLowerCase(), b64, previewUrl: URL.createObjectURL(file) });
    };
    reader.readAsDataURL(file);
  });
}

// XHR gives real upload progress (fetch cannot report it).
export function uploadDealImage(dealId: string, img: { name: string; mime: string; b64: string }, opts: { isPrimary?: boolean; sortOrder?: number; onProgress?: (pct: number) => void } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/seller/deals/${dealId}/images`);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("authorization", `Bearer ${getSellerToken()}`);
    xhr.setRequestHeader("idempotency-key", `img-${dealId}-${img.b64.length}-${img.b64.slice(0, 24).replace(/[^a-zA-Z0-9]/g, "")}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new Error("העלאה נכשלה — בדקו את החיבור ונסו שוב"));
    xhr.ontimeout = () => reject(new Error("ההעלאה נמשכה יותר מדי — נסו שוב"));
    xhr.onload = () => {
      let body: any = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* keep {} */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.message || body?.error || `העלאה נכשלה (${xhr.status})`));
    };
    xhr.timeout = 60_000;
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
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${getSellerToken()}`, ...(init.headers as any) } });
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
        const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
        if (files.length) onFiles(files);
      }
    }
  };
}

// ── local mode (wizard) ─────────────────────────────────────────────────────
export function LocalImageManager({ images, onChange }: { images: LocalImage[]; onChange: (next: LocalImage[]) => void }) {
  const [error, setError] = useState("");
  const dragIndex = useRef<number | null>(null);

  const addFiles = async (files: File[]) => {
    setError("");
    const room = IMAGE_LIMIT - images.length;
    if (files.length > room) setError(room <= 0 ? `אפשר עד ${IMAGE_LIMIT} תמונות` : `נוספו רק ${room} — אפשר עד ${IMAGE_LIMIT} תמונות`);
    const accepted: LocalImage[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      const invalid = validateImageFile(file);
      if (invalid) { setError(invalid); continue; }
      try { accepted.push(await fileToLocalImage(file)); } catch (e: any) { setError(e.message); }
    }
    if (accepted.length) onChange([...images, ...accepted]);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    const next = images.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
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
              {i === 0 ? <span className="img-primary-badge">ראשית</span> : null}
              <div className="img-actions">
                {i !== 0 ? <button type="button" title="קבע כתמונה ראשית" onClick={() => move(i, 0)}>★</button> : null}
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
        <PickButton disabled={images.length >= IMAGE_LIMIT} onFiles={addFiles} label={images.length ? "+ הוספת תמונות" : "בחירת תמונות"} />
        <span className="muted small">{images.length}/{IMAGE_LIMIT} · עד 2MB · JPG / PNG / WebP · הראשונה היא התמונה הראשית</span>
      </div>
      {error ? <div className="notice err" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}

// ── server mode (Draft deal) ────────────────────────────────────────────────
type PendingUpload = { id: string; name: string; previewUrl: string; pct: number; error: string; img: { name: string; mime: string; b64: string } };

export function DraftImageManager({ dealId, images, onChanged }: { dealId: string; images: ServerImage[]; onChanged: () => void }) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [error, setError] = useState("");
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
      setPending((prev) => prev.map((p) => p.id === entry.id ? { ...p, error: e.message || "העלאה נכשלה" } : p));
    }
  };

  const addFiles = async (files: File[]) => {
    setError("");
    const room = IMAGE_LIMIT - sorted.length - pending.length;
    if (files.length > room) setError(room <= 0 ? `אפשר עד ${IMAGE_LIMIT} תמונות` : `אפשר להוסיף עוד ${room} בלבד`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const invalid = validateImageFile(file);
      if (invalid) { setError(invalid); continue; }
      try {
        const local = await fileToLocalImage(file);
        const entry: PendingUpload = { id: local.id, name: local.name, previewUrl: local.previewUrl, pct: 0, error: "", img: local };
        setPending((prev) => [...prev, entry]);
        void startUpload(entry);
      } catch (e: any) { setError(e.message); }
    }
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
    ids.splice(to, 0, item);
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
              {img.is_primary ? <span className="img-primary-badge">ראשית</span> : null}
              <div className="img-actions">
                {!img.is_primary ? <button type="button" disabled={busy} title="קבע כתמונה ראשית" onClick={() => commitOrder(sorted.map((x) => x.image_id), img.image_id)}>★</button> : null}
                <button type="button" disabled={busy || i === sorted.length - 1} title="הזז שמאלה" onClick={() => move(i, i + 1)}>‹</button>
                <button type="button" disabled={busy || i === 0} title="הזז ימינה" onClick={() => move(i, i - 1)}>›</button>
                <button type="button" className="danger" disabled={busy} title="מחיקה" onClick={async () => {
                  setBusy(true); setError("");
                  try { await imageApi.remove(dealId, img.image_id); onChanged(); }
                  catch (e: any) { setError(e.message); }
                  finally { setBusy(false); }
                }}>✕</button>
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
        <PickButton disabled={sorted.length + pending.length >= IMAGE_LIMIT} onFiles={addFiles} label="+ הוספת תמונות" />
        <span className="muted small">{sorted.length + pending.length}/{IMAGE_LIMIT} · עד 2MB · גרירה משנה סדר · ★ קובע ראשית</span>
      </div>
      {error ? <div className="notice err" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}
