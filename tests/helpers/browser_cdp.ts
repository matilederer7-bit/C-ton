// ── A small Chrome DevTools Protocol driver for the browser suites ─────────
//
// No Playwright/Puppeteer dependency: the repository already drives Chromium
// over raw CDP (tests/frontend_browser_smoke_validation.ts), and this module is
// that mechanism factored out so more than one suite can use it — with the
// pieces an i18n check needs on top: console errors, failed requests, layout
// measurements and screenshots.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH || "",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
].filter(Boolean);

export function chromiumPath(): string | null {
  for (const candidate of CHROMIUM_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Viewport = { width: number; height: number };
export type PageError = { kind: "console" | "request"; text: string };

export interface BrowserPage {
  goto(url: string, options?: { waitMs?: number }): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  setViewport(viewport: Viewport): Promise<void>;
  screenshot(file: string): Promise<void>;
  reload(options?: { waitMs?: number }): Promise<void>;
  errors(): PageError[];
  clearErrors(): void;
  close(): Promise<void>;
}

export type ChromiumTarget = {
  browser: ChildProcess;
  profileDir: string;
  wsUrl: string;
};

export async function launchChromiumTarget(
  startUrl: string,
  options: { executable?: string; timeoutMs?: number; label?: string } = {}
): Promise<ChromiumTarget> {
  const executable = options.executable || chromiumPath();
  if (!executable) throw new Error(`no Chromium found; tried ${CHROMIUM_CANDIDATES.join(", ")}`);

  const label = String(options.label || "siton-cdp").replace(/[^a-z0-9_-]/gi, "-");
  const profileDir = await mkdtemp(join(tmpdir(), `${label}-`));
  let stderr = "";
  let spawnError: Error | null = null;
  const browser: ChildProcess = spawn(executable, [
    "--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox",
    "--disable-breakpad", "--disable-crash-reporter", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`, startUrl
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

  browser.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8_000);
  });
  browser.once("error", (error) => { spawnError = error; });

  const timeoutMs = options.timeoutMs ?? (process.env.CI ? 60_000 : 35_000);
  const deadline = Date.now() + timeoutMs;
  let debugPort = 0;
  let wsUrl = "";

  while (Date.now() < deadline && !wsUrl) {
    if (spawnError) break;
    if (browser.exitCode !== null || browser.signalCode !== null) break;

    if (!debugPort) {
      try {
        const activePort = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
        const parsed = Number.parseInt(activePort.split(/\r?\n/, 1)[0] || "", 10);
        if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) debugPort = parsed;
      } catch { /* Chromium has not published the OS-assigned port yet */ }
    }

    if (debugPort) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (response.ok) {
          const pages = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
          const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl)
            || pages.find((item) => item.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
        }
      } catch { /* CDP HTTP endpoint is not accepting connections yet */ }
    }

    if (!wsUrl) await wait(150);
  }

  if (!wsUrl) {
    const exit = spawnError
      ? `spawn error: ${spawnError.message}`
      : `exitCode=${browser.exitCode ?? "running"} signal=${browser.signalCode ?? "none"}`;
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await wait(200);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    const diagnostics = stderr.trim();
    throw new Error(
      `Chromium CDP did not become available within ${timeoutMs}ms (${exit})`
      + (diagnostics ? `\nChromium stderr:\n${diagnostics}` : "")
    );
  }

  return { browser, profileDir, wsUrl };
}

export async function launchPage(startUrl: string): Promise<BrowserPage> {
  const executable = chromiumPath();
  if (!executable) throw new Error(`no Chromium found; tried ${CHROMIUM_CANDIDATES.join(", ")}`);
  const { browser, profileDir, wsUrl } = await launchChromiumTarget(startUrl, { executable });
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const errors: PageError[] = [];
  let loaded = false;

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Page.loadEventFired") { loaded = true; return; }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      errors.push({ kind: "console", text: (message.params.args || []).map((a: any) => String(a?.value ?? a?.description ?? "")).join(" ") });
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      errors.push({ kind: "console", text: String(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "exception") });
      return;
    }
    if (message.method === "Network.loadingFailed" && !message.params?.canceled) {
      errors.push({ kind: "request", text: `${message.params?.type} ${message.params?.errorText}` });
      return;
    }
    if (message.method === "Network.responseReceived") {
      const status = Number(message.params?.response?.status || 0);
      const url = String(message.params?.response?.url || "");
      // A 4xx/5xx on a resource the page asked for is a real failure; the app's
      // own API refusals (401/403/404 probes) are asserted by the suite itself.
      if (status >= 400) errors.push({ kind: "request", text: `${status} ${url}` });
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
  });

  const send = (method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket did not open")), 15_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket failed")); }, { once: true });
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value as T;
  };
  /** Wait until the React root has actually rendered something. */
  const settle = async (waitMs: number) => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const ready = await evaluate<boolean>(`(() => {
        if (document.readyState !== "complete") return false;
        const root = document.getElementById("root");
        if (!root) return true;
        if (root.querySelector('[data-testid="boot-loader"]')) return false;
        return root.children.length > 0;
      })()`).catch(() => false);
      if (ready) { await wait(250); return; }
      await wait(150);
    }
  };

  return {
    async goto(url, options) {
      loaded = false;
      await send("Page.navigate", { url });
      await settle(options?.waitMs ?? 15_000);
    },
    async reload(options) {
      loaded = false;
      await send("Page.reload", { ignoreCache: false });
      await settle(options?.waitMs ?? 15_000);
    },
    evaluate,
    async setViewport(viewport) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width, height: viewport.height,
        deviceScaleFactor: 1, mobile: viewport.width <= 480
      });
      await wait(200);
    },
    async screenshot(file) {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 30_000);
      await writeFile(file, Buffer.from(String(shot.data), "base64"));
    },
    errors: () => [...errors],
    clearErrors: () => { errors.length = 0; },
    async close() {
      await Promise.race([send("Browser.close").catch(() => undefined), wait(2_000)]);
      ws.close();
      if (browser.exitCode === null) {
        browser.kill("SIGKILL");
        await wait(200);
      }
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
      void loaded;
    }
  };
}
