import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, Json } from "./api";
import { ils, num } from "./util";

// ── Viral tree CANVAS (P0.2-O) — a genealogy-style referral tree ────────────
// Top-down node-link diagram on a pannable/zoomable SVG canvas: the deal at
// the root, generations in horizontal bands beneath it, curved parent→child
// connectors, expandable descendants (lazy, one level per request against the
// canonical /viral-tree endpoint), node selection for branch metrics.
// Desktop-first; narrow screens use the nested drilldown representation.

export type VNode = Json;

const NODE_W = 178;
const NODE_H = 64;
const GAP_X = 18;
const GAP_Y = 64;

interface TreeData {
  byId: Record<string, VNode>;
  childrenOf: Record<string, string[] | undefined>; // key "root" for gen-0
  truncated: Record<string, boolean>;
}

interface LaidNode { id: string; x: number; y: number; depth: number }
interface LaidEdge { from: LaidNode; to: LaidNode }

function computeLayout(data: TreeData, expanded: Set<string>): { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number; maxDepth: number } {
  const widths = new Map<string, number>();
  const width = (id: string): number => {
    if (widths.has(id)) return widths.get(id)!;
    const kids = expanded.has(id) ? data.childrenOf[id] : undefined;
    let w = NODE_W;
    if (kids && kids.length) {
      w = Math.max(NODE_W, kids.reduce((s, k) => s + width(k), 0) + GAP_X * (kids.length - 1));
    }
    widths.set(id, w);
    return w;
  };
  const roots = data.childrenOf["root"] || [];
  const totalW = Math.max(NODE_W, roots.reduce((s, r) => s + width(r), 0) + GAP_X * Math.max(0, roots.length - 1));

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  let maxDepth = 0;
  const place = (id: string, x0: number, depth: number, parent: LaidNode | null) => {
    const w = width(id);
    const node: LaidNode = { id, x: x0 + w / 2, y: depth * (NODE_H + GAP_Y), depth };
    nodes.push(node);
    maxDepth = Math.max(maxDepth, depth);
    if (parent) edges.push({ from: parent, to: node });
    const kids = expanded.has(id) ? data.childrenOf[id] : undefined;
    if (kids && kids.length) {
      let cx = x0;
      for (const k of kids) { place(k, cx, depth + 1, node); cx += width(k) + GAP_X; }
    }
  };
  let cx = 0;
  for (const r of roots) { place(r, cx, 1, null); cx += width(r) + GAP_X; }
  return { nodes, edges, width: totalW, height: (maxDepth + 1) * (NODE_H + GAP_Y), maxDepth };
}

function edgePath(from: LaidNode, to: LaidNode): string {
  const x1 = from.x, y1 = from.y + NODE_H;
  const x2 = to.x, y2 = to.y;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

export function VTreeCanvas({ dealId, roots, rootTruncated, dealTitle, onSelect, selectedId }: {
  dealId: string;
  roots: VNode[];
  rootTruncated: boolean;
  dealTitle?: string;
  onSelect: (n: VNode) => void;
  selectedId: string | null;
}) {
  const [data, setData] = useState<TreeData>(() => ({
    byId: Object.fromEntries(roots.map((r) => [String(r.participant_id), r])),
    childrenOf: { root: roots.map((r) => String(r.participant_id)) },
    truncated: { root: rootTruncated }
  }));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fittedOnce = useRef(false);

  const layoutResult = useMemo(() => computeLayout(data, expanded), [data, expanded]);

  const fit = (l = layoutResult) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pad = 34;
    const vw = wrap.clientWidth, vh = wrap.clientHeight;
    const k = Math.min(1.15, Math.max(0.3, Math.min((vw - pad * 2) / Math.max(1, l.width), (vh - pad * 2) / Math.max(1, l.height + NODE_H))));
    setView({ k, x: (vw - l.width * k) / 2, y: pad });
  };
  useEffect(() => { if (!fittedOnce.current && wrapRef.current) { fittedOnce.current = true; fit(); } }, [layoutResult.width]);

  const toggle = async (node: VNode) => {
    const id = String(node.participant_id);
    if (expanded.has(id)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(id); return n; });
      return;
    }
    if (!data.childrenOf[id]) {
      setLoading(id);
      try {
        const r = await api.adminDealViralTree(dealId, { parent: id, limit: 60 });
        const kids: VNode[] = (r as Json).nodes || [];
        setData((prev) => ({
          byId: { ...prev.byId, ...Object.fromEntries(kids.map((k) => [String(k.participant_id), k])) },
          childrenOf: { ...prev.childrenOf, [id]: kids.map((k) => String(k.participant_id)) },
          truncated: { ...prev.truncated, [id]: Boolean((r as Json).truncated) }
        }));
      } catch { /* keep collapsed on failure */ setLoading(null); return; }
      setLoading(null);
    }
    setExpanded((prev) => new Set(prev).add(id));
  };

  // pan (pointer drag) + zoom (wheel / buttons)
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x), y: drag.current!.vy + (e.clientY - drag.current!.y) }));
  };
  const onPointerUp = () => { drag.current = null; };
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.25, v.k * factor));
      const px = cx ?? (wrapRef.current?.clientWidth || 0) / 2;
      const py = cy ?? (wrapRef.current?.clientHeight || 0) / 2;
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
  };

  const rootLaid: LaidNode = { id: "__deal__", x: layoutResult.width / 2, y: 0, depth: 0 };
  const genBands = Array.from({ length: layoutResult.maxDepth }, (_, i) => i + 1);

  return (
    <div className="vtree-canvas-wrap" ref={wrapRef}>
      <div className="vtree-canvas-controls">
        <button onClick={() => zoomAt(1.2)} aria-label="הגדלה">+</button>
        <button onClick={() => zoomAt(0.83)} aria-label="הקטנה">−</button>
        <button onClick={() => fit()} aria-label="התאמה למסך">⤢ התאמה</button>
      </div>
      <svg
        ref={svgRef}
        className="vtree-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        role="application"
        aria-label="עץ הפצה ויראלי"
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* generation bands */}
          {genBands.map((g) => (
            <g key={g}>
              <line x1={-60} x2={layoutResult.width + 60} y1={g * (NODE_H + GAP_Y) - GAP_Y / 2} y2={g * (NODE_H + GAP_Y) - GAP_Y / 2} className="vtree-gen-line" />
              <text x={-52} y={g * (NODE_H + GAP_Y) + NODE_H / 2} className="vtree-gen-label">דור {g - 1}</text>
            </g>
          ))}

          {/* edges from the deal root to gen-0 */}
          {(data.childrenOf["root"] || []).map((rid) => {
            const laid = layoutResult.nodes.find((n) => n.id === rid);
            return laid ? <path key={`r-${rid}`} d={edgePath(rootLaid, laid)} className="vtree-edge root-edge" /> : null;
          })}
          {layoutResult.edges.map((e) => (
            <path key={`${e.from.id}-${e.to.id}`} d={edgePath(e.from, e.to)} className="vtree-edge" />
          ))}

          {/* deal root node */}
          <g transform={`translate(${rootLaid.x - NODE_W / 2},0)`} className="vtree-node-deal">
            <rect width={NODE_W} height={NODE_H} rx={14} />
            <text x={NODE_W / 2} y={26} textAnchor="middle" className="t1">🌳 {dealTitle ? String(dealTitle).slice(0, 18) : "העסקה"}</text>
            <text x={NODE_W / 2} y={47} textAnchor="middle" className="t2">{num((data.childrenOf["root"] || []).length)} מצטרפים ישירים{data.truncated["root"] ? "+" : ""}</text>
          </g>

          {/* participant nodes */}
          {layoutResult.nodes.map((laid) => {
            const n = data.byId[laid.id];
            if (!n) return null;
            const selected = selectedId === laid.id;
            const hasKids = Boolean(n.has_children);
            const isOpen = expanded.has(laid.id);
            const cls = n.charged ? "charged" : n.active ? "active" : "dropped";
            return (
              <g key={laid.id} transform={`translate(${laid.x - NODE_W / 2},${laid.y})`}
                className={`vtree-node-g ${cls}${selected ? " selected" : ""}`}
                onClick={(e) => { e.stopPropagation(); onSelect(n); }}>
                <rect width={NODE_W} height={NODE_H} rx={12} />
                <text x={NODE_W - 12} y={24} textAnchor="end" className="t1">{String(n.display || "").slice(0, 16)}</text>
                <text x={NODE_W - 12} y={46} textAnchor="end" className="t2">
                  {num(n.direct_units)} יח׳ · {n.charged ? "חויב ✓" : n.active ? "מסגרת" : "נשר"}
                </text>
                {hasKids ? (
                  <g className="vtree-expand" onClick={(e) => { e.stopPropagation(); void toggle(n); }}>
                    <circle cx={16} cy={NODE_H} r={13} />
                    <text x={16} y={NODE_H + 5} textAnchor="middle">
                      {loading === laid.id ? "…" : isOpen ? "−" : `+${num(n.direct_children)}`}
                    </text>
                  </g>
                ) : null}
                {hasKids && !isOpen ? (
                  <text x={NODE_W / 2 + 14} y={NODE_H + 16} textAnchor="middle" className="t3">
                    ענף: {num(n.subtree_joins)} · {ils(n.subtree_charged_gmv || 0)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <p className="vtree-canvas-hint">גרירה להזזה · גלגלת להגדלה · + פותח ענף · לחיצה על כרטיס מציגה מדדי ענף</p>
    </div>
  );
}
