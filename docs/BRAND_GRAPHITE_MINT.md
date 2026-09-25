# C-ton brand — "Graphite Mint" (locked 2026-09-25)

Owner decision of 2026-09-25. This replaces the 2026-09-24 "Daylight" (indigo / coral) identity on every surface. It is a presentation-only contract: no route, state, payment, permission or API changes ride on it.

## Palette

| Token | Value | Use |
|---|---|---|
| `--brand-graphite` | `#0f172a` | primary text, headings, navigation, dark brand elements, the primary CTA fill, the logo tile |
| `--brand-graphite-hi` / `--brand-graphite-deep` | `#1e293b` / `#020617` | hover / active of a graphite fill |
| `--brand-mint` | `#2dd4bf` | the logo dash, highlights, selected interactions, positive progress in motion, live dots, section-marker bars, decorative halos |
| `--brand-mint-ink` | `#115e59` | mint as **text** (mint itself is not readable on white): links, prices, active tabs, "collecting" pills, and the keyboard focus ring (`--focus-ring`, 7.6:1 on white) |
| `--brand-green` / `--brand-green-hi` | `#065f46` / `#047857` | success: target reached, completed, success buttons, the reached meter |
| `--brand-amber` / `--brand-amber-ink` | `#f59e0b` / `#92400e` | urgency and attention **only**: few units left, time running out, the Completion Window, a warning that is not a failure. Graphite text on an amber fill, never white. Never a brand colour. |
| `--brand-sand` | `#d6c7a7` | reserved soft warm wash (used in the hero lockup only) |
| `--bg` / `--surface` | `#f8fafc` / `#ffffff` | page ground / cards |
| `--line` (`--border`) / `--line-strong` | `#e5e7eb` / `#cbd5e1` | secondary grey: borders, dividers, tracks |
| `--ink` / `--ink-soft` / `--ink-faint` | `#0f172a` / `#334155` / `#475569` | text ramp (every step ≥ 6:1 on every ground, well above AA) |
| red | `#c8261a` (`--pomegranate`) | real errors and danger only |
| blue | `#1d5fd0` (`--sky`) | informational / charging |

Rules: components reference tokens, never a brand hex; translucent brand tints use the triplets `rgb(var(--brand-mint-rgb) / a)` and `rgb(var(--brand-rgb) / a)` (legacy shell: `--live-rgb`, `--dark-rgb`). Do not add brand colours. Semantic colours (green / amber / red / blue) are never decoration.

## Where the tokens live

- Canonical React app: `web/src/styles.css` (`:root`). The older role names (`--brand`, `--brand-hi`, `--brand-tint`, `--live*`, `--accent-cyan`, `--saffron*`, `--success*`) are kept as aliases of the primitives above, so every existing `var(--…)` reference resolves.
- Legacy `/app` PWA shell: `frontend/styles.css` (`:root`) with the same values.
- Server-rendered legal / share / pay shells: the four presentation strings in `src/frontend_runtime.ts`.
- Group meter fill: `web/src/util.ts#progressColor` — graphite on the way, a mint leading edge that grows from 60 % of the target, brand green at the target.

## Logo

`C-ton`: the C and "ton" in graphite; between them a **short horizontal mint dash** (never a dot), a little thinner than the letter stroke, with a very soft mint glow (a blurred copy of the dash at low opacity — not neon). The two SVG sources keep distinct filter ids (`mark-dash-glow`, `word-dash-glow`) because the renderer inlines both into one splash / lockup document.

- Sources: `assets/brand/c-ton-mark.svg` (white C on a graphite tile, the same dash in the C's opening) and `assets/brand/c-ton-wordmark.svg`. `assets/logo.svg` and `frontend/icons/logo.svg` are copies of the mark.
- Every raster is rendered from them: `node scripts/render_brand_assets.cjs` (web `web/public/brand/*`, PWA `frontend/icons/*`, native inputs `assets/native/*`) then `npm run mobile:assets` (iOS AppIcon + Splash, Android launcher / adaptive / splash). File names never change, so no URL, cache rule, manifest entry or Xcode/Gradle reference moves.
- Favicon: `web/public/brand/favicon-64.png`; the dash stays a visible bar down to 16 px.

## States

- Buttons: primary = graphite fill, white text; hover graphite-hi; active graphite-deep; focus = a 2 px white gap and a 2 px mint-ink ring; disabled = `--bg-deep` fill with `--ink-faint` text, no lift. Loading has no separate style: components pass `disabled` while a request is in flight, so a loading button shows the disabled state.
- Progress: graphite → mint edge → green at target. Amber only when time or stock is genuinely running out.
- Status pills: collecting = mint tint / mint ink with a breathing mint dot; reached / completed = green; Completion Window = amber; failed = red.

Pinned by `tests/visual_brand_consistency_validation.ts` (tokens, contrast, and pixel samples of every rendered icon and splash).
