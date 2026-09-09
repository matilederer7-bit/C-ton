import React, { useEffect, useState } from "react";
import { api } from "../api";
import { BrandLoader, EmptyState } from "../components";
import { hebrewError } from "../he";

// ── SPRINT 4 (A4) — native legal documents ──────────────────────────────────
// Terms / Privacy / Refunds (and the other documents) render INSIDE the React
// product: same header, container, typography, cards, footer and responsive
// behaviour as every other page. The content is never duplicated here — the
// page renders the JSON projection of the ONE canonical source
// (src/legal_pages.ts) served by GET /api/legal/:slug, block by block.

type LegalBlock = { type: "h1"; text: string } | { type: "h2"; text: string } | { type: "p"; lines: string[] };
interface LegalDocument {
  slug: string;
  title: string;
  nav_label: string;
  notice: string;
  blocks: LegalBlock[];
  nav: { slug: string; nav_label: string; current: boolean }[];
}

export function LegalPage({ slug, navigate }: { slug: string; navigate: (h: string) => void }) {
  const [doc, setDoc] = useState<LegalDocument | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setDoc(null); setError(null);
    api.legal(slug)
      .then((r) => { if (alive) setDoc(r.page as LegalDocument); })
      .catch((e) => { if (alive) setError({ status: Number(e?.status || 0), message: hebrewError(e) }); });
    return () => { alive = false; };
  }, [slug]);

  if (error) {
    return (
      <div className="stack" data-testid="legal-error">
        <EmptyState
          icon={error.status === 404 ? "📄" : "⚠️"}
          title={error.status === 404 ? "המסמך המבוקש לא נמצא" : "לא הצלחנו לטעון את המסמך"}
          body={error.status === 404 ? "ייתכן שהקישור שגוי. המסמכים הזמינים: תקנון, מדיניות פרטיות, ביטולים והחזרים." : error.message}
          action={<a className="btn btn-primary" href="#/legal/terms" onClick={(e) => { e.preventDefault(); navigate("#/legal/terms"); }}>לתקנון</a>}
        />
      </div>
    );
  }
  if (!doc) return <BrandLoader label="טוענים את המסמך…" minHeight={420} />;

  return (
    <article className="legal-page" data-testid="legal-page" data-legal-slug={doc.slug}>
      <nav className="legal-nav" aria-label="מסמכים משפטיים" data-testid="legal-nav">
        {doc.nav.map((item) => (
          <a
            key={item.slug}
            className={`chip${item.current ? " active" : ""}`}
            href={`#/legal/${item.slug}`}
            aria-current={item.current ? "page" : undefined}
            onClick={(e) => { e.preventDefault(); navigate(`#/legal/${item.slug}`); }}
          >
            {item.nav_label}
          </a>
        ))}
      </nav>
      <div className="panel legal-doc">
        <div className="notice warn legal-notice" data-testid="legal-notice">{doc.notice}</div>
        {doc.blocks.map((block, index) => {
          if (block.type === "h1") return <h1 key={index} className="legal-title">{block.text}</h1>;
          if (block.type === "h2") return <h2 key={index} className="legal-section">{block.text}</h2>;
          return (
            <p key={index}>
              {block.lines.map((line, i) => (
                <React.Fragment key={i}>{i > 0 ? <br /> : null}{line}</React.Fragment>
              ))}
            </p>
          );
        })}
      </div>
      <p className="muted small legal-foot">
        שאלות על המסמכים? <a href="#/support" onClick={(e) => { e.preventDefault(); navigate("#/support"); }}>פנו לתמיכה</a>.
      </p>
    </article>
  );
}
