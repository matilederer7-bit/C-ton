// Test-only preload (NODE_OPTIONS=--import) for tests/release_tools/runtime_shutdown.test.cjs.
//
// On POSIX the test delivers a REAL signal (child.kill("SIGTERM")), which is
// what Docker / Render / compose send. Windows has no POSIX signals -
// child.kill("SIGTERM") is a hard TerminateProcess - so there the parent
// asks the child over the IPC channel to raise the signal event in-process,
// which runs exactly the same process.once("SIGTERM") handler the runtime
// installs. Nothing here changes runtime behaviour; without an IPC channel
// the module is inert.
if (typeof process.send === "function") {
  process.on("message", (message) => {
    if (message && typeof message.emit === "string" && /^SIG[A-Z]+$/.test(message.emit)) {
      process.emit(message.emit);
    }
  });
}
