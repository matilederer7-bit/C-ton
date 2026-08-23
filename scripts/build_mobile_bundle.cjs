const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

const root = process.cwd();
const source = join(root, "frontend");
const output = join(root, ".mobile_dist");
const appOutput = join(output, "app");
const assetsOutput = join(appOutput, "assets");

function requiredHttpsOrigin(value, fallback, name) {
  const parsed = new URL(String(value || fallback));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
}

function requiredHost(value, fallback, name) {
  const host = String(value || fallback).trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error(`${name} must be a DNS hostname`);
  }
  return host;
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "uncommitted";
  }
}

const apiBaseUrl = requiredHttpsOrigin(process.env.SITON_API_BASE_URL, "https://api.siton.invalid", "SITON_API_BASE_URL");
const appLinkHost = requiredHost(process.env.SITON_APP_LINK_HOST, "app.siton.invalid", "SITON_APP_LINK_HOST");
const revision = gitRevision();

if (existsSync(output)) rmSync(output, { recursive: true, force: true });
mkdirSync(assetsOutput, { recursive: true });
mkdirSync(join(appOutput, "icons"), { recursive: true });

let index = readFileSync(join(source, "index.html"), "utf8");
index = index
  .replaceAll("__C_TON_ASSET_VERSION__", `mobile-${revision}`)
  .replaceAll("__SITON_API_BASE_URL__", apiBaseUrl)
  .replaceAll("__SITON_APP_LINK_HOST__", appLinkHost);

writeFileSync(join(output, "index.html"), index);
writeFileSync(join(appOutput, "index.html"), index);
for (const file of ["app.js", "styles.css", "mobile-bridge.js"]) {
  cpSync(join(source, file), join(assetsOutput, file));
}
for (const file of ["manifest.webmanifest", "offline.html", "service-worker.js"]) {
  cpSync(join(source, file), join(appOutput, file));
}
cpSync(join(source, "icons"), join(appOutput, "icons"), { recursive: true });

const bundleText = [index, ...["app.js", "mobile-bridge.js", "manifest.webmanifest"].map((file) =>
  readFileSync(join(file === "manifest.webmanifest" ? appOutput : assetsOutput, file), "utf8")
)].join("\n");
for (const forbidden of [
  "GROW_API_KEY",
  "GROW_USER_ID",
  "GROW_PAGE_CODE",
  "PAYMENT_PROVIDER_API_KEY",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "BEGIN PRIVATE KEY"
]) {
  if (bundleText.includes(forbidden)) throw new Error(`mobile bundle contains forbidden server secret marker: ${forbidden}`);
}
if (/__[A-Z0-9_]+__/.test(index)) throw new Error("mobile index contains an unresolved build placeholder");

writeFileSync(join(output, "mobile-build.json"), `${JSON.stringify({
  schema_version: 1,
  revision,
  api_origin: new URL(apiBaseUrl).origin,
  app_link_host: appLinkHost,
  placeholder_configuration: new URL(apiBaseUrl).hostname.endsWith(".invalid") || appLinkHost.endsWith(".invalid")
}, null, 2)}\n`);

console.log(`MOBILE_BUNDLE_READY output=.mobile_dist start=/app revision=${revision} api_origin=${new URL(apiBaseUrl).origin} app_link_host=${appLinkHost}`);
