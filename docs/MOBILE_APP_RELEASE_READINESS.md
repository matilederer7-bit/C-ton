# Mobile App Release Readiness

Status: Android/iOS source packaging complete; signing, store accounts, final
domains, devices, and submission are external activation.

## Architecture

One RTL Hebrew frontend is packaged as a PWA and as Capacitor 8 Android/iOS
applications. This is not an unmodified remote WebView: the native shell owns
share, camera/photo selection, deep links, app lifecycle, network status,
hosted-payment browser return, push registration, safe areas, launch assets,
and encrypted pending-payment recovery.

`/app` is the canonical public Siton Mall on web, PWA, Android, and iOS. It uses
the same bounded public read API and the same canonical deal route as direct
links. Mall filters and cards must remain touch-safe without horizontal
overflow at 390px, common iPhone widths, and common Android widths. Seller
images reuse the existing native camera/photo bridge; there is no native-only
business logic.

`npm run mobile:build` creates ignored `.mobile_dist` with the correct `/app`
layout and replaces only non-secret API/App-Link inputs. `npm run mobile:sync`
copies that output into ignored generated native asset directories. Android,
iOS, icons, splash assets, plugin source, Gradle/Xcode metadata, and the local
secure-storage plugin are legitimate source artifacts and must be committed.

## Security and offline behavior

- native API calls allow only configured HTTPS `/api/*` and `/deals*` targets;
- Capacitor HTTP/cookie bridges preserve the server HttpOnly session boundary;
- hosted payment URLs must use HTTPS and return state is reconciled server-side;
- pending authorization recovery is allowlisted, size/TTL bounded, and stored
  with Android Keystore AES-GCM or iOS Keychain device-only accessibility;
- no raw card, provider secret, private key, or server credential enters a bundle;
- the service worker caches shell assets only and excludes API, deal, payment,
  tracking, and recovery truth; offline UI never presents cached money as live;
- App/Universal Links accept only the configured host or the `siton://app`
  scheme and only `/app` paths.

## Source and generated files

Legitimate source: `capacitor.config.ts`, `android/`, `ios/`, `assets/`,
`frontend/icons/`, PWA files, `frontend/mobile-bridge.js`, and
`mobile-plugins/siton-secure-storage/`.

Ignored generated/local artifacts: `.mobile_dist/`, copied Android/iOS public
assets and generated Capacitor configs/plugins, Gradle/Xcode/Pods build output,
dependency directories, signing keys, provisioning profiles, and Firebase
service files. Signing material must never be committed.

## Verified and external

`npm run mobile:verify`, `npm run test:mobile-readiness`, TypeScript, JavaScript
syntax, and `npm run mobile:sync` pass. Eight native plugins resolve on each
platform. The checked-in application ID, API origin, and App-Link host are
deliberate non-routable preview placeholders.

External only: choose final bundle IDs/domains, host association files, enter
API/App-Link values, provision signing/team/store accounts, configure push,
perform real Android/iOS device tests (camera, share, offline, deep links,
payment return, push), complete privacy/store metadata and screenshots, build
signed release archives, and submit for review.
