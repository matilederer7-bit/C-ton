# Accessibility Compliance

Written as an initial MVP response; legal validation is recommended later.

## Target Standard

C-ton targets Israeli accessibility requirements under SI 5568 and WCAG 2.0 AA for public digital services.

## Implemented Fixes

- Skip link to `#main-content`.
- RTL Hebrew root with `lang="he"` and `dir="rtl"`.
- Landmarks: `nav`, `main`, and public `footer`; app header metadata is exposed in the shell.
- Form inputs have visible labels.
- Status, error, loading, chat, tracking, OTP, payment and recovery areas use live regions where state changes.
- `:focus-visible` styling is present for links, buttons and form controls.
- Product images render with descriptive alt text or fallback alt text.
- Buyer payment copy explains authorization hold only, not immediate charge.
- Tracking surfaces expose deal state, money state and next outcome in text, not color alone.
- Mobile layouts collapse to one column and keep controls reachable without mouse-only actions.

## Checked Screens

- Public deal page
- OTP page
- Payment authorization page
- Join confirmation page
- Buyer tracking page
- Seller create and publish screens
- Distributor attribution screen
- Public policy pages

## Manual Tests Required

- Keyboard-only pass through deal, OTP, payment and tracking flows.
- Screen reader pass for payment disclosure and tracking state.
- 200% browser zoom on mobile and desktop widths.
- Color contrast spot-check for badges, warnings and action buttons.
- Real device RTL check on iOS and Android.

## Public Accessibility Statement

C-ton is committed to making its digital service accessible to people with disabilities. The service is built to support Hebrew RTL use, keyboard navigation, clear focus indication, visible labels, readable status messages and compatibility with assistive technologies.

The accessibility target for the service is SI 5568 and WCAG 2.0 AA. We continue to improve the service as screens and workflows are added.

If you encounter an accessibility issue, contact us at accessibility@c-ton.co.il. Please include the page link, a short description of the issue, the device/browser used and any assistive technology involved.
