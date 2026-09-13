// FINANCIAL TORTURE LAB — worker-process preload for the Siton-side observer
// (R9C ROUND 6). Loaded into REAL worker processes with
// `NODE_OPTIONS=--import=<this file>` by suites that spawn workers, so that
// money requests, status answers and committed verdicts made by those
// processes are positioned on the simulator's sequencer exactly like the
// in-process lab (positions come over HTTP from the simulator's /lab/observe).
// Never loaded outside the lab: it needs LAB_OBSERVER_SIM_URL.
import { httpObserver, installSitonObserver } from "./siton_observer.js";

const simulator = String(process.env.LAB_OBSERVER_SIM_URL || "").trim();
const providerBase = String(process.env.PAYMENT_PROVIDER_BASE_URL || "").trim();
if (simulator && providerBase) {
  installSitonObserver({
    providerBaseUrl: providerBase,
    observe: httpObserver(simulator),
    process: String(process.env.WORKER_ID || `pid-${process.pid}`)
  });
}
