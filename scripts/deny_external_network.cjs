const net = require("node:net");

function hostFromArgs(args) {
  if (typeof args[0] === "object" && args[0]) return String(args[0].host || args[0].hostname || "localhost").toLowerCase();
  if (typeof args[0] === "string" && !/^\d+$/.test(args[0])) return "local-pipe";
  return String(args[1] || "localhost").toLowerCase();
}

function allowed(host) {
  return ["localhost", "127.0.0.1", "::1", "[::1]", "local-pipe", ""].includes(host);
}

const originalConnect = net.connect.bind(net);
net.connect = function (...args) {
  const host = hostFromArgs(args);
  if (!allowed(host)) throw new Error(`NO_NETWORK_REHEARSAL_BLOCKED:${host}`);
  return originalConnect(...args);
};
net.createConnection = net.connect;

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowed(url.hostname.toLowerCase())) throw new Error(`NO_NETWORK_REHEARSAL_BLOCKED:${url.hostname}`);
    return originalFetch(input, init);
  };
}
