const fs = require("node:fs");

function read(file) { return fs.readFileSync(file, "utf8"); }
function assert(condition, message) { if (!condition) throw new Error(`MOBILE_GATE_FAIL ${message}`); }

for (const file of [
  "capacitor.config.ts",
  ".mobile_dist/mobile-build.json",
  ".mobile_dist/app/index.html",
  ".mobile_dist/app/assets/app.js",
  ".mobile_dist/app/assets/product-library.js",
  ".mobile_dist/app/assets/mobile-bridge.js",
  "frontend/manifest.webmanifest",
  "frontend/service-worker.js",
  "frontend/mobile-bridge.js",
  "android/gradlew",
  "android/app/src/main/AndroidManifest.xml",
  "android/app/build.gradle",
  "android/app/src/androidTest/java/il/co/siton/app/SitonInstrumentedTest.java",
  "android/app/src/main/res/xml/network_security_config.xml",
  "ios/App/App.xcodeproj/project.pbxproj",
  "ios/App/CapApp-SPM/Package.swift",
  "ios/App/App/Info.plist",
  "ios/App/App/App.entitlements",
  "mobile-plugins/siton-secure-storage/android/src/main/java/il/co/siton/securestorage/SitonSecureStoragePlugin.java",
  "mobile-plugins/siton-secure-storage/ios/Sources/SitonSecureStoragePlugin/SitonSecureStoragePlugin.swift"
]) assert(fs.existsSync(file), `${file} missing`);

const manifest = JSON.parse(read("frontend/manifest.webmanifest"));
assert(manifest.display === "standalone", "PWA display must be standalone");
assert(manifest.dir === "rtl" && manifest.lang === "he-IL", "PWA Hebrew RTL contract missing");
assert(Array.isArray(manifest.icons) && manifest.icons.some((icon) => String(icon.purpose).includes("maskable") && icon.sizes === "512x512"), "512px maskable icon missing");
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const icon of manifest.icons) {
  assert(icon.type === "image/png" && String(icon.src).endsWith(".png"), `PWA icon MIME/path mismatch: ${icon.src}`);
  const iconPath = String(icon.src).replace(/^\/app\//, "frontend/");
  assert(fs.existsSync(iconPath), `PWA icon file missing: ${iconPath}`);
  assert(fs.readFileSync(iconPath).subarray(0, pngMagic.length).equals(pngMagic), `PWA icon bytes are not PNG: ${iconPath}`);
}
const worker = read("frontend/service-worker.js");
for (const forbidden of ["/api/", "/deals/", "/payment", "/track/", "/recovery/"]) assert(worker.includes(forbidden), `financial/offline cache exclusion missing: ${forbidden}`);
const bridge = read("frontend/mobile-bridge.js");
for (const capability of ["Share", "Camera", "PushNotifications", "Network", "Browser", "appUrlOpen", "SitonSecureStorage"]) assert(bridge.includes(capability), `mobile capability missing: ${capability}`);
assert(bridge.includes("hosted_payment_https_required"), "hosted payments must require HTTPS");
assert(!/localStorage|sessionStorage/.test(bridge), "mobile bridge must not persist secrets in web storage");
assert(bridge.includes("apiBaseUrl") && bridge.includes("siton-api-base-url"), "native API origin boundary missing");
assert(bridge.includes("appLinkHost") && bridge.includes("siton-app-link-host"), "native App Link host boundary missing");
assert(bridge.includes("secure_storage_key_invalid") && bridge.includes("65_536"), "web-to-native secure-storage bounds missing");
const app = read("frontend/app.js");
for (const integration of [
  "resolveApiUrl", "native_api_base_url_not_configured", "credentials: \"include\"",
  "persistNativePendingPayment", "restoreNativePendingPayment", "clearNativePendingPayment",
  "captureNativeSellerImage", "SitonMobile.shareDeal", "configuredAppLinkHost"
]) assert(app.includes(integration), `native app integration missing: ${integration}`);
const androidSecure = read("mobile-plugins/siton-secure-storage/android/src/main/java/il/co/siton/securestorage/SitonSecureStoragePlugin.java");
assert(androidSecure.includes("AndroidKeyStore") && androidSecure.includes("AES/GCM/NoPadding"), "Android Keystore AES-GCM implementation missing");
assert(androidSecure.includes("MAX_VALUE_BYTES") && androidSecure.includes("requiredKey"), "Android secure-storage input bounds missing");
const iosSecure = read("mobile-plugins/siton-secure-storage/ios/Sources/SitonSecureStoragePlugin/SitonSecureStoragePlugin.swift");
assert(iosSecure.includes("SecItemAdd") && iosSecure.includes("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"), "iOS Keychain device-only implementation missing");
assert(iosSecure.includes("maxValueBytes") && iosSecure.includes("regularExpression"), "iOS secure-storage input bounds missing");
assert(fs.existsSync("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"), "Android release icon missing");
assert(fs.existsSync("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"), "iOS store icon missing");
const androidManifest = read("android/app/src/main/AndroidManifest.xml");
assert(androidManifest.includes('android:autoVerify="true"') && androidManifest.includes('${sitonAppLinkHost}'), "Android App Link host must be build-configured");
assert(androidManifest.includes('android:usesCleartextTraffic="false"'), "Android cleartext traffic must be blocked");
const entitlements = read("ios/App/App/App.entitlements");
assert(entitlements.includes("applinks:$(SITON_APP_LINK_HOST)"), "iOS universal-link host must be build-configured");
const capacitor = read("capacitor.config.ts");
assert(capacitor.includes("process.env.SITON_APP_ID") && capacitor.includes("il.co.siton.preview"), "bundle identifier must use a documented placeholder/config boundary");
assert(capacitor.includes('webDir: ".mobile_dist"') && capacitor.includes('appStartPath: "/app"'), "Capacitor must load the purpose-built /app mobile bundle");
assert(/CapacitorHttp:\s*\{\s*enabled:\s*true/s.test(capacitor) && /CapacitorCookies:\s*\{\s*enabled:\s*true/s.test(capacitor), "native HTTP/cookie bridges must be enabled");
const mobileIndex = read(".mobile_dist/app/index.html");
assert(!/__([A-Z0-9_]+)__/.test(mobileIndex), "mobile bundle contains unresolved placeholders");
assert(mobileIndex.includes('name="siton-api-base-url"') && mobileIndex.includes('name="siton-app-link-host"'), "mobile bundle runtime endpoints missing");
const mobileBuild = JSON.parse(read(".mobile_dist/mobile-build.json"));
assert(mobileBuild.schema_version === 1 && typeof mobileBuild.api_origin === "string" && typeof mobileBuild.app_link_host === "string", "mobile build manifest invalid");
const androidGradle = read("android/app/build.gradle");
assert(/namespace\s*=\s*"il\.co\.siton\.app"/.test(androidGradle), "Android namespace must remain stable independently of release applicationId");
const androidTest = read("android/app/src/androidTest/java/il/co/siton/app/SitonInstrumentedTest.java");
assert(androidTest.includes("BuildConfig.APPLICATION_ID") && !androidTest.includes("com.getcapacitor"), "Android instrumented test package identity is stale");
const swiftPackage = read("ios/App/CapApp-SPM/Package.swift");
assert(!/\.package\(name:[^\n]*path:\s*"[^"]*\\/.test(swiftPackage), "SwiftPM local dependency contains Windows path separators");
const ignores = `${read(".gitignore")}\n${read("android/.gitignore")}`;
for (const signingArtifact of ["*.jks", "*.keystore", "*.p12", "*.mobileprovision", "GoogleService-Info.plist", "google-services.json"]) {
  assert(ignores.includes(signingArtifact), `signing/local artifact is not ignored: ${signingArtifact}`);
}
console.log(`MOBILE_GATE_PASS pwa=ready android_project=ready ios_project=ready native_capabilities=8 secure_storage=keystore+keychain app_links=configured external_placeholders=${mobileBuild.placeholder_configuration ? "pending" : "configured"}`);
