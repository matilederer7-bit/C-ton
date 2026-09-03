import { useEffect, useRef } from "react";
import { createPoller, type PollDeps, type PollOptions, type PollTaskResult } from "./polling";

// Browser adapter for the pure scheduler in polling.ts: real timers + the
// Page Visibility API. Hidden tabs never poll; a returning tab refreshes once.
export function browserPollDeps(): PollDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    isVisible: () => document.visibilityState === "visible",
    subscribeVisibility: (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    }
  };
}

/**
 * Poll `task` with the bounded scheduler while the component is mounted and
 * `enabled` (default true). The latest `task` closure is always used, so the
 * poller itself is created once per `deps` change.
 */
export function usePoller(task: () => Promise<PollTaskResult>, options: PollOptions & { enabled?: boolean }, deps: unknown[]): void {
  const taskRef = useRef(task);
  taskRef.current = task;
  const enabled = options.enabled !== false;
  const { intervalMs, maxBackoffMs, minIntervalMs } = options;
  useEffect(() => {
    if (!enabled) return;
    const poller = createPoller(
      () => taskRef.current(),
      { intervalMs, ...(maxBackoffMs !== undefined ? { maxBackoffMs } : {}), ...(minIntervalMs !== undefined ? { minIntervalMs } : {}) },
      browserPollDeps()
    );
    poller.start();
    return () => poller.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);
}
