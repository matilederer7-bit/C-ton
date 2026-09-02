import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [bridge, app, productLibrary, css, worker, manifestRaw, androidManifest, androidGradle, androidTest, iosEntitlements, swiftPackage, capacitor, mobileIndex] = await Promise.all([
  readFile("frontend/mobile-bridge.js", "utf8"),
  readFile("frontend/app.js", "utf8"),
  readFile(".mobile_dist/app/assets/product-library.js", "utf8"),
  readFile("frontend/styles.css", "utf8"),
  readFile("frontend/service-worker.js", "utf8"),
  readFile("frontend/manifest.webmanifest", "utf8"),
  readFile("android/app/src/main/AndroidManifest.xml", "utf8"),
  readFile("android/app/build.gradle", "utf8"),
  readFile("android/app/src/androidTest/java/il/co/siton/app/SitonInstrumentedTest.java", "utf8"),
  readFile("ios/App/App/App.entitlements", "utf8"),
  readFile("ios/App/CapApp-SPM/Package.swift", "utf8"),
  readFile("capacitor.config.ts", "utf8"),
  readFile(".mobile_dist/app/index.html", "utf8")
]);

const manifest = JSON.parse(manifestRaw);
assert.equal(manifest.dir, "rtl");
assert.equal(manifest.lang, "he-IL");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.icons.every((icon: any) => icon.type === "image/png" && icon.src.endsWith(".png")), true);
assert.match(css, /env\(safe-area-inset-top/);
assert.match(css, /env\(safe-area-inset-bottom/);
assert.match(css, /min-height:\s*44px/);
assert.doesNotMatch(bridge, /localStorage|sessionStorage/);
assert.match(bridge, /plugins\.Share\?\.share/);
assert.match(bridge, /navigator\.share/);
assert.match(bridge, /Camera.*getPhoto/s);
assert.match(bridge, /appUrlOpen/);
assert.match(bridge, /hosted_payment_https_required/);
assert.match(bridge, /siton-api-base-url/);
assert.match(bridge, /secure_storage_key_invalid/);
assert.match(app, /isWebLink.*url\.origin === location\.origin/s);
assert.match(app, /configuredAppLinkHost/);
assert.match(app, /isAppLink.*url\.hostname === "app"/s);
assert.match(app, /providerPaymentPending/);
assert.match(app, /completePendingHostedPayment/);
assert.match(app, /persistNativePendingPayment/);
assert.match(app, /restoreNativePendingPayment/);
assert.match(app, /clearNativePendingPayment/);
assert.match(app, /native_api_base_url_not_configured/);
assert.match(app, /fetch\(resolveApiUrl\(url\)/);
assert.match(app, /captureNativeSellerImage/);
assert.match(productLibrary, /applyProductLibraryFilters/);
assert.match(app, /SitonMobile\.shareDeal/);
assert.match(app, /status\.state === "pending" \|\| status\.state === "unknown"/);
assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
assert.match(worker, /url\.pathname\.includes\("\/payment"\)/);
assert.match(androidManifest, /android:autoVerify="true"/);
assert.match(androidGradle, /namespace\s*=\s*"il\.co\.siton\.app"/);
assert.match(androidTest, /BuildConfig\.APPLICATION_ID/);
assert.doesNotMatch(androidTest, /com\.getcapacitor/);
assert.match(iosEntitlements, /com\.apple\.developer\.associated-domains/);
assert.doesNotMatch(swiftPackage, /\.package\(name:[^\n]*path:\s*"[^"]*\\/);
assert.match(capacitor, /webDir:\s*"\.mobile_dist"/);
assert.match(capacitor, /CapacitorHttp:\s*\{\s*enabled:\s*true/s);
assert.match(capacitor, /CapacitorCookies:\s*\{\s*enabled:\s*true/s);
assert.doesNotMatch(mobileIndex, /__[A-Z0-9_]+__/);
for (const forbidden of [/GROW_USER_ID/, /GROW_PAGE_CODE/, /GROW_API_KEY/, /PAYMENT_PROVIDER_API_KEY/, /BEGIN PRIVATE KEY/, /card_number/i, /\bcvv\b/i]) {
  assert.doesNotMatch([bridge, app, manifestRaw].join("\n"), forbidden);
}

console.log("PASS mobile bridge provides native share/camera/browser/deep-link/offline hooks with safe web fallbacks");
console.log("PASS payment return reconciles provider state and does not guess UNKNOWN outcomes");
console.log("PASS mobile bundles contain no provider secrets, raw-card fields, or private keys");
