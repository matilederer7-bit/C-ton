import React, { useEffect, useMemo, useRef, useState } from "react";
import { Json } from "./api";
import { ils, num } from "./util";

// ── TRUE VIRAL PROPAGATION TREE (P0.5-2) ────────────────────────────────────
// A visual map of HOW THE DEAL SPREAD FROM PERSON TO PERSON:
//
//   [ העסקה ] → origin SOURCES → every direct participant → their children →
//   next generations, recursively.
//
// EVERY joined participant is a node — propagators AND terminal leaves.
// "המשיכו" counts propagation OUTCOME only (caused ≥1 downstream join),
// never share-intent. Real genealogy connectors; no floating cards, no
// force-directed cloud, no indented table.
//
// Desktop: drag/zoom/fit canvas, expand/collapse, ancestry highlight, focus.
// Mobile: branch drilldown with breadcrumbs (never a shrunken canvas).
// Data: the ONE canonical attribution backend (sources + level queries);
// seller/admin differ only in the endpoint the caller injects.

export interface PropagationFetchers {
  fetchPropagation: (dealId: string) => Promise<Json>;
  fetchLevel: (dealId: string, params: { parent?: string; source?: string; limit?: number }) => Promise<Json>;
}

type PNodeKind = "deal" | "source" | "participant";
interface PNode { id: string; kind: PNodeKind; data: Json; }

const DIMS: Record<PNodeKind, { w: number; h: number }> = {
  deal: { w: 210, h: 72 },
  source: { w: 216, h: 118 },
  participant: { w: 164, h: 78 }
};
const GAP_X = 18;
const GAP_Y = 58;
const AUTO_EXPAND_NODE_BUDGET = 250;

interface TreeState {
  sources: Json[];
  rootsBySource: Record<string, Json[] | undefined>;
  childrenByParent: Record<string, Json[] | undefined>;
  truncated: Record<string, boolean>;
}

function participantChildren(state: TreeState, expanded: Set<string>, id: string): Json[] {
  return expanded.has(id) ? state.childrenByParent[id] || [] : [];
}

// ── recursive layout (variable node sizes, genealogy columns) ───────────────
interface Laid { id: string; kind: PNodeKind; data: Json; x: number; y: number; w: number; h: number }
interface LaidEdge { from: Laid; to: Laid }

function layoutTree(state: TreeState, expanded: Set<string>, dealTitle: string) {
  const nodes: Laid[] = [];
  const edges: LaidEdge[] = [];
  const parentOf: Record<string, string> = {};

  const widthOfParticipant = (p: Json): number => {
    const kids = participantChildren(state, expanded, String(p.participant_id));
    if (!kids.length) return DIMS.participant.w;
    const kidsW = kids.reduce((s, k) => s + widthOfParticipant(k), 0) + GAP_X * (kids.length - 1);
    return Math.max(DIMS.participant.w, kidsW);
  };
  const widthOfSource = (s: Json): number => {
    const roots = expanded.has(`src:${s.source_key}`) ? state.rootsBySource[String(s.source_key)] || [] : [];
    if (!roots.length) return DIMS.source.w;
    const rootsW = roots.reduce((sum, r) => sum + widthOfParticipant(r), 0) + GAP_X * (roots.length - 1);
    return Math.max(DIMS.source.w, rootsW);
  };

  const placeParticipant = (p: Json, x0: number, y: number, parent: Laid) => {
    const w = widthOfParticipant(p);
    const id = String(p.participant_id);
    const laid: Laid = { id, kind: "participant", data: p, x: x0 + w / 2, y, w: DIMS.participant.w, h: DIMS.participant.h };
    nodes.push(laid);
    parentOf[id] = parent.id;
    edges.push({ from: parent, to: laid });
    let cx = x0;
    for (const kid of participantChildren(state, expanded, id)) {
      const kw = widthOfParticipant(kid);
      placeParticipant(kid, cx, y + DIMS.participant.h + GAP_Y, laid);
      cx += kw + GAP_X;
    }
  };

  const totalW = Math.max(
    DIMS.deal.w,
    state.sources.reduce((s, src) => s + widthOfSource(src), 0) + GAP_X * Math.max(0, state.sources.length - 1)
  );
  const dealLaid: Laid = {
    id: "__deal__", kind: "deal", data: { title: dealTitle },
    x: totalW / 2, y: 0, w: DIMS.deal.w, h: DIMS.deal.h
  };
  nodes.push(dealLaid);

  let cx = 0;
  const sourceY = DIMS.deal.h + GAP_Y;
  for (const src of state.sources) {
    const w = widthOfSource(src);
    const id = `src:${src.source_key}`;
    const laid: Laid = { id, kind: "source", data: src, x: cx + w / 2, y: sourceY, w: DIMS.source.w, h: DIMS.source.h };
    nodes.push(laid);
    parentOf[id] = "__deal__";
    edges.push({ from: dealLaid, to: laid });
    if (expanded.has(id)) {
      let rx = cx;
      for (const root of state.rootsBySource[String(src.source_key)] || []) {
        const rw = widthOfParticipant(root);
        placeParticipant(root, rx, sourceY + DIMS.source.h + GAP_Y, laid);
        rx += rw + GAP_X;
      }
    }
    cx += w + GAP_X;
  }
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0);
  return { nodes, edges, parentOf, width: totalW, height: maxY };
}

function elbow(from: Laid, to: Laid): string {
  const x1 = from.x, y1 = from.y + from.h;
  const x2 = to.x, y2 = to.y;
  const my = y1 + (y2 - y1) / 2;
  if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
}

function ancestryOf(id: string | null, parentOf: Record<string, string>): Set<string> {
  const path = new Set<string>();
  let cur = id;
  while (cur && !path.has(cur)) { path.add(cur); cur = parentOf[cur] || null as any; }
  if (id) path.add("__deal__");
  return path;
}

// ── shared data loader ──────────────────────────────────────────────────────
function usePropagationData(dealId: string, fetchers: PropagationFetchers) {
  const [state, setState] = useState<TreeState | null>(null);
  const [deal, setDeal] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await fetchers.fetchPropagation(dealId);
        if (!alive) return;
        const sources: Json[] = p.sources || [];
        setDeal(p.deal || null);
        const next: TreeState = { sources, rootsBySource: {}, childrenByParent: {}, truncated: {} };
        const open = new Set<string>();
        let budget = AUTO_EXPAND_NODE_BUDGET;

        // eager first layer: the roots of every source (bounded)
        for (const src of sources.slice(0, 8)) {
          const key = String(src.source_key);
          const level = await fetchers.fetchLevel(dealId, { source: key, limit: 60 });
          next.rootsBySource[key] = level.nodes || [];
          next.truncated[`src:${key}`] = Boolean(level.truncated);
          open.add(`src:${key}`);
          budget -= (level.nodes || []).length;
        }
        // auto-expand descendants breadth-first while the budget allows, so a
        // small tree (like the acceptance fixture) is FULLY visible at once
        const queue: Json[] = Object.values(next.rootsBySource).flatMap((r) => r || []);
        while (queue.length && budget > 0) {
          const node = queue.shift()!;
          if (!node.has_children) continue;
          const id = String(node.participant_id);
          const level = await fetchers.fetchLevel(dealId, { parent: id, limit: 60 });
          next.childrenByParent[id] = level.nodes || [];
          next.truncated[id] = Boolean(level.truncated);
          open.add(id);
          budget -= (level.nodes || []).length;
          queue.push(...(level.nodes || []));
        }
        if (!alive) return;
        setState(next);
        setExpanded(open);
      } catch (e: any) {
        if (alive) setError(e.message || "טעינת העץ נכשלה");
      }
    })();
    return () => { alive = false; };
  }, [dealId]);

  const toggle = async (node: Json) => {
    const id = String(node.participant_id);
    if (expanded.has(id)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(id); return n; });
      return;
    }
    if (!state) return;
    if (!state.childrenByParent[id]) {
      setLoading(id);
      try {
        const level = await fetchers.fetchLevel(dealId, { parent: id, limit: 60 });
        setState((prev) => prev ? {
          ...prev,
          childrenByParent: { ...prev.childrenByParent, [id]: level.nodes || [] },
          truncated: { ...prev.truncated, [id]: Boolean(level.truncated) }
        } : prev);
      } catch { setLoading(null); return; }
      setLoading(null);
    }
    setExpanded((prev) => new Set(prev).add(id));
  };

  return { state, deal, error, expanded, setExpanded, toggle, loading };
}

// ── desktop canvas ──────────────────────────────────────────────────────────
function PropagationCanvas({ dealId, dealTitle, data }: {
  dealId: string;
  dealTitle: string;
  data: ReturnType<typeof usePropagationData>;
}) {
  const { state, expanded, toggle, loading } = data;
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const fittedOnce = useRef(false);

  const layout = useMemo(
    () => state ? layoutTree(state, expanded, dealTitle) : { nodes: [], edges: [], parentOf: {}, width: 0, height: 0 },
    [state, expanded, dealTitle]
  );
  const pathSet = useMemo(() => ancestryOf(selectedId, layout.parentOf), [selectedId, layout.parentOf]);
  const hasSelection = Boolean(selectedId);
  const selected = selectedId ? layout.nodes.find((n) => n.id === selectedId) : null;

  const fit = () => {
    const wrap = wrapRef.current;
    if (!wrap || !layout.width) return;
    const pad = 34;
    const k = Math.min(1.1, Math.max(0.22, Math.min(
      (wrap.clientWidth - pad * 2) / Math.max(1, layout.width),
      (wrap.clientHeight - pad * 2) / Math.max(1, layout.height)
    )));
    setView({ k, x: (wrap.clientWidth - layout.width * k) / 2, y: pad });
  };
  useEffect(() => { if (!fittedOnce.current && layout.width && wrapRef.current) { fittedOnce.current = true; fit(); } }, [layout.width]);

  const focusSelected = () => {
    const wrap = wrapRef.current;
    if (!wrap || !selected) return;
    setView((v) => ({ ...v, x: wrap.clientWidth / 2 - selected.x * v.k, y: wrap.clientHeight / 3 - selected.y * v.k }));
  };

  const zoomAt = (factor: number) => {
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.18, v.k * factor));
      const px = (wrapRef.current?.clientWidth || 0) / 2;
      const py = (wrapRef.current?.clientHeight || 0) / 2;
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };

  return (
    <>
      <div className="vtree-canvas-wrap" ref={wrapRef}>
        <div className="vtree-canvas-controls">
          <button onClick={() => zoomAt(1.2)} aria-label="הגדלה">+</button>
          <button onClick={() => zoomAt(0.83)} aria-label="הקטנה">−</button>
          <button onClick={fit} aria-label="התאמה למסך">⤢ התאמה</button>
          {hasSelection ? <button onClick={focusSelected} aria-label="מרכוז לענף הנבחר">◎ לענף הנבחר</button> : null}
        </div>
        <svg
          className="vtree-canvas"
          role="application"
          aria-label="עץ ההפצה של העסקה"
          onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
            setView((v) => ({ ...v, x: drag.current!.vx + dx, y: drag.current!.vy + dy }));
          }}
          onPointerUp={() => { drag.current = null; }}
          onWheel={(e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 0.87); }}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {layout.edges.map((e) => {
              const onPath = hasSelection && pathSet.has(e.from.id) && pathSet.has(e.to.id);
              return <path key={`${e.from.id}-${e.to.id}`} d={elbow(e.from, e.to)}
                className={`vtree-edge${e.from.kind === "deal" ? " root-edge" : ""}${onPath ? " on-path" : ""}`} />;
            })}
            {layout.nodes.map((n) => {
              const onPath = hasSelection && pathSet.has(n.id);
              const dimmed = hasSelection && !onPath;
              if (n.kind === "deal") {
                return (
                  <g key={n.id} transform={`translate(${n.x - n.w / 2},${n.y})`} className={`prop-node-deal${onPath ? " on-path" : ""}`}>
                    <rect width={n.w} height={n.h} rx={14} />
                    <text x={n.w / 2} y={30} textAnchor="middle" className="t1">🌳 {String(n.data.title || "העסקה").slice(0, 20)}</text>
                    <text x={n.w / 2} y={54} textAnchor="middle" className="t2">שורש ההפצה</text>
                  </g>
                );
              }
              if (n.kind === "source") {
                const s = n.data;
                return (
                  <g key={n.id} transform={`translate(${n.x - n.w / 2},${n.y})`}
                    className={`prop-node-source${onPath ? " on-path" : ""}${dimmed ? " dimmed" : ""}`}
                    onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) setSelectedId(n.id); }}>
                    <rect width={n.w} height={n.h} rx={14} />
                    <text x={n.w - 14} y={24} textAnchor="end" className="t1">{String(s.label || "מקור").slice(0, 24)}</text>
                    <text x={n.w - 14} y={46} textAnchor="end" className="t2">{num(s.direct_joins)} הצטרפו ישירות</text>
                    <text x={n.w - 14} y={66} textAnchor="end" className={`t2${Number(s.propagators) > 0 ? " good" : ""}`}>
                      {Number(s.propagators) > 0 ? `${num(s.propagators)} המשיכו להפיץ` : "אף אחד לא המשיך"}
                    </text>
                    <text x={n.w - 14} y={86} textAnchor="end" className="t3">{num(s.branch_joins)} הצטרפו בכל הענף</text>
                    <text x={n.w - 14} y={104} textAnchor="end" className="t3">עומק: {num(s.max_depth)} דורות</text>
                  </g>
                );
              }
              const p = n.data;
              const kids = Number(p.direct_children || 0);
              const isOpen = expanded.has(n.id);
              const cls = p.charged ? "charged" : p.active ? "active" : "dropped";
              return (
                <g key={n.id} transform={`translate(${n.x - n.w / 2},${n.y})`}
                  className={`prop-node ${cls}${onPath ? " on-path" : ""}${dimmed ? " dimmed" : ""}`}
                  onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) setSelectedId(n.id); }}>
                  <rect width={n.w} height={n.h} rx={12} />
                  <text x={n.w - 10} y={20} textAnchor="end" className="t1">{String(p.display || "משתתף").slice(0, 14)}</text>
                  <text x={10} y={20} textAnchor="start" className="t3">דור {num(p.generation)}</text>
                  <text x={n.w - 10} y={40} textAnchor="end" className="t2">{num(p.direct_units)} {Number(p.direct_units) === 1 ? "יחידה" : "יחידות"}</text>
                  <text x={n.w - 10} y={60} textAnchor="end" className={`t2${kids > 0 ? " good" : " faint"}`}>
                    {kids > 0 ? `הביא/ה ${num(kids)}` : "לא המשיך הלאה"}
                  </text>
                  {kids > 0 ? (
                    <g className="vtree-expand" onClick={(e) => { e.stopPropagation(); void toggle(p); }}>
                      <circle cx={14} cy={n.h} r={12} />
                      <text x={14} y={n.h + 4} textAnchor="middle">{loading === n.id ? "…" : isOpen ? "−" : `+${num(kids)}`}</text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
        <p className="vtree-canvas-hint">גרירה להזזה · גלגלת להגדלה · לחיצה על משתתף מאירה את השרשרת · + פותח ענף</p>
      </div>
      {selected && selected.kind === "participant" ? (
        <div className="panel" data-testid="tree-node-detail">
          <div className="panel-title">פרטי ענף — {selected.data.display}</div>
          <div className="kv">
            <span className="k">דור</span><span className="v">{num(selected.data.generation)}</span>
            <span className="k">יחידות ישירות</span><span className="v">{num(selected.data.direct_units)}</span>
            <span className="k">הביא/ה ישירות</span><span className="v">{num(selected.data.direct_children)}</span>
            <span className="k">מצטרפים בכל הענף</span><span className="v">{num(selected.data.subtree_joins)}</span>
            <span className="k">חויב בענף</span><span className="v">{ils(selected.data.subtree_charged_gmv)}</span>
          </div>
        </div>
      ) : selected && selected.kind === "source" ? (
        <div className="panel" data-testid="tree-node-detail">
          <div className="panel-title">פרטי מקור — {selected.data.label}</div>
          <div className="kv">
            <span className="k">הצטרפו ישירות</span><span className="v">{num(selected.data.direct_joins)}</span>
            <span className="k">המשיכו להפיץ</span><span className="v">{num(selected.data.propagators)}</span>
            <span className="k">בכל הענף</span><span className="v">{num(selected.data.branch_joins)}</span>
            <span className="k">יחידות בענף</span><span className="v">{num(selected.data.branch_units)}</span>
            <span className="k">חויב בענף</span><span className="v">{ils(selected.data.charged_gmv)}</span>
            <span className="k">עומק</span><span className="v">{num(selected.data.max_depth)} דורות</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── mobile drilldown ────────────────────────────────────────────────────────
type Crumb = { kind: "sources" } | { kind: "roots"; source: Json } | { kind: "children"; parent: Json };

function PropagationDrilldown({ dealId, dealTitle, data, fetchers }: {
  dealId: string;
  dealTitle: string;
  data: ReturnType<typeof usePropagationData>;
  fetchers: PropagationFetchers;
}) {
  const { state } = data;
  const [stack, setStack] = useState<Crumb[]>([{ kind: "sources" }]);
  const [levels, setLevels] = useState<Record<string, Json[]>>({});
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const top = stack[stack.length - 1]!;

  const openRoots = async (src: Json) => {
    const key = `src:${src.source_key}`;
    if (!levels[key] && !state.rootsBySource[String(src.source_key)]) {
      setBusy(true);
      const level = await fetchers.fetchLevel(dealId, { source: String(src.source_key), limit: 60 }).catch(() => null);
      if (level) setLevels((prev) => ({ ...prev, [key]: level.nodes || [] }));
      setBusy(false);
    }
    setStack((s) => [...s, { kind: "roots", source: src }]);
  };
  const openChildren = async (parent: Json) => {
    const key = `p:${parent.participant_id}`;
    if (!levels[key] && !state.childrenByParent[String(parent.participant_id)]) {
      setBusy(true);
      const level = await fetchers.fetchLevel(dealId, { parent: String(parent.participant_id), limit: 60 }).catch(() => null);
      if (level) setLevels((prev) => ({ ...prev, [key]: level.nodes || [] }));
      setBusy(false);
    }
    setStack((s) => [...s, { kind: "children", parent }]);
  };

  const rows: Json[] = top.kind === "sources"
    ? state.sources
    : top.kind === "roots"
      ? (state.rootsBySource[String(top.source.source_key)] || levels[`src:${top.source.source_key}`] || [])
      : (state.childrenByParent[String(top.parent.participant_id)] || levels[`p:${top.parent.participant_id}`] || []);

  return (
    <div className="prop-drill" data-testid="prop-drilldown">
      <nav className="prop-crumbs" aria-label="מסלול בעץ">
        {stack.map((crumb, i) => (
          <button key={i} className={`prop-crumb${i === stack.length - 1 ? " current" : ""}`}
            onClick={() => setStack((s) => s.slice(0, i + 1))}>
            {crumb.kind === "sources" ? `🌳 ${dealTitle || "העסקה"}` : crumb.kind === "roots" ? crumb.source.label : crumb.parent.display}
          </button>
        ))}
      </nav>
      {stack.length > 1 ? (
        <button className="btn btn-sm btn-ghost" style={{ marginBottom: 8 }} onClick={() => setStack((s) => s.slice(0, -1))}>→ חזרה</button>
      ) : null}
      {busy ? <p className="muted small">טוענים ענף…</p> : null}

      {top.kind === "sources" ? (
        <div className="stack" style={{ gap: 8 }}>
          {rows.map((src) => (
            <button key={String(src.source_key)} className="prop-row source" onClick={() => { void openRoots(src); }}>
              <span className="grow" style={{ textAlign: "start" }}>
                <b>{src.label}</b>
                <span className="small block">{num(src.direct_joins)} הצטרפו ישירות · {Number(src.propagators) > 0 ? `${num(src.propagators)} המשיכו` : "אף אחד לא המשיך"}</span>
                <span className="small block muted">{num(src.branch_joins)} בכל הענף · עומק {num(src.max_depth)} דורות</span>
              </span>
              <span aria-hidden="true">←</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {top.kind === "children" ? (
            <div className="prop-parent-card">
              <b>{top.parent.display}</b> · דור {num(top.parent.generation)} · הביא/ה {num(top.parent.direct_children)}
            </div>
          ) : null}
          {rows.length === 0 ? <p className="muted small">אין משתתפים בענף הזה.</p> : rows.map((p) => {
            const kids = Number(p.direct_children || 0);
            return (
              <button key={String(p.participant_id)} className={`prop-row${kids > 0 ? "" : " leaf"}`}
                disabled={kids === 0}
                onClick={() => { if (kids > 0) void openChildren(p); }}>
                <span className="grow" style={{ textAlign: "start" }}>
                  <b>{p.display}</b> <span className="small muted">· דור {num(p.generation)}</span>
                  <span className="small block">
                    {num(p.direct_units)} {Number(p.direct_units) === 1 ? "יחידה" : "יחידות"}
                    {kids > 0 ? ` · הביא/ה ${num(kids)}` : " · לא המשיך הלאה"}
                  </span>
                </span>
                {kids > 0 ? <span aria-hidden="true">←</span> : <span className="small muted">עלה סופי</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── entry component ─────────────────────────────────────────────────────────
export function PropagationTree({ dealId, dealTitle, fetchers }: {
  dealId: string;
  dealTitle: string;
  fetchers: PropagationFetchers;
}) {
  const data = usePropagationData(dealId, fetchers);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (data.error) return <div className="notice err">{data.error}</div>;
  if (!data.state) return <p className="muted small">טוענים את עץ ההפצה…</p>;

  // The feature always EXISTS — an empty dataset gets an honest empty state
  // with the deal root still visible, never a missing feature.
  if (!data.state.sources.length) {
    return (
      <div className="prop-empty" data-testid="prop-empty">
        <div className="prop-empty-root">🌳 {dealTitle || "העסקה"}</div>
        <p className="muted" style={{ margin: "10px 0 0" }}>עדיין לא נוצרה שרשרת הפצה לעסקה הזו.</p>
        <p className="muted small" style={{ margin: "4px 0 0" }}>כל מצטרף מקבל קישור אישי — ההפצה תופיע כאן ברגע שחברים יצטרפו דרכו.</p>
      </div>
    );
  }

  return narrow
    ? <PropagationDrilldown dealId={dealId} dealTitle={dealTitle} data={data} fetchers={fetchers} />
    : <PropagationCanvas dealId={dealId} dealTitle={dealTitle} data={data} />;
}
