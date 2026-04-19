# Frontend Foundation: RTL, Responsive, Accessibility

Last updated: 2026-04-19

## What Was Aligned

- The frontend root is now explicitly Hebrew-first and RTL-first.
- A real shell baseline was added around the SPA:
  skip link, shell header, main landmark, live region, and route-aware document title.
- The visual baseline was tightened into one shared foundation instead of page-by-page drift:
  shell surface, route chips, responsive spacing, interactive sizing, and shared state surfaces.
- Seller, affiliate, and admin skeleton surfaces were reframed with product-facing Hebrew copy instead of internal-looking wording.

## Official Working Direction

- Hebrew is the default UI language.
- RTL is the default layout direction from the HTML root and runtime frame.
- Mobile-first layout rules are the baseline, with desktop expansion layered on top.
- Accessibility is part of the foundation, not deferred polish.

## RTL Baseline

- `frontend/index.html` keeps `lang="he"` and `dir="rtl"` at the root.
- `frontend/app.js` now reasserts `lang="he"` and `dir="rtl"` at runtime and syncs route-based document titles.
- Form fields keep explicit RTL/LTR behavior only where needed, such as identifiers and codes.

## Responsive Baseline

- The shell, header, hero, cards, tables, forms, and action groups now work from a mobile-first baseline.
- Buttons and primary interactive controls keep larger tap targets for touch use.
- Shared breakpoints are now explicit:
  mobile baseline first, desktop layout promoted from `min-width: 901px`.

## Accessibility Baseline

- Skip link to the main content.
- Header, navigation, main content, and live-region landmarks.
- Strong `:focus-visible` treatment across links, buttons, inputs, and keyboard-reachable elements.
- Status and error strips now expose `role="status"` and `role="alert"` where appropriate.
- Seller login inputs now include meaningful labels and autocomplete hints.

## Product Surfaces Now Covered By The Foundation

- Public deal page
- Buyer flow entry shell
- Buyer tracking shell
- Seller workspace shell
- Seller deal-management shell
- Affiliate / distributor read surface shell
- Admin / support read surface shell

## Still Open For The Next Frontend Pass

- Add deeper component-level accessibility coverage for complex seller/admin tables and any future dialogs.
- Extend frontend smoke validation from structural checks to route-level rendering checks if a browser harness is added.
- Continue copy cleanup in lower-priority legacy/internal helper messages that do not currently drive the main surfaces.
