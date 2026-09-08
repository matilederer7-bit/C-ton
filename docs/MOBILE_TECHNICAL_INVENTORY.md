# Mobile technical inventory (2026-09-08)

Evidence base: `8ead7c828e6d6233bf7d17bf7f67d1a67ad35767`, branch `codex/mobile-release-readiness`. This inventory is based on source, installed locked dependencies, generated bundles and executed checks, not historical readiness claims.

## Canonical runtime and shells

| Item | Observed result / evidence |
| --- | --- |
| ANDROID_SHELL | Complete source structure; PASS static gate. Compilation and device behavior unproved. |
| IOS_SHELL | Complete source structure; PASS static gate. No Xcode execution on Windows. |
| CAPACITOR_SYNC | PASS: clean canonical web build, Android copy/update, iOS copy/SwiftPM update, portable path normalization, hash verification. |
| WEB_BUNDLE_SOURCE | `web/src`, `web/public`, `web/index.html`, `web/vite.config.ts`; Vite output `web/dist`, packaged under `.mobile_dist/preview/`. Native start `/preview/`. |
| Previous mismatch | `scripts/build_mobile_bundle.cjs` used `frontend/` and `/app`. That surface lacks the canonical React Supabase session/guest/geolocation flows. It is no longer packaged. Legacy frontend/PWA files remain separate. |
| Hosted fallback | No `server.url`; no hosted/Base44 download. Build invokes locked local TypeScript and Vite, empties build output, then copies it. |
| Integrity | Manifest schema 2 hashes source inputs and every packaged asset. `mobile:verify` is read-only: missing/stale files fail rather than being rebuilt or repaired. Android preBuild invokes it. |
| Build environments | Default `.invalid` endpoints allow offline/static compilation but cannot contact an API. `SITON_API_BASE_URL` requires a credential-free HTTPS origin; `SITON_APP_LINK_HOST` a DNS host. Production gate `node scripts/mobile_release_gate.cjs --release` rejects placeholders/staging API origins/preview identifier. This gate is separate from unsigned release-mode compilation. |
| Native adapter | `mobile/runtime.js` is injected before the React entry only in packaged HTML. Remaps same-origin `/api/` fetch and XHR, retaining request payloads/headers; absolute Supabase requests remain absolute. CapacitorHttp and CapacitorCookies remain enabled. Device proof is required. |
| Public URLs | `web/src/mobileUrls.ts` supplies the configured HTTPS link host only on native; ordinary web stays same-origin. Used by canonical share-link generation and auth-email redirect construction. |
| PWA/offline | Legacy `frontend/service-worker.js` is not installed into the canonical native bundle. Canonical assets load locally; API data and writes require connectivity. No financial/offline write queue is added. |

## Native configuration

Android: namespace `il.co.siton.app`; default applicationId `il.co.siton.preview`; app name Siton. minSdk 24, compileSdk/targetSdk 36 (`android/variables.gradle`). VersionCode 1, versionName 1.0. Gradle wrapper 8.14.3, Android Gradle Plugin 8.13.0. Installed Capacitor Android compiles Java 21. No Kotlin application source requirement was introduced. Release minification remains false; no signingConfig; release debuggable explicitly false. Android backup is now disabled. MainActivity is exported for launcher/link intents and extends BridgeActivity. FileProvider is not exported; camera files are limited to app-specific Pictures, plus app cache for Camera/Share. Entire external-storage exposure was removed. Cache sharing still requires per-file grants and device review.

Network security: system trust anchors only, cleartext false, no mixed content, no navigation allowlist expansion. Local `https://localhost` on Android and Capacitor's iOS local origin are shell asset origins, not backend endpoints. Debug builds may permit WebView debugging through Capacitor's debug behavior; no release override enables it. Final merged manifest, transitive Firebase permissions/components, packaged WebView flags and APK/AAB contents are not verified until Android builds exist.

iOS: bundle placeholder `il.co.siton.preview`, marketing version 1.0/build 1 in Debug and Release; deployment target 15.0; SwiftPM Capacitor exact 8.5.0 and local plugin packages; source Swift setting 5.0, package tools 5.9. Info.plist includes camera, photos and foreground location usage strings; no ATS exceptions. Phone portrait and both landscapes; iPad additionally upside-down. URL scheme `siton`; associated domain `applinks:$(SITON_APP_LINK_HOST)`. AppDelegate/SceneDelegate forward scene URLs and activities through Capacitor. Signing team/certificates are not configured here. Debug Swift flags exist in Debug only. macOS/Xcode is required to resolve and compile the actual SDK graph.

Installed plugins from sync: App 8.1.1, Browser 8.0.4, Camera 8.2.3, Network 8.0.1, Preferences 8.0.1, PushNotifications 8.1.2, local SitonSecureStorage 1.0.0. Core/Android/iOS/CLI resolve to 8.5.0. Installed is not synonymous with wired into the canonical React product.

Recommended eventual identifier: `il.co.siton.app`, subject to owner confirmation of domain/company ownership and availability. No identifier was renamed. Changing applicationId/bundle ID creates a different installed app/store identity and affects updates, local sessions, keychain scope, push registrations, links and association files. Decide before first publication.

## Capability matrix

All READY/PARTIAL statements below concern repository wiring, not real-device certification.

| Capability | Android / iOS metadata | Runtime and canonical behavior | Status |
| --- | --- | --- | --- |
| Camera | CAMERA; optional hardware / NSCameraUsageDescription | Existing HTML file input accepts multiple images; platform chooser may offer camera. Camera plugin installed but canonical picker does not invoke its getPhoto API. Native camera availability/cancel/denial need proof. | PARTIAL |
| Photos/files | No broad media/storage read permission / NSPhotoLibraryUsageDescription | User-selected JPEG/PNG/WebP through file input; up to 12 images. No gallery-wide access or save-to-gallery request. | PARTIAL |
| Location | COARSE + FINE added / WhenInUse description added | Existing navigator.geolocation via explicit click. Capacitor Android BridgeWebChromeClient requests these runtime permissions. No background permission, watcher or resume auto-acquisition. | PARTIAL |
| Share | No dangerous permission / no usage description needed | Existing canonical navigator.share UI now forwards to Share plugin when present; canonical HTTPS link host, clipboard/social fallbacks remain. | PARTIAL |
| Deep links | Custom scheme + verified HTTPS intent / URL scheme + associated domain entitlement | Cold getLaunchUrl and warm appUrlOpen validate host/scheme, preserve canonical routes and reject foreign/credentialed URLs. | PARTIAL |
| Network | Network plugin contributes ACCESS_NETWORK_STATE / no usage prompt | Canonical fetch errors/polling remain. Plugin installed; no new network banner/retry semantics or offline queue. | PARTIAL |
| External browser | Browser plugin installed / no usage prompt | Canonical `_blank` maps/social/legal/export links require device checks. Relative non-API asset/navigation URLs are not rewritten by fetch/XHR adapter. Hosted payment return remains a financial integration dependency. | PARTIAL |
| Push / secure storage | Plugins installed; local Keystore/Keychain implementation exists | Canonical React app does not register push or store its Supabase session in this plugin. No permission prompts added. | BLOCKED for activation / integration |

## Auth and session review — ISSUES

`web/src/api.ts`, `session.ts`, `ownerMode.ts`, `auth.tsx`, `authRedirect.ts` are the canonical sources. Email/password auth uses public Supabase configuration fetched from `/api/preview/auth-config`. Access and refresh tokens persist under localStorage `siton_session_v1`; passwords are not persisted by that session module. Expiry refresh and one 401 retry exist; the heartbeat keeps the session fresh. Logout clears the local shared session/legacy tokens; this is not evidence of immediate global revocation of every issued access token. See [Supabase sessions](https://supabase.com/docs/guides/auth/sessions).

Guest mode suppresses seller/admin token getters and privileged API auth; it intentionally retains the underlying session so exiting guest mode restores the account. Buyer tracking instead uses its explicit participant link token. A logged-out seller route presents login; logged-in routes still depend on server authorization. Link routing does not grant capabilities. SessionStorage-only UI/draft state may not survive process death; reinstall/local-data clearing removes WebView local storage. Switching from legacy `/app` to canonical `/preview/` is not a session migration.

RC blockers: review and integrate native secure persistence for refresh tokens with async bootstrap/refresh/logout semantics and guest suppression tests; prove cookies/Capacitor native HTTP, Supabase refresh and process-death recovery on both platforms. Existing secure plugin alone does not resolve this. Auth email redirects now select the public HTTPS host, but Supabase redirect allowlist and hosted association/email-return flow still need external verification. Raw auth-fragment callbacks are not accepted as arbitrary deep-link routes. No database/auth-provider settings were changed. A read-only docs check was performed; the changelog markdown endpoint could not be rendered by the browsing tool.

## Geolocation acceptance

Canonical rule is unchanged (`web/src/geo.ts`): location optional; manual address remains valid; explicit click only; normal accuracy first, one high-accuracy retry only after timeout/unavailable/watchdog; denial never retries; late callbacks ignored. All 27 existing deterministic strategy checks passed. Native permission UI may not expose the browser Permissions API, so permanent denial may map to the existing generic denial/manual fallback rather than a settings-specific state.

Test on device: granted/approximate-only, denied, deny permanently, OS location disabled, provider unavailable, two timeouts, late callback after watchdog, background during prompt, resume after settings change. Resume must not trigger a new request automatically; the next explicit click must re-evaluate. No device result is claimed.

## Seller images

`web/src/images.tsx`: JPEG/PNG/WebP accepted, zero-byte and >50 MiB rejected; HEIC/HEIF rejected with conversion guidance; max 12; chooser cancel produces no update. <=1.5 MB passes through; larger images decode with EXIF orientation, resize long edge to 2560 and compress toward <=4 MiB. Small-image orientation depends on rendering metadata rather than normalization. Native memory pressure, createImageBitmap support on target WKWebView, JPEG orientation, multi-selection and camera return after process death need acceptance. XHR upload URL is mapped to configured API; authorization, JSON payload, progress handlers and backend contract are unchanged. No real upload was executed. DB-backed image regression could not authenticate to local Postgres.

## Routes and domain association

| Product route | Native accepted URL |
| --- | --- |
| Public deal | `https://HOST/d/ID?ref=CODE` -> `/preview/?ref=CODE#/deal/ID`, or `/preview/#/deal/ID` |
| Seller login/dashboard | `/preview/#/seller` |
| Seller create/draft | `/preview/#/seller/new`, `/preview/#/seller/deal/ID`, `/preview/#/seller/deal/ID/preview` |
| Buyer resume | `/preview/#/track/PARTICIPANT?t=TOKEN` (never put a real token in logs/screenshots) |
| Seller inquiries/thread | `/preview/#/seller/inquiries`, `/preview/#/seller/inquiries/THREAD` |
| Buyer inquiry | No standalone buyer inquiry-thread route found in canonical App/Track router; do not invent one. |

Custom scheme equivalent: `siton://app/preview/#/seller`. Scheme routing is not domain ownership verification. Android path filters now cover `/preview/` and `/d/`. `mobile/association-templates/` contains deliberately invalid, unhosted templates for `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`. Replace certificate fingerprint/package ID or Apple team/bundle ID only after account/signing decisions. Host on the exact configured HTTPS domain without redirects, verify served JSON/content type and OS association. Neither Apple nor Android association is claimed live. See [Capacitor App API](https://capacitorjs.com/docs/apis/app).

## Branding

Native iOS icon is a teal/cream C with orange bar (1024x1024). Android launcher sizes include mdpi 48 and xxxhdpi 192, with intermediate densities/adaptive foreground/background resources. iOS light/dark splash 1x/2x/3x catalogs exist; Android portrait/landscape/night density resources exist. `assets/logo.svg` currently uses orange while the checked-in native icon uses teal; canonical `web/public/brand` contains the newer C-ton marks. Therefore current `mobile:assets` cannot be claimed to reproduce the checked-in approved native art. No assets were regenerated or redesigned.

Exact owner deliverables: approve one native icon master (1024 opaque PNG plus adaptive foreground/background layers), confirm safe areas and launcher round crop, approve matching light/dark splash master and Android 12 launch presentation, then regenerate all densities/catalog entries with a pinned command and review against canonical branding. Existing sizes alone are not visual acceptance.
