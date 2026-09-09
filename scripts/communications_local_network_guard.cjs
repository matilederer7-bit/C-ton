// Rehearsal-only preload, inherited by its child processes. Notification
// delivery must never open an external socket, even if a provider regresses.
const net = require("node:net");
const originalConnect = net.Socket.prototype.connect;
let blocked = 0;
net.Socket.prototype.connect = function (...args) {
  // net.createConnection passes an already-normalized argument array to the
  // socket; direct socket.connect calls pass positional arguments instead.
  const options = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
  const host = String(options.host || "localhost").toLowerCase();
  if (options.path || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    blocked++;
    throw new Error("COMMUNICATIONS_EXTERNAL_NETWORK_BLOCKED");
  }
  return originalConnect.apply(this, args);
};
process.on("exit", () => {
  console.log(`COMMUNICATIONS_NETWORK_GUARD external_connections=0 blocked_attempts=${blocked}`);
  if (blocked) process.exitCode = 1;
});
