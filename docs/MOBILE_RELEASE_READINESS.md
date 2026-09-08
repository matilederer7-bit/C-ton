# Mobile release readiness

**Disposition: repository readiness improved; not an Android or iOS release candidate yet.** No store submission, production signing, accounts, certificates, real payments, external uploads or master merge were performed.

Base: `8ead7c828e6d6233bf7d17bf7f67d1a67ad35767`.
Branch: `codex/mobile-release-readiness`.
Worktree: `C:\Users\Lenovo\Documents\C-ton-codex-mobile`.
Hosted preview: https://siton-staging-web.onrender.com/preview/ (this branch is not deployed there).

## DONE IN REPO

- Replaced stale legacy `/app` packaging with a clean build of canonical `web/` at `/preview/`; no hosted/Base44 fallback.
- Added source/asset SHA-256 manifest and read-only verification of both native copies and actual parsed Capacitor/XML/plist settings. Direct Android preBuild invokes the gate.
- Added native-only API fetch/XHR mapping, canonical public share/auth-email origins, native Share forwarding, validated cold/warm links including public `/d/` deals. Web origin behavior remains unchanged.
- Added foreground location metadata while preserving all canonical geolocation semantics; disabled Android backup and explicit release debugging; narrowed FileProvider external paths.
- Added deliberate unhosted Android/Apple association templates and mobile CI. Updated existing CI mobile step to install/build/sync the canonical frontend before verification.
- Completed [technical inventory](MOBILE_TECHNICAL_INVENTORY.md), [data inventory](MOBILE_DATA_INVENTORY.md), [store payment matrix](MOBILE_STORE_PAYMENT_POLICY_MATRIX.md) and this acceptance runbook.
- Proved 12 restored negative controls: missing config, missing bundle, wrong source, stale source, stale local/native assets, release debugging, cleartext, Android/iOS location metadata, camera description, version.

## Executed validation / limitations

| Check | Result |
| --- | --- |
| Locked dependency installation | PASS: root and web npm ci; Node 24.13.1. No credentials copied from other worktrees. |
| Root TypeScript / test compilation | PASS |
| Canonical React TypeScript + Vite mobile build | PASS, 68 transformed modules after native URL helper |
| Capacitor sync Android + iOS static / native gate | PASS |
| Repeated clean build determinism | Byte-identical build manifest and asset hashes checked; no revision/time randomization |
| Mobile behavioral suite | PASS: URL boundary, fetch/XHR preservation, allowed and hostile links, route query/fragment, repeated cold-link guard, web/native public origins |
| Negative controls | PASS, 12, every original restored in finally blocks; baseline gate recovered |
| Geolocation regression | PASS, 27 cases |
| Existing RTL/accessibility regression | PASS, 4 assertions (legacy frontend baseline) |
| Lint / backend secret scan | PASS; 117 scanned files; no backend modifications |
| Architecture gate | PASS. Its legacy Base44 wording is not evidence that the new bundle uses Base44. |
| Demo build | PASS; this command packages the separate legacy frontend/server surface, not the canonical mobile build |
| DB auth-session regression | BLOCKED: process failed at local PostgreSQL authentication (28P01), before session proof |
| DB image regression | BLOCKED: preliminary static assertion passed, then same local PostgreSQL authentication failure |
| Android wrapper --version and clean assembleDebug/assembleRelease/bundleRelease | BLOCKED before Gradle startup: JAVA_HOME unset, java not found. No SDK/ADB found at checked standard paths or PATH. |
| iOS build | BLOCKED_EXTERNAL: Windows, no macOS/Xcode execution. Static checks passed; no archive exists. |
| DEVICE_E2E | BLOCKED: no available emulator/device/toolchain |
| Staging HTTP smoke | `/preview/` HTTP 200 and canonical root after one initial timeout; `/api/preview/meta` and `/api/preview/auth-config` HTTP 200. Only status/type/length logged, no auth values. No login/write/payment smoke. Hash routes share the same HTML; this is not browser/device route execution. |
| Release secret scan | PASS for source/backend scan and packaged HTML/JS/CSS/JSON known private-key/secret-key patterns. No APK/AAB to scan; not an exhaustive secret-detection guarantee. |
| Production release gate | Default placeholders are intentionally rejected by `--release`; unsigned compilation is a distinct readiness step. |

Counts: **TESTS_FAILED = 2 failed integration-suite executions**, both infrastructure-blocked; **TESTS_BLOCKED = 7 work items** (those 2 DB suites + Android debug/release/AAB + iOS build + device E2E). These counts overlap for the two DB suites; no application assertion failure was established by them. Broader DB/E2E proof is still open; no financial branch or financial suite was executed.

## ANDROID EXTERNAL

Provide JDK 21, Android SDK platform 36/build tools, an emulator or USB device and local SDK license acceptance. The repo records Gradle 8.14.3 / AGP 8.13.0; running Gradle version and SDK inventory could not be captured without Java. Re-run from the isolated branch root:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd ci --prefix web --ignore-scripts --no-audit --no-fund
$env:SITON_API_BASE_URL = 'https://siton-staging-web.onrender.com'
$env:SITON_APP_LINK_HOST = 'siton-staging-web.onrender.com'
npm.cmd run mobile:sync
npm.cmd run test:mobile-readiness
java -version
.\android\gradlew.bat --version
.\android\gradlew.bat -p android clean assembleDebug assembleRelease bundleRelease
```

Use an installed JDK/SDK's actual paths for JAVA_HOME/ANDROID_HOME; no guessed path or production key is needed. Android preBuild requires Node and both synced shells. Expected artifacts **if compilation passes**, not produced in this session:

- `android/app/build/outputs/apk/debug/app-debug.apk` (standard debug signing only).
- `android/app/build/outputs/apk/release/app-release-unsigned.apk`.
- `android/app/build/outputs/bundle/release/app-release.aab` (no production signing configured).

Archive the build logs, merged release manifest and APK analyzer permission/debuggable output. Inspect transitive components, API origins, `usesCleartextTraffic`, network security, FileProvider grants, WebView debugging and actual signing status. Do not call these production-ready artifacts. Host association JSON only after the intended certificate fingerprint/domain is known. Owner-approved identifier/versioning and visual assets are still required before store publication.

## IOS EXTERNAL

On a Mac with a Capacitor-8-compatible Xcode/SDK installed, no developer-account actions are required for the unsigned simulator compilation below:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix web --ignore-scripts --no-audit --no-fund
export SITON_API_BASE_URL=https://siton-staging-web.onrender.com
export SITON_APP_LINK_HOST=siton-staging-web.onrender.com
npm run mobile:sync
npm run test:mobile-readiness
xcodebuild -version
xcodebuild -list -project ios/App/App.xcodeproj
xcodebuild -resolvePackageDependencies -project ios/App/App.xcodeproj -scheme App
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .ci-artifacts/ios-derived CODE_SIGNING_ALLOWED=NO \
  SITON_APP_LINK_HOST=siton-staging-web.onrender.com build
```

Confirm `App` appears in `-list`; if Xcode has not generated its default scheme, create/share the App target scheme locally and record that prerequisite. Use a compatible modern Xcode; the deployment target 15.0 does not specify the required build-tool version. Later unsigned device compilation can use `-sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`; this is not an installable signed archive. Capture SwiftPM resolution, plugin compilation, Info.plist validation, privacy manifests/required-reason APIs and entitlements. Test scene cold/warm links, file chooser, WKWebView image decoding, safe areas, iPad orientations and background/resume. Signing/export/TestFlight comes only after owner/account work.

## LEGAL/COMPANY EXTERNAL

Confirm company/legal identity and brand ownership, privacy/data processor inventory, retention/deletion and account deletion requirements, terms/refund/support URLs, moderation/reporting for user content, geographic availability and required consumer disclosures. Technical inventories do not supply legal wording. Existing native art differs from canonical web branding and the asset source; owner must approve exact source and generated outputs.

## STORE ACCOUNT EXTERNAL

Apple/Google developer accounts, company verification and any enrollment prerequisites, team identifiers, application registrations, signing ownership/backup, Play App Signing, App Store Connect/Play Console metadata, ratings, privacy/data forms, support contact and screenshots. No account opened or certificate/key generated here. Push activation is separate and not needed to validate core local-shell behavior.

## PAYMENT POLICY REVIEW

Use the dedicated matrix. Physical/offline fulfillment appears distinct from in-app digital consumption, but voucher/ticket content and proposed services need actual-offer review. Standalone Service is not a canonical deal type at this base. Provider callbacks, return reconciliation and any backend/CORS/cookie/payment changes belong to the financial/shared-backend track and were not implemented here.

## OWNER ACCEPTANCE

Android acceptance is **not ready to start now** because no APK/device proof exists. Mac build handoff **is ready as an unsigned build attempt**, not as a passing iOS build.

After debug compilation, install only on a test device:

```powershell
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -a android.intent.action.VIEW -d 'siton://app/preview/#/seller' il.co.siton.preview
adb shell am start -W -a android.intent.action.VIEW -d 'siton://app/preview/#/seller/inquiries' il.co.siton.preview
```

Use fixture deal/thread/participant IDs supplied by the staging owner; never publish real buyer tokens in logs. Keep an acceptance sheet with OS/device/WebView version, branch SHA, build manifest source hash, artifact hash, expected/actual, screenshot and pass/block result:

1. Cold launch and relaunch offline: canonical C-ton UI/assets load; API failure is truthful; no old `/app` screen or hosted fallback. Reconnect and explicitly retry.
2. Logged out: public deal opens, seller routes prompt login, buyer full token link retains its token. Logged in: seller draft/inquiries open with server-authorized data. Test cold and warm custom links; domain links only after association is hosted and independently verified.
3. Staging test seller: sign in, refresh, background/kill/reopen, expiry refresh, guest mode suppression, guest exit and logout. Prove guest mode cannot send seller/admin privilege and logout does not restore local tokens. Secure refresh-token storage remains an RC blocker.
4. Location: granted/approximate, denied/permanently denied, OS off, unavailable, timeouts, prompt backgrounding, settings-change resume; no automatic location read and manual address remains usable.
5. Images: chooser camera/library, one/multiple, cancel, permission denial, 0-byte/unsupported/HEIC, <=1.5 MB EXIF image, large 50 MB boundary, rotated photo and low-memory decode. Stage locally first; any staging upload requires a test seller/draft and existing staging-safe storage. No production uploads.
6. Share: native sheet/cancel, clipboard, referral URL and public host (never localhost); verify recipient opens the right public deal. Check external maps/social/legal links and authenticated export behavior; report native browser/cookie issues as dependencies.
7. Keyboard/RTL/notches/back gesture, orientation, accessibility labels, dark/light splash, native icon, suspended network and process-death restoration. No real payment. Financial return acceptance is a separate session.

## Remaining blockers / merge disposition

1. Java/SDK/device and Mac/Xcode build evidence; final merged manifests/binary inspection absent.
2. Native secure session integration and real-device Supabase refresh/guest/logout/cookie proof.
3. External browser/download/relative-image behavior and permission/image memory/EXIF acceptance.
4. Hosted associations and auth redirect allowlist/domain proof; native app identifier decision.
5. Approved reproducible native branding; store/privacy/account/company inputs; actual-offer billing review.
6. Two DB-backed non-financial regressions need a provisioned isolated test database; do not reuse or modify Claude's database/branch.

SAFE_TO_MERGE_MOBILE_BRANCH: **NO** pending DB regression proof and native integration review/acceptance. This is a reviewable readiness branch, not a release claim. No master merge is authorized by this task. Next step: provision JDK 21/SDK 36 and isolated DB, run the listed builds/regressions, then execute the Android staging-device sheet; run unsigned Xcode compilation in parallel on a Mac.
