const capacitor = globalThis.Capacitor;
const plugins = capacitor?.Plugins || {};
const isNative = Boolean(capacitor?.isNativePlatform?.());

function metaContent(name) {
  const value = String(document.querySelector(`meta[name="${name}"]`)?.content || "").trim();
  return value.startsWith("__") ? "" : value;
}

function configuredHttpsOrigin(name) {
  const raw = metaContent(name);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : "";
  } catch {
    return "";
  }
}

function secureKey(key) {
  const normalized = String(key || "");
  if (!/^siton_[a-z0-9_]{1,80}$/.test(normalized)) throw new Error("secure_storage_key_invalid");
  return normalized;
}

function nativeOnly(plugin, method) {
  const fn = plugins?.[plugin]?.[method];
  if (typeof fn !== "function") throw new Error(`native_capability_unavailable:${plugin}.${method}`);
  return fn.bind(plugins[plugin]);
}

const secureStorage = {
  async set(key, value) {
    const serialized = String(value || "");
    if (!serialized || serialized.length > 65_536) throw new Error("secure_storage_value_invalid");
    return nativeOnly("SitonSecureStorage", "set")({ key: secureKey(key), value: serialized });
  },
  async get(key) { const result = await nativeOnly("SitonSecureStorage", "get")({ key: secureKey(key) }); return result?.value ?? null; },
  async remove(key) { return nativeOnly("SitonSecureStorage", "remove")({ key: secureKey(key) }); }
};

globalThis.SitonMobile = Object.freeze({
  isNative,
  apiBaseUrl: configuredHttpsOrigin("siton-api-base-url"),
  appLinkHost: metaContent("siton-app-link-host").toLowerCase(),
  async shareDeal(url, title = "Siton") {
    if (plugins.Share?.share) return plugins.Share.share({ title, url, dialogTitle: "שיתוף עסקה" });
    if (navigator.share) return navigator.share({ title, url });
    await navigator.clipboard.writeText(url);
    return { activityType: "clipboard" };
  },
  async captureDealImage() {
    return nativeOnly("Camera", "getPhoto")({ quality: 82, resultType: "base64", source: "PROMPT", correctOrientation: true, saveToGallery: false });
  },
  async registerPush() {
    const permission = await nativeOnly("PushNotifications", "requestPermissions")();
    if (permission?.receive !== "granted") return { granted: false };
    await nativeOnly("PushNotifications", "register")();
    return { granted: true };
  },
  async networkStatus() {
    if (plugins.Network?.getStatus) return plugins.Network.getStatus();
    return { connected: navigator.onLine, connectionType: "unknown" };
  },
  onNetworkChange(listener) {
    if (!plugins.Network?.addListener) return { remove: async () => undefined };
    return plugins.Network.addListener("networkStatusChange", listener);
  },
  onAppStateChange(listener) {
    if (!plugins.App?.addListener) return { remove: async () => undefined };
    return plugins.App.addListener("appStateChange", listener);
  },
  async openHostedPayment(url) {
    const target = new URL(String(url));
    if (target.protocol !== "https:") throw new Error("hosted_payment_https_required");
    if (plugins.Browser?.open) return plugins.Browser.open({ url: target.toString(), presentationStyle: "popover" });
    location.assign(target.toString());
  },
  onDeepLink(listener) {
    if (!plugins.App?.addListener) return { remove: async () => undefined };
    return plugins.App.addListener("appUrlOpen", ({ url }) => listener(new URL(url)));
  },
  secureStorage
});

if ("serviceWorker" in navigator && !isNative) {
  addEventListener("load", () => navigator.serviceWorker.register("/app/service-worker.js", { scope: "/app" }).catch(() => undefined));
}
