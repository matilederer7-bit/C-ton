/* Loaded only by the packaged native index, before the canonical React entry. */
(function () {
  const cap = globalThis.Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const cfg = globalThis.SitonNativeConfig;
  const origin = new URL(cfg.apiOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw Error('MOBILE_API_ORIGIN_INVALID');
  function apiUrl(input) {
    const url = new URL(String(input), location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      if (origin.hostname.endsWith('.invalid')) throw Error('MOBILE_API_NOT_CONFIGURED');
      return origin.origin + url.pathname + url.search;
    }
    return String(input);
  }
  const fetchOriginal = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    if (input instanceof Request) {
      const target = apiUrl(input.url);
      return fetchOriginal(target === input.url ? input : new Request(target, input), init);
    }
    return fetchOriginal(apiUrl(input), init);
  };
  const openOriginal = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) { return openOriginal.call(this, method, apiUrl(url), ...args); };
  function routeLink(raw) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    const allowed = (url.protocol === 'https:' && url.host === cfg.linkHost) || (url.protocol === 'siton:' && url.host === 'app');
    if (!allowed || url.username || url.password) return false;
    if (/^\/d\/[A-Za-z0-9_-]+$/.test(url.pathname)) url.hash = '#/deal/' + url.pathname.slice(3);
    else if (!['/preview/', '/preview'].includes(url.pathname)) return false;
    // Preserve canonical hash/query routing; server authorization still decides access.
    if (!/^#\/(?:deal|seller|track|support|reset-password)(?:[/?]|$)/.test(url.hash)) return false;
    const target = '/preview/' + url.search + url.hash;
    if (new URL(target, location.href).href !== location.href) location.assign(target);
    return true;
  }
  // Canonical ShareActions feature-detects navigator.share. Keep URL generation in mobileUrls.ts.
  if (cap.Plugins?.Share?.share) {
    Object.defineProperty(navigator, 'share', {configurable: true, value: async data => {
      if (data.files) throw new TypeError('Native file sharing is not supported by this integration');
      return cap.Plugins.Share.share({title: data.title, text: data.text, url: data.url});
    }});
  }
  const app = cap.Plugins?.App;
  app?.addListener('appUrlOpen', ({url}) => routeLink(url));
  app?.getLaunchUrl().then(value => { if(value?.url) routeLink(value.url); }).catch(() => undefined);
  // No automatic location acquisition or permission request on resume.
  globalThis.SitonNative = Object.freeze({apiUrl, routeLink});
})();
