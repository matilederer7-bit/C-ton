## Stage 1: RTL And Hebrew External Alignment

### Goal

Close the external-language and RTL gap so Siton feels like a Hebrew product that was built in Hebrew from the start.

### Areas reviewed

- main site
- public deal page
- quantity and delivery selection
- OTP step
- payment and authorization step
- confirmation
- buyer tracking
- seller workspace
- deal creation
- seller deal management
- shell HTML and shared CSS

### Main issues found

- mixed English wording in external trust messaging
- authorization and charge terminology shown inconsistently
- environment labels leaked raw values such as `preview`
- seller-facing state values leaked raw backend states
- RTL was not enforced systemically enough for mixed fields like phone, OTP, card number, expiry, tracking number, and seller ids

### What was fixed

- normalized external copy to Hebrew-first wording across the main public and seller surfaces
- replaced external English trust terms with clearer Hebrew wording around:
  - phone verification
  - authorization hold
  - charge
  - recovery
  - mocked payment context
- added explicit RTL layout behavior at the CSS layer
- added mixed-direction field support through `data-dir="ltr"` and `data-dir="rtl"` handling
- normalized seller-facing state rendering so seller tables and cards show human-facing labels instead of raw state codes
- normalized environment labels to Hebrew-facing text

### QA performed

- validated shell HTML is `lang="he"` and `dir="rtl"`
- validated CSS includes RTL and mixed-direction support
- validated frontend copy no longer exposes the older English-facing payment wording
- reran frontend flow validation
- reran product-surface validation to confirm the main surface logic still holds

### Residuals

- no material blocker remains on the external Hebrew and RTL layer
- future passes should avoid reopening this stage unless a concrete regression appears
