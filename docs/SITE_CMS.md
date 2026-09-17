# Site CMS — template-driven content editor

Updated: 2026-09-17. Template editor: branch `claude/admin-cms-template-editor-x9mava`; product-copy pages: branch `claude/siton-admin-cms-templates-s8g2ih`.

THE SITE DESIGN IS FIXED. THE CONTENT IS EDITABLE THROUGH TEMPLATES. The owner edits
ordinary website content from `#/admin/content` (ניהול תוכן האתר) without touching code.
This is not a page builder: no HTML, no scripts, no CSS, no arbitrary layout. The admin
picks a page, edits the blocks of that page inside Siton templates, saves a draft,
previews it, and publishes.

## Audit result (what existed before this change)

| Piece | Before | Now |
|---|---|---|
| Storage | `siton.site_content` (`content_key`, `value_jsonb`, `previous_value_jsonb`, `revision`, `updated_by/at`), one flat `{field: string}` object per key | Same table. `value_jsonb` is the **published** page; migration 069 adds `draft_jsonb`, `draft_updated_at/by`, `published_at`. A page is `{ blocks: [...] }`; legacy flat rows are converted on read and rewritten as blocks on the next save. |
| Schema | `CONTENT_SECTIONS` in `src/site_content.ts` (home / about / footer / legal_*), string-only validator | ONE shared template library `web/src/content/cmsTemplates.ts` used by the backend validator, the admin editor and the public renderers. |
| Public read | `GET /api/site-content` → flat fields | Same route; each page returns `blocks` **plus** the flat legacy projection (`title`, `sub`, `intro`, `image`, `login_cta`, `signup_cta`, `text`, `body`) so older bundles keep reading it. |
| Admin | `GET /api/admin/site-content`, `PUT /api/admin/site-content/:key` (direct publish), `POST /api/admin/content-assets` (images) | Same routes kept. New: `PUT …/:key/draft`, `POST …/:key/publish`, `POST …/:key/discard`, `GET /api/admin/site-content/preview`; admin asset upload also accepts bounded MP4/WebM. |
| Landing | Hero title/sub/intro/image/CTA labels from CMS; how-it-works, why, for buyers/sellers, trust, FAQ, contact CTA hardcoded in `content/landing.he.ts` | All of those are blocks of the `home` page with `LANDING_HE` as the deterministic fallback. |
| FAQ | Resolver + fallback only (documented backend gap) | Persisted `faq` block (ordered `{q, a}` items); add / edit / delete / reorder / hide from the editor. |
| Hero media | Image from CMS; video only via `LANDING_HERO_VIDEO_*` env (documented gap) | `media_kind` (image \| video) on the hero block + admin video upload; env video remains a fallback when "video" is chosen without an upload. |
| Footer | Text from CMS, links hardcoded | `footer` block: text + ordered links. |
| About / legal | Title + body | `about` (title, body, optional image) and `legal` (title, body) single locked blocks; same safe text rendering, same Siton shell. |

## Content model

```
page = { blocks: Block[] }
Block = { id, type, enabled, fields: Record<string,string>, items?: Record<string,string>[] }
```

Templates (`TEMPLATES`): `hero`, `text`, `image_text`, `cta`, `steps`, `faq`, `columns`, `about`,
`legal`, `footer`. Each declares display name, fields (kind, label, max length, required,
select options, editor hint) and, for repeatable templates, child items with min/max.

Page contracts (`PAGE_CONTRACTS` + `legalPageContract`):

| Page | Locked blocks (first, always enabled, never removable) | Addable templates |
|---|---|---|
| `home` | `hero` | text, image_text, cta, steps, faq, columns (max 20 blocks) |
| `about` | `about` | none |
| `footer` | `footer` | none |
| `legal_<slug>` | `document` (legal) | none |
| `deal_page` | `deal` (deal_copy), `how` (steps), `track` (track_copy) | none |
| `seller_area` | `seller` (seller_copy) | none |
| `support_page` | `support` (support_copy) | none |

Default `home` composition: hero → how (steps) → why (text, hidden) → audiences (columns:
לקונים / למוכרים) → trust (text) → about (text, hidden) → faq → contact (cta).

Safety rules (server and client identical): plain text only (`<tag` and control characters
rejected), links must be `#/…`, `/…` or `https://…`, media must be `/api/content-assets/<uuid>`
uploaded by a named admin with the MIME kind the field expects. Unknown fields, unknown
templates, duplicate ids, a moved/removed/hidden locked block and item counts outside the
template bounds are rejected (HTTP 400). Rendering uses `normalizePage`, which never throws:
garbage is dropped, locked blocks are restored from the defaults, and a missing row yields
the canonical page.

## Workflow: שמור טיוטה → תצוגה מקדימה → פרסם באתר

- Draft save (`PUT …/:key/draft`) validates and stores `draft_jsonb`. The public site keeps
  reading `value_jsonb`.
- Preview: the editor opens `#/?cms_preview=1` (or `#/content/<key>?cms_preview=1`) in a new
  tab. That tab adopts a per-tab session flag and reads `GET /api/admin/site-content/preview`
  (draft ?? published) — served only to a named admin with `admin_users.manage`. A refused
  preview falls back to the published content with an explicit banner. Other visitors are
  never affected.
- Publish (`POST …/:key/publish`) re-validates the stored draft and asset ownership, moves it
  to `value_jsonb`, keeps `previous_value_jsonb`, clears the draft and sets `published_at`. A
  missing or invalid draft answers 409 and the public page is untouched.
- Discard (`POST …/:key/discard`) drops the draft.
- Every mutation carries the page `revision` the admin loaded; a stale revision answers 409
  (`content_changed_reload`) and nothing is overwritten. Rows are serialized with an advisory
  lock. The legacy `PUT …/:key` still publishes directly (compatibility) and clears any draft.

## Security

- Admin API is the authority; the editor is presentation. All mutations and the preview
  require a named admin session with `admin_users.manage` (never the shared bootstrap key).
- Uploads keep the canonical image adapter (PNG/JPEG/WebP signature check, 5 MB). Video is
  admin-only, MP4/WebM by signature, ≤ 10 MB, stored through the same storage adapter and
  key layout (orphan report unchanged); the route has its own JSON body limit (15 MB).
- `GET /api/content-assets/:id` serves `X-Content-Type-Options: nosniff` and byte ranges
  (206/416) for video so Safari can play it.
- React renders text only; the server-rendered `/legal/:slug` escapes everything.

## Product surfaces: fixed composition, editable wording

The deal page, the buyer tracking screen, the seller dashboard and the support form are
product surfaces, not free-form pages. They are editable through the SAME CMS, with a
narrower contract: every block is **locked** and `addable` is empty, so an edit can change
the wording but can never remove, hide, reorder or add a sentence the flow depends on.

| Page | Template | What the owner edits | Where it appears |
|---|---|---|---|
| `deal_page` | `deal_copy` | explainer, why the group price is lower, what happens on tap, the hold notice in the join form, the share headline | `#/deal/:id` (also the join sheet and the success screen) |
| `deal_page` | `steps` (`how`) | the how-it-works steps — add / edit / delete / reorder | the deal page "איך זה עובד" panel |
| `deal_page` | `track_copy` | the hold explanation, the "לחזור לכאן ולשאול" headline, the three empty-state titles (no access / network / busy) | `#/track/:id` |
| `seller_area` | `seller_copy` | the "no deals yet" empty state (title, body, button), the guidance headline, the pending / rejected account messages, the incomplete-profile headline | `#/seller` |
| `support_page` | `support_copy` | the form title and intro, the post-submit title and body | `#/support` |

Reading path: `web/src/productCopy.ts` — a pure module with `resolveDealCopy`,
`resolveTrackCopy`, `resolveSellerCopy`, `resolveSupportCopy`. Each resolves a field to the
published value when it is non-empty and to the **canonical Hebrew default of the page
contract** otherwise, so a missing, partial, malformed or unavailable CMS payload renders
exactly what shipped. The defaults are the same constants the product already used
(`web/src/buyerCopy.ts`, `web/src/content/seller.he.ts`), imported by the template library,
so there is one source of truth for "the original text" in the editor and in the fallback.

Preview: `support_page` previews on its real public route (`#/support?cms_preview=1`).
`deal_page` and `seller_area` have no standalone URL that would show their sentences to an
admin (a deal page needs a deal, the dashboard needs a seller account), so the editor
previews them **inline**, rendering the sentences in their on-screen context.

### What stays server-owned on these surfaces

The tracking status headline, subline and "what still has to happen" steps are projections
of canonical participant/deal state and are NOT content: they must stay true of the state
machine, so they remain server-derived. The same holds for prices, unit counts, deadlines,
the pilot mock-money disclosure and every money sentence the payment rail owns. The two
frame/hold sentences that ARE editable carry an editor hint saying they must stay truthful
(no charge on join), and the tests assert the shipped defaults say so.

## Intentionally hardcoded (system truth)

- Pilot disclosure "פיילוט סגור — בשלב זה לא מתבצעים חיובים אמיתיים." (`LANDING_HE.pilot`).
- Auth-dependent seller buttons (dashboard / new deal) and the Mall-gated buyer entry link.
- Legal chip navigation (`legal_terms/privacy/refunds/payments`), the topbar, the admin shell.
- Product and financial invariants (fee, money states) are not content.

## Operations

- Migration `069_site_content_drafts_media.sql` (additive: draft columns + video MIME in the
  `content_assets` CHECK) must be applied through the canonical runner **before** deploying
  this code (same rule as 066). No new grants: `supabase/staging/023_receipt_content_grants.sql`
  already covers both tables.
- The product-copy pages need **no migration and no new grant**: they are additional page
  contracts over the same `siton.site_content` row model.
- Verification: `TEST_FILE_PATTERN=site_content_cms npm run test:integration`,
  `npm run test:product-copy-cms`, `npm run proof:cms`,
  `node scripts/receipt_content_browser_proof.cjs`, `npm run proof:ux-round2`.
