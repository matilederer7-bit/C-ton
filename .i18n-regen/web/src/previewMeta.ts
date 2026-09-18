// Single cached fetch of the runtime product configuration
// (/api/preview/meta): mall visibility, hero-video capability, support email.
let metaPromise: Promise<any> | null = null;

export function getPreviewMeta(): Promise<any> {
  if (!metaPromise) {
    metaPromise = fetch("/api/preview/meta")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return metaPromise;
}
