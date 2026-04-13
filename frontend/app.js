const root = document.getElementById("app");
const FLOW_KEY = "siton_flow_v2";
const FLOW_SCHEMA_VERSION = 2;
const SELLER_CONTEXT_KEY = "siton_seller_context_v1";
const FLOW_TTL_MS = 1000 * 60 * 60 * 6;
const POLL_INTERVAL_MS = 12000;
let routePollTimer = null;
let routePollKey = "";

const state = {
  loading: false,
  loadingMessage: "",
  route: parseRoute(location.pathname),
  previewMeta: null,
  homePayload: null,
  sellerContext: null,
  sellerAuth: null,
  dealPayload: null,
  trackingPayload: null,
  marketplacePayload: null,
  sellerPayload: null,
  sellerDealPayload: null,
  affiliatePayload: null,
  adminPayload: null,
  adminSystemStatusPayload: null,
  adminDealPayload: null,
  adminUserPayload: null,
  error: null,
  banner: null,
  form: {
    marketQuery: "",
    adminQuery: "",
    qty: "1",
    deliveryOptionId: "",
    phone: "",
    code: "",
    holderName: "",
    cardNumber: "",
    expiry: "",
    cvv: "",
    sellerTitle: "",
    sellerContextId: "",
    sellerContextName: "",
    sellerAccessCode: "",
    sellerPrice: "10",
    sellerMinUnits: "10",
    sellerMaxUnits: "20",
    sellerDeadline: "",
    sellerCommissionRate: "0",
    sellerDeliveryType1: "pickup",
    sellerDeliveryLabel1: "איסוף עצמי",
    sellerDeliveryCost1: "0",
    sellerDeliveryType2: "delivery",
    sellerDeliveryLabel2: "",
    sellerDeliveryCost2: "0",
    sellerDeliveryType3: "distribution_point",
    sellerDeliveryLabel3: "",
    sellerDeliveryCost3: "0"
  }
};

const DEAL_COPY = {
  Draft: ["העסקה עדיין בטיוטה", "העסקה עוד לא נפתחה לקונים ולכן עדיין אי אפשר להצטרף."],
  PendingTarget: ["פתוחה להצטרפות", "אפשר להצטרף עכשיו. בשלב הזה נשמרים אימות, תפיסת מסגרת והרשמה לעסקה."],
  TargetReached: ["היעד הושג", "העסקה חצתה את היעד ועדיין פתוחה להצטרפות כל עוד נשארה קיבולת."],
  ClosedForJoining: ["חלון ההצטרפות נסגר", "העסקה כבר עברה לשלב הבא, ולכן לא ניתן להצטרף אליה כעת."],
  ReadyForCharging: ["מוכנה לחיוב", "העסקה כבר לא פתוחה להצטרפות חדשה והיא נערכת לשלב החיוב."],
  Charging: ["בחיוב", "המערכת מריצה כעת חיובים ואין אפשרות להצטרף מחדש לעסקה."],
  CompletionWindow: ["בחלון השלמה", "העסקה נמצאת בסגירה תפעולית ולכן לא פתוחה להצטרפות חדשה."],
  Completed: ["הושלמה", "העסקה הושלמה. אם השתתפת, מסך המעקב יציג את התוצאה שלך."],
  Failed: ["לא הושלמה", "העסקה נסגרה ללא השלמה. מסך המעקב יסביר מה קרה להשתתפות."],
  Cancelled: ["בוטלה", "העסקה בוטלה ולכן לא ניתן להצטרף אליה."]
};

const BUYER_COPY = {
  JoinedAuthorized: ["נרשמת בהצלחה", "ההשתתפות נקלטה ונשמר אישור מסגרת."],
  LockedIn: ["ננעלת לעסקה", "ההשתתפות שלך כבר בפנים, לפני שלב החיוב."],
  ChargingAttempt: ["מתבצע ניסיון חיוב", "העסקה הגיעה לשלב שבו המערכת מנסה לחייב."],
  ChargedSuccess: ["החיוב הצליח", "החיוב עבור ההשתתפות שלך עבר בהצלחה."],
  ChargeFailedCompletion: ["נדרש טיפול בהשלמה", "החיוב לא הושלם וההשתתפות נמצאת בחלון השלמה."],
  Recovered: ["הושלמה בשחזור", "המערכת השלימה את ההשתתפות במסלול שחזור."],
  Dropped: ["ההשתתפות ירדה", "ההשתתפות שלך לא הושלמה בתוך העסקה."],
  DealCompleted: ["העסקה הושלמה עבורך", "ההשתתפות נסגרה כחלק מעסקה שהושלמה."],
  DealFailed: ["העסקה נכשלה עבורך", "ההשתתפות נסגרה כחלק מעסקה שלא הושלמה."]
};

const MONEY_COPY = {
  AuthHeld: ["יש תפיסת מסגרת", "בוצע אישור מסגרת בלבד. עדיין אין חיוב בפועל."],
  AuthLocked: ["תפיסת המסגרת ננעלה", "האישור נשמר לקראת חיוב אפשרי."],
  ChargeAttempt: ["מתבצע חיוב", "המערכת מנסה לבצע חיוב בפועל."],
  ChargedSuccess: ["חויבת", "החיוב הושלם בהצלחה."],
  ChargeFailedRecovery: ["החיוב לא הושלם", "המערכת מנסה לסגור את המסלול דרך מסלול שחזור."],
  RecoveredCharge: ["החיוב הושלם בשחזור", "המערכת הצליחה להשלים את החיוב במסלול שחזור."],
  AuthReleased: ["תפיסת המסגרת שוחררה", "לא בוצע חיוב בפועל או שהתפיסה בוטלה."],
  Refunded: ["בוצע זיכוי", "המערכת החזירה את הסכום לאחר חיוב."]
};

const ROUTE_LABELS = {
  seller: "אזור מוכר",
  "seller-new": "פתיחת עסקה",
  "seller-deal": "ניהול עסקה",
  affiliate: "מסך פנימי",
  admin: "מסך פנימי",
  "admin-deal": "עסקה פנימית",
  "admin-user": "פרופיל פנימי",
  home: "האתר הראשי",
  deal: "דף עסקה",
  otp: "אימות טלפון",
  payment: "אישור מסגרת",
  confirmation: "אישור הצטרפות",
  tracking: "מעקב השתתפות",
  terms: "תנאי שימוש",
  privacy: "מדיניות פרטיות",
  refunds: "ביטולים והחזרים",
  contact: "יצירת קשר",
  "not-found": "עמוד לא נמצא"
};

const PAYMENT_READINESS = {
  providerLabel: "ספק אישור מסגרת מדומה",
  settlementModel: "קודם מתבצעת תפיסת מסגרת, ורק אחר כך יכול להתבצע חיוב בפועל",
  integrationNote: "החיבור לספק תשלום אמיתי נשמר כשכבה נפרדת ואינו משנה את מסלול המוצר."
};

const INTERNAL_SURFACE_ROUTES = new Set(["affiliate", "admin", "admin-deal", "admin-user"]);
const PUBLIC_TRUST_ROUTES = new Set(["home", "deal", "otp", "payment", "confirmation", "tracking", "terms", "privacy", "refunds", "contact"]);

const DEAL_TONE = {
  Draft: "warning",
  PendingTarget: "success",
  TargetReached: "success",
  ClosedForJoining: "warning",
  ReadyForCharging: "warning",
  Charging: "warning",
  CompletionWindow: "warning",
  Completed: "success",
  Failed: "danger",
  Cancelled: "danger"
};

addEventListener("popstate", () => navigate(location.pathname, false));
document.addEventListener("visibilitychange", () => {
  syncRoutePolling();
  if (!document.hidden) void runRouteSilently();
});

document.addEventListener("click", (event) => {
  const navTarget = event.target.closest("[data-nav]");
  if (navTarget) {
    event.preventDefault();
    navigate(navTarget.getAttribute("data-nav"));
    return;
  }

  const actionTarget = event.target.closest("[data-inline-action]");
  if (actionTarget) {
    event.preventDefault();
    const action = actionTarget.getAttribute("data-inline-action");
    if (action === "restart-flow") restartFlow();
    if (action === "reset-otp") resetOtp();
    if (action === "seller-clone") cloneSellerDeal(actionTarget.dataset.dealId);
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (!(target.name in state.form)) return;
  state.form[target.name] = target.value;
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const action = form.dataset.action;
  if (!action) return;
  event.preventDefault();
  void submitAction(action, form);
});

boot();

async function boot() {
  consumeQaSeedFromHash();
  state.route = parseRoute(location.pathname);
  await loadPreviewMeta();
  hydrateSellerContext();
  hydrateForm();
  await loadSellerSession();
  render();
  await runRoute();
}

function consumeQaSeedFromHash() {
  if (!location.hash) return;
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  const qaFlow = params.get("qaFlow");
  const qaTarget = params.get("qaTarget");
  if (!qaFlow && !qaTarget) return;

  try {
    if (qaFlow) {
      sessionStorage.setItem(FLOW_KEY, qaFlow);
    }
  } catch {}

  if (qaTarget) {
    history.replaceState(null, "", qaTarget);
  } else {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

async function loadPreviewMeta() {
  try {
    state.previewMeta = await api("/api/preview/meta");
  } catch {
    state.previewMeta = null;
  }
}

async function loadSellerSession() {
  try {
    const payload = await api("/api/seller/session");
    state.sellerAuth = payload?.seller_auth || null;
    if (state.sellerAuth?.seller_context) {
      syncSellerContext(state.sellerAuth.seller_context);
    }
  } catch (error) {
    if (Number(error?.status || 0) === 503) {
      state.sellerAuth = {
        mode: "server-session",
        configured: false,
        authenticated: false,
        allow_manual_context_switch: false,
        seller_context: null
      };
      return;
    }
    state.sellerAuth = null;
  }
}

function parseRoute(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/" || normalized === "/app" || normalized === "/app/marketplace") return { name: "home" };
  const patterns = [
    ["deal", /^\/app\/deal\/([^/]+)$/],
    ["otp", /^\/app\/join\/([^/]+)\/otp$/],
    ["payment", /^\/app\/join\/([^/]+)\/payment$/],
    ["confirmation", /^\/app\/join\/([^/]+)\/confirmation$/],
    ["tracking", /^\/app\/track\/([^/]+)$/],
    ["terms", /^\/app\/terms$/],
    ["privacy", /^\/app\/privacy$/],
    ["refunds", /^\/app\/refunds$/],
    ["contact", /^\/app\/contact$/],
    ["seller", /^\/app\/seller$/],
    ["seller-new", /^\/app\/seller\/new$/],
    ["seller-deal", /^\/app\/seller\/deals\/([^/]+)$/],
    ["affiliate", /^\/app\/affiliate$/],
    ["admin", /^\/app\/admin$/],
    ["admin-deal", /^\/app\/admin\/deals\/([^/]+)$/],
    ["admin-user", /^\/app\/admin\/users\/([^/]+)$/]
  ];

  for (const [name, regex] of patterns) {
    const match = normalized.match(regex);
    if (!match) continue;
    if (name === "seller" || name === "seller-new" || name === "affiliate" || name === "admin" || name === "terms" || name === "privacy" || name === "refunds" || name === "contact") {
      return { name };
    }
    return name === "tracking"
      ? { name, participantId: decodeURIComponent(match[1]) }
      : name === "admin-user"
        ? { name, buyerId: decodeURIComponent(match[1]) }
        : { name, dealId: decodeURIComponent(match[1]) };
  }

  return { name: "not-found" };
}

function navigate(path, push = true) {
  if (push) history.pushState({}, "", path);
  state.route = parseRoute(path);
  state.error = null;
  state.banner = null;
  render();
  syncRoutePolling();
  void runRoute();
}

function currentAffiliateRef() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref");
  return ref ? ref.trim() : "";
}

async function runRoute() {
  const route = state.route;
  if (route.name === "home") return loadHome();
  if (route.name === "deal") return loadDeal(route.dealId);
  if (route.name === "tracking") return loadTracking(route.participantId);
  if (route.name === "seller") return loadSeller();
  if (route.name === "seller-new") return prepareSellerNew();
  if (route.name === "seller-deal") return loadSellerDeal(route.dealId);
  if (route.name === "affiliate") return loadAffiliate();
  if (route.name === "admin") return loadAdmin(state.form.adminQuery);
  if (route.name === "admin-deal") return loadAdminDeal(route.dealId);
  if (route.name === "admin-user") return loadAdminUser(route.buyerId);

  if (["otp", "payment", "confirmation"].includes(route.name)) {
    await ensureDeal(route.dealId);
    const flow = getFlow(route.dealId);
    if (!flow) {
      state.banner = {
        tone: "warning",
        title: "הסשן הקודם כבר לא זמין",
        message: "אפשר לחזור לדף העסקה ולהתחיל שוב את המסלול בצורה מסודרת."
      };
      render();
      return;
    }

    if (route.name === "payment" && !flow.otpVerified) {
      state.banner = {
        tone: "warning",
        title: "צריך להשלים קודם אימות טלפון",
        message: "הכמות נשמרה, אבל לפני אישור המסגרת צריך להשלים את אימות הטלפון."
      };
      render();
      return;
    }

    if (route.name === "confirmation" && !flow.participantId) {
      state.banner = {
        tone: "warning",
        title: "עדיין אין הצטרפות סופית להצגה",
        message: "אפשר לחזור לשלב אישור המסגרת ולהמשיך מאיפה שעצרת."
      };
      render();
    }
  }
  syncRoutePolling();
}

async function ensureDeal(dealId) {
  if (state.dealPayload?.deal?.deal_id === dealId) return;
  await loadDeal(dealId);
}

async function loadDeal(dealId) {
  await busy("טוען את פרטי העסקה...", async () => {
    state.dealPayload = await api(`/api/deals/${encodeURIComponent(dealId)}/public`);
    state.form.qty = String(getFlow(dealId)?.qty || 1);
  }, "לא הצלחנו לטעון את העסקה.");
}

async function loadTracking(participantId) {
  await busy("טוען את סטטוס ההשתתפות...", async () => {
    state.trackingPayload = await api(`/api/participants/${encodeURIComponent(participantId)}/tracking`);
    const tracking = state.trackingPayload?.tracking;
    if (tracking?.deal_id) {
      saveFlow(tracking.deal_id, {
        participantId: tracking.participant_id,
        buyerId: tracking.buyer_id,
        lastTrackingViewedAt: new Date().toISOString()
      });
    }
  }, "לא הצלחנו לטעון את המעקב.");
}

async function loadHome() {
  await busy("טוען את האתר הראשי של סיטון...", async () => {
    state.homePayload = await api("/api/site/home");
    state.sellerAuth = state.homePayload?.site?.seller_auth || state.sellerAuth;
    syncSellerContext(state.homePayload?.site?.seller_context || null);
  }, "לא הצלחנו לטעון את האתר הראשי של סיטון.");
}

async function loadSeller() {
  await busy("טוען את אזור המוכר...", async () => {
    state.sellerPayload = await api("/api/seller/deals");
    state.sellerAuth = state.sellerPayload?.seller_surface?.seller_auth || state.sellerAuth;
    syncSellerContext(state.sellerPayload?.seller_surface?.seller_profile || null);
  }, "לא הצלחנו לטעון את אזור המוכר.");
}

async function prepareSellerNew() {
  if (!state.form.sellerDeadline) {
    state.form.sellerDeadline = toDatetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  }
  render();
}

async function loadSellerDeal(dealId) {
  await busy("טוען את ניהול העסקה...", async () => {
    state.sellerDealPayload = await api(`/api/seller/deals/${encodeURIComponent(dealId)}`);
    state.sellerAuth = state.sellerDealPayload?.seller_auth || state.sellerAuth;
    syncSellerContext(state.sellerDealPayload?.seller_profile || null);
  }, "לא הצלחנו לטעון את מסך ניהול העסקה.");
}

async function loadAffiliate() {
  await busy("טוען את מסך השותפים הפנימי...", async () => {
    state.affiliatePayload = await api("/api/affiliate/overview");
  }, "לא הצלחנו לטעון את מסך השותפים הפנימי.");
}

async function loadAdmin(query = "") {
  await busy("טוען את מסך הניהול הפנימי...", async () => {
    const [overview, systemStatus] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(query || "")}`),
      api("/api/admin/system-status")
    ]);
    state.adminPayload = overview;
    state.adminSystemStatusPayload = systemStatus;
  }, "לא הצלחנו לטעון את מסך הניהול הפנימי.");
}

async function loadAdminDeal(dealId) {
  await busy("טוען את פרופיל העסקה הפנימי...", async () => {
    state.adminDealPayload = await api(`/api/admin/deals/${encodeURIComponent(dealId)}/profile`);
  }, "לא הצלחנו לטעון את פרופיל העסקה הפנימי.");
}

async function loadAdminUser(buyerId) {
  await busy("טוען את פרופיל המשתמש הפנימי...", async () => {
    state.adminUserPayload = await api(`/api/admin/users/${encodeURIComponent(buyerId)}/profile`);
  }, "לא הצלחנו לטעון את פרופיל המשתמש הפנימי.");
}

function syncRoutePolling() {
  const pollKey = currentPollKey();
  if (routePollKey === pollKey) return;

  if (routePollTimer) {
    clearInterval(routePollTimer);
    routePollTimer = null;
  }

  routePollKey = pollKey;
  if (!pollKey || document.hidden) return;

  routePollTimer = setInterval(() => {
    void runRouteSilently();
  }, POLL_INTERVAL_MS);
}

function currentPollKey() {
  const route = state.route;
  if (route.name === "home") return "";
  if (route.name === "deal") return `deal:${route.dealId}`;
  if (route.name === "tracking") return `tracking:${route.participantId}`;
  if (route.name === "seller") return "seller";
  if (route.name === "seller-new") return `seller-new:${currentSellerContext().seller_id}`;
  if (route.name === "seller-deal") return `seller-deal:${route.dealId}:${currentSellerContext().seller_id}`;
  if (route.name === "admin") return "admin";
  return "";
}

async function runRouteSilently() {
  const route = state.route;
  if (document.hidden) return;
  if (route.name === "deal") {
    await refreshDealSilently(route.dealId);
    return;
  }
  if (route.name === "tracking") {
    await refreshTrackingSilently(route.participantId);
    return;
  }
  if (route.name === "seller") {
    await refreshSellerSilently();
    return;
  }
  if (route.name === "admin") {
    await refreshAdminSilently();
  }
}

async function refreshDealSilently(dealId) {
  try {
    const next = await api(`/api/deals/${encodeURIComponent(dealId)}/public`);
    const previous = state.dealPayload;
    state.dealPayload = next;
    if (!previous) {
      render();
      return;
    }

    const stateChanged = previous.deal.state !== next.deal.state;
    const availabilityChanged = previous.availability.canJoin !== next.availability.canJoin;
    const remainingChanged = previous.metrics.remaining_units !== next.metrics.remaining_units;
    if (stateChanged || availabilityChanged || remainingChanged) {
      state.banner = {
        tone: "success",
        title: "העסקה עודכנה",
        message: "סטטוס העסקה או הקיבולת עודכנו בזמן אמת."
      };
      render();
    }
  } catch {}
}

async function refreshTrackingSilently(participantId) {
  try {
    const next = await api(`/api/participants/${encodeURIComponent(participantId)}/tracking`);
    const previous = state.trackingPayload;
    state.trackingPayload = next;
    if (!previous) {
      render();
      return;
    }

    const changed =
      previous.tracking.deal_state !== next.tracking.deal_state ||
      previous.tracking.buyer_state !== next.tracking.buyer_state ||
      previous.tracking.money_state !== next.tracking.money_state;

    if (changed) {
      state.banner = {
        tone: "success",
        title: "סטטוס ההשתתפות עודכן",
        message: "המסך רענן את מצב העסקה וההשתתפות בלי לאבד את רצף החוויה."
      };
      render();
    }
  } catch {}
}

async function refreshSellerSilently() {
  try {
    const next = await api("/api/seller/deals");
    state.sellerAuth = next?.seller_surface?.seller_auth || state.sellerAuth;
    syncSellerContext(next?.seller_surface?.seller_profile || null);
    if (!state.sellerPayload || JSON.stringify(state.sellerPayload.seller_surface.deals) !== JSON.stringify(next.seller_surface.deals)) {
      state.sellerPayload = next;
      render();
    }
  } catch {}
}

async function refreshAdminSilently() {
  try {
    const [next, systemStatus] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(state.form.adminQuery || "")}`),
      api("/api/admin/system-status")
    ]);
    const totalsChanged = !state.adminPayload || JSON.stringify(state.adminPayload.admin_surface.totals) !== JSON.stringify(next.admin_surface.totals);
    const systemChanged =
      !state.adminSystemStatusPayload ||
      JSON.stringify(state.adminSystemStatusPayload.system_status.operational_counts) !== JSON.stringify(systemStatus.system_status.operational_counts);
    if (totalsChanged || systemChanged) {
      state.adminPayload = next;
      state.adminSystemStatusPayload = systemStatus;
      render();
    }
  } catch {}
}

async function submitAction(action, form) {
  if (action === "marketplace-search") return loadHome();
  if (action === "start-join") return startJoin();
  if (action === "otp-start") return otpStart(form);
  if (action === "otp-verify") return otpVerify(form);
  if (action === "pay") return payAndJoin(form);
  if (action === "seller-create") return createDeal(form);
  if (action === "seller-context") return saveSellerContextFromForm(form);
  if (action === "seller-login") return loginSellerFromForm(form);
  if (action === "seller-logout") return logoutSeller();
  if (action === "seller-publish") return publishDeal(form.dataset.dealId);
  if (action === "seller-delivery-update") return updateDelivery(form);
  if (action === "affiliate-save-payout") return saveAffiliatePayoutProfile(form);
  if (action === "admin-search") return loadAdmin(state.form.adminQuery);
  if (action === "admin-kyc-decision") return decideKyc(form);
  if (action === "admin-support-create") return createSupportTicket(form);
  if (action === "admin-support-update") return updateSupportTicket(form);
  if (action === "admin-affiliate-payout") return updateAffiliatePayoutStatus(form);
}

function startJoin() {
  const payload = state.dealPayload;
  if (!payload?.deal) return;
  const qty = Number(state.form.qty);
  const issue = validateQty(payload, qty);
  if (issue) return fail("צריך לעדכן את הכמות", issue);
  const deliveryIssue = validateDeliveryChoice(payload, state.form.deliveryOptionId);
  if (deliveryIssue) return fail("צריך לעדכן את אופן הקבלה", deliveryIssue);
  const selectedDelivery = getSelectedDeliveryOption(payload, state.form.deliveryOptionId);
  if (!selectedDelivery) return fail("לא נבחר אופן קבלה", "יש לבחור אופן קבלה לפני ההמשך.");

  const flow = saveFlow(payload.deal.deal_id, {
    dealId: payload.deal.deal_id,
    dealTitle: payload.deal.title,
    qty,
    deliveryOptionId: selectedDelivery.option_id,
    deliveryMethodType: selectedDelivery.option_type,
    deliveryMethodLabel: selectedDelivery.label,
    deliveryCost: Number(selectedDelivery.cost || 0),
    affiliateRef: currentAffiliateRef() || getFlow(payload.deal.deal_id)?.affiliateRef || "",
    estimatedTotal: calcHoldTotal(payload, qty, selectedDelivery),
    startedAt: new Date().toISOString()
  });
  hydrateFormFromFlow(flow);
  navigate(`/app/join/${encodeURIComponent(payload.deal.deal_id)}/otp`);
}

async function otpStart(form) {
  const route = state.route;
  if (route.name !== "otp") return;
  const phone = String(new FormData(form).get("phone") || "").trim();
  if (!phone) return fail("חסר מספר טלפון", "יש להזין מספר טלפון נייד כדי להמשיך.");

  await busy("שולח קוד אימות...", async () => {
    const response = await api("/api/otp/start", {
      method: "POST",
      body: json({ phone })
    });
    const flow = saveFlow(route.dealId, {
      phone,
      otpSessionId: response.otp_session_id,
      otpMaskedDestination: response.masked_destination,
      otpExpiresAt: response.expires_at,
      developmentCode: response.development_code,
      otpRequestedAt: new Date().toISOString(),
      otpVerified: false
    });
    state.form.phone = phone;
    state.form.code = "";
    state.banner = {
      tone: "success",
      title: "קוד האימות נשלח",
      message: `שלחנו קוד לטלפון ${flow.otpMaskedDestination || phone}.`
    };
  }, "שליחת קוד האימות נכשלה.");
}

async function otpVerify(form) {
  const route = state.route;
  if (route.name !== "otp") return;
  const flow = getFlow(route.dealId);
  if (!flow?.otpSessionId) {
    return fail("אין סשן אימות פעיל", "צריך לבקש קוד חדש לפני אימות.");
  }

  const code = String(new FormData(form).get("code") || "").trim();
  if (!code) return fail("חסר קוד אימות", "יש להזין את קוד האימות שנשלח אליך.");

  await busy("מאמת את הקוד...", async () => {
    const response = await api("/api/otp/verify", {
      method: "POST",
      body: json({ otp_session_id: flow.otpSessionId, code })
    });
    saveFlow(route.dealId, {
      buyerId: response.buyer_id,
      otpVerified: true,
      otpVerifiedAt: new Date().toISOString()
    });
    state.banner = {
      tone: "success",
      title: "האימות הצליח",
      message: "אפשר להמשיך עכשיו לאישור המסגרת."
    };
    navigate(`/app/join/${encodeURIComponent(route.dealId)}/payment`);
  }, "אימות הקוד נכשל.");
}

function resetOtp() {
  const route = state.route;
  if (route.name !== "otp") return;
  clearFlowFields(route.dealId, [
    "otpSessionId",
    "otpMaskedDestination",
    "otpExpiresAt",
    "developmentCode",
    "otpVerified",
    "otpVerifiedAt",
    "buyerId"
  ]);
  state.form.code = "";
  state.banner = {
    tone: "warning",
    title: "שלב אימות הטלפון אופס",
    message: "אפשר לבקש עכשיו קוד חדש ולהמשיך."
  };
  render();
}

async function payAndJoin(form) {
  const route = state.route;
  if (route.name !== "payment") return;
  const flow = getFlow(route.dealId);
  if (!flow?.otpVerified || !flow?.buyerId) {
    state.banner = {
      tone: "warning",
      title: "חסר אימות טלפון תקף",
      message: "צריך להשלים אימות טלפון לפני אישור המסגרת."
    };
    render();
    return;
  }

  const formData = new FormData(form);
  const payload = {
    holder_name: String(formData.get("holderName") || "").trim(),
    card_number: String(formData.get("cardNumber") || "").replace(/\s+/g, ""),
    expiry: String(formData.get("expiry") || "").trim(),
    cvv: String(formData.get("cvv") || "").trim(),
    amount_minor: Math.round(Number(flow.estimatedTotal || 0) * 100),
    currency: "ILS",
    buyer_id: flow.buyerId,
    deal_id: route.dealId
  };
  const issue = validatePayment(payload);
  if (issue) return fail("פרטי האשראי לא מלאים", issue);

  await busy("מאשר את המסגרת ושומר את ההצטרפות...", async () => {
    const authorization = await paymentService.authorize(payload);
    const join = await buyerFlowService.joinDeal(route.dealId, {
      buyerId: flow.buyerId,
      qty: flow.qty,
      affiliateRef: flow.affiliateRef || "",
      deliveryOptionId: flow.deliveryOptionId || "",
      authorizationId: authorization.authorization_id,
      authorizationProvider: authorization.provider,
      authorizationCorrelationId: authorization.correlation_id
    });
    saveFlow(route.dealId, {
      paymentAuthorized: true,
      paymentAuthorizedAt: new Date().toISOString(),
      authorizationId: authorization.authorization_id,
      authorizationMessage: authorization.hold_message || "",
      participantId: join.participant_id,
      deliveryOptionId: join.delivery_option_id || flow.deliveryOptionId || "",
      deliveryMethodType: join.delivery_method_type || flow.deliveryMethodType || "",
      deliveryMethodLabel: join.delivery_method_label || flow.deliveryMethodLabel || "",
      deliveryCost: Number(join.delivery_cost ?? flow.deliveryCost ?? 0),
      estimatedTotal: Number(join.hold_total ?? flow.estimatedTotal ?? 0)
    });
    state.banner = {
      tone: "success",
      title: "ההצטרפות נשמרה",
      message: "תפיסת המסגרת בוצעה ונשמרה השתתפות פעילה לעסקה."
    };
    navigate(`/app/join/${encodeURIComponent(route.dealId)}/confirmation`);
  }, "תפיסת המסגרת או שמירת ההצטרפות נכשלו.");
}

async function createDeal(form) {
  const formData = new FormData(form);
  const title = String(formData.get("sellerTitle") || "").trim();
  const deadline = String(formData.get("sellerDeadline") || "").trim();
  if (!title) return fail("חסרה כותרת לעסקה", "יש להזין כותרת לפני יצירת הטיוטה.");
  if (!deadline) return fail("חסר מועד סגירה", "יש לבחור מועד סגירה לפני יצירת הטיוטה.");
  const deliveryOptions = collectSellerDeliveryOptions(formData);
  if (!deliveryOptions.length) {
    return fail("חסרה אפשרות קבלה", "יש להוסיף לפחות אפשרות קבלה אחת לפני יצירת העסקה.");
  }

  await busy("יוצר טיוטת עסקה...", async () => {
    const sellerContext = currentSellerContext();
    const response = await api("/deals", {
      method: "POST",
      headers: {
        "x-request-id": `seller:${Date.now()}`,
        "idempotency-key": `seller-create:${Date.now()}`
      },
      body: json({
        title,
        price_per_unit: Number(formData.get("sellerPrice") || 0),
        min_units: Number(formData.get("sellerMinUnits") || 0),
        max_units: Number(formData.get("sellerMaxUnits") || 0),
        deadline: new Date(deadline).toISOString(),
        commission_rate: Number(formData.get("sellerCommissionRate") || 0),
        seller_id: sellerContext.seller_id,
        seller_display_name: sellerContext.display_name,
        delivery_options: deliveryOptions
      })
    });
    state.banner = {
      tone: "success",
      title: "הטיוטה נשמרה",
      message: "טיוטת העסקה נשמרה. עכשיו אפשר לעבור עליה, לפרסם את הדף הציבורי, ואז להפיץ את הלינק הישיר."
    };
    navigate(`/app/seller/deals/${encodeURIComponent(response.deal_id)}`);
  }, "יצירת העסקה נכשלה.");
}

async function publishDeal(dealId) {
  if (!dealId) return;
  await busy("מפרסם את הדף הציבורי...", async () => {
    await api(`/deals/${encodeURIComponent(dealId)}/publish`, {
      method: "POST",
      headers: {
        "x-request-id": `seller-publish:${Date.now()}`,
        "idempotency-key": `seller-publish:${dealId}`
      }
    });
    state.banner = {
      tone: "success",
      title: "הדף הציבורי פורסם",
      message: "דף העסקה הציבורי כבר חי ומוכן להפצה ישירה לקונים."
    };
    await loadSellerDeal(dealId);
  }, "פרסום העסקה נכשל.");
}

async function saveSellerContextFromForm(form) {
  if (!usesDemoSellerContext()) {
    return fail("החלפת זהות כבויה", "בסביבת non-demo זהות המוכר נקבעת דרך session שרת ולא דרך שמירה מקומית.");
  }
  const formData = new FormData(form);
  const sellerId = String(formData.get("sellerContextId") || "").trim();
  const displayName = String(formData.get("sellerContextName") || "").trim();
  if (!sellerId) {
    return fail("חסר מזהה מוכר", "יש לבחור מזהה מוכר פעיל לפני כניסה לאזור המוכר.");
  }

  await busy("שומר את זהות המוכר הפעילה...", async () => {
    const payload = await api("/api/seller/context", {
      method: "POST",
      body: json({
        seller_id: sellerId,
        display_name: displayName
      })
    });
    const sellerContext = syncSellerContext(payload?.seller_context || null);
    state.banner = {
      tone: "success",
      title: "זהות המוכר נשמרה",
      message: `העבודה באזור המוכר תתבצע עכשיו תחת ${sellerContext.display_name}.`
    };
    if (["home", "seller", "seller-new"].includes(state.route.name)) {
      await runRoute();
    } else {
      render();
    }
  }, "לא הצלחנו לשמור את זהות המוכר הפעילה.");
}

async function loginSellerFromForm(form) {
  const formData = new FormData(form);
  const sellerId = String(formData.get("sellerContextId") || "").trim();
  const accessCode = String(formData.get("sellerAccessCode") || "").trim();
  if (!sellerId || !accessCode) {
    return fail("חסר זיהוי מוכר", "יש להזין מזהה מוכר וקוד גישה כדי לפתוח session מוכר.");
  }

  await busy("פותח session מוכר מאובטח...", async () => {
    const payload = await api("/api/seller/session/login", {
      method: "POST",
      body: json({
        seller_id: sellerId,
        access_code: accessCode
      })
    });
    state.sellerAuth = payload?.seller_auth || null;
    syncSellerContext(payload?.seller_auth?.seller_context || null);
    state.form.sellerAccessCode = "";
    state.banner = {
      tone: "success",
      title: "session המוכר נפתח",
      message: `העבודה באזור המוכר מתבצעת עכשיו תחת ${state.sellerAuth?.seller_context?.display_name || sellerId}.`
    };
    await runRoute();
  }, "פתיחת session המוכר נכשלה.");
}

async function logoutSeller() {
  await busy("מנתק את session המוכר...", async () => {
    const payload = await api("/api/seller/session/logout", {
      method: "POST"
    });
    state.sellerAuth = payload?.seller_auth || null;
    state.sellerPayload = null;
    state.sellerDealPayload = null;
    state.sellerContext = null;
    state.banner = {
      tone: "success",
      title: "session המוכר נותק",
      message: "אזור המוכר עבר למצב נעול עד להתחברות מחדש."
    };
    await runRoute();
  }, "ניתוק session המוכר נכשל.");
}

function cloneSellerDeal(dealId) {
  const deal = state.sellerDealPayload?.deal;
  if (!deal || deal.deal_id !== dealId) return;
  state.form.sellerTitle = `${deal.title} - עותק`;
  state.form.sellerPrice = String(deal.price_per_unit);
  state.form.sellerMinUnits = String(deal.min_units);
  state.form.sellerMaxUnits = String(deal.max_units);
  state.form.sellerCommissionRate = String(deal.commission_rate || 0);
  const deliveryOptions = Array.isArray(state.sellerDealPayload?.delivery_options)
    ? state.sellerDealPayload.delivery_options
    : [];
  for (let index = 0; index < 3; index += 1) {
    const option = deliveryOptions[index];
    const slot = index + 1;
    state.form[`sellerDeliveryType${slot}`] = option?.option_type || (slot === 1 ? "pickup" : slot === 2 ? "delivery" : "distribution_point");
    state.form[`sellerDeliveryLabel${slot}`] = option?.label || (slot === 1 ? "איסוף עצמי" : "");
    state.form[`sellerDeliveryCost${slot}`] = option ? String(Number(option.cost || 0)) : "0";
  }
  state.form.sellerDeadline = toDatetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  navigate("/app/seller/new");
}

async function updateDelivery(form) {
  const dealId = form.dataset.dealId;
  const participantId = form.dataset.participantId;
  if (!dealId || !participantId) return;
  const formData = new FormData(form);
  await busy("שומר את עדכון המסירה...", async () => {
    await api(`/api/seller/deals/${encodeURIComponent(dealId)}/delivery/${encodeURIComponent(participantId)}`, {
      method: "POST",
      body: json({
        status: String(formData.get("deliveryStatus") || ""),
        tracking_number: String(formData.get("trackingNumber") || ""),
        issue_note: String(formData.get("issueNote") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "Delivery status updated",
      message: "מסך המסירה של המוכר עודכן עם הסטטוס האחרון."
    };
    await loadSellerDeal(dealId);
  }, "Delivery update failed.");
}

async function saveAffiliatePayoutProfile(form) {
  const formData = new FormData(form);
  await busy("Saving affiliate payout profile...", async () => {
    await api("/api/affiliate/payout-profile", {
      method: "POST",
      body: json({
        payout_method: String(formData.get("affiliatePayoutMethod") || ""),
        payout_details: String(formData.get("affiliatePayoutDetails") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "Affiliate payout details saved",
      message: "The affiliate profile is now ready for admin review and later external payout activation."
    };
    await loadAffiliate();
  }, "Could not save affiliate payout details.");
}

async function decideKyc(form) {
  const subjectType = form.dataset.subjectType;
  const subjectId = form.dataset.subjectId;
  const decision = form.dataset.decision;
  if (!subjectType || !subjectId || !decision) return;
  const formData = new FormData(form);
  await busy("Updating KYC decision...", async () => {
    await api(`/api/admin/kyc/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}/decision`, {
      method: "POST",
      body: json({
        decision,
        admin_note: String(formData.get("adminNote") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "KYC decision recorded",
      message: "The admin KYC queue was updated and the surface reloaded."
    };
    await loadAdmin(state.form.adminQuery);
  }, "Could not update the KYC decision.");
}

async function createSupportTicket(form) {
  const formData = new FormData(form);
  await busy("Creating support ticket...", async () => {
    await api("/api/admin/support", {
      method: "POST",
      body: json({
        scope_type: String(formData.get("supportScopeType") || ""),
        scope_key: String(formData.get("supportScopeKey") || ""),
        title: String(formData.get("supportTitle") || ""),
        priority: String(formData.get("supportPriority") || "normal"),
        summary: String(formData.get("supportSummary") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "Support ticket created",
      message: "The ticket now appears in the admin support hub."
    };
    await loadAdmin(state.form.adminQuery);
  }, "Could not create the support ticket.");
}

async function updateSupportTicket(form) {
  const ticketId = form.dataset.ticketId;
  if (!ticketId) return;
  const formData = new FormData(form);
  await busy("Updating support ticket...", async () => {
    await api(`/api/admin/support/${encodeURIComponent(ticketId)}`, {
      method: "POST",
      body: json({
        status: String(formData.get("supportTicketStatus") || ""),
        summary: String(formData.get("supportTicketSummary") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "Support ticket updated",
      message: "The support hub was refreshed with the latest ticket status."
    };
    await loadAdmin(state.form.adminQuery);
  }, "Could not update the support ticket.");
}

async function updateAffiliatePayoutStatus(form) {
  const affiliateId = form.dataset.affiliateId;
  if (!affiliateId) return;
  const formData = new FormData(form);
  await busy("Updating affiliate payout status...", async () => {
    await api(`/api/admin/affiliate-payouts/${encodeURIComponent(affiliateId)}`, {
      method: "POST",
      body: json({
        payout_status: String(formData.get("affiliatePayoutStatus") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "Affiliate payout state updated",
      message: "The settlement surface was refreshed with the new payout state."
    };
    await loadAdmin(state.form.adminQuery);
  }, "Could not update the affiliate payout state.");
}

function restartFlow() {
  const dealId = state.route.dealId || state.trackingPayload?.tracking?.deal_id || state.dealPayload?.deal?.deal_id;
  if (!dealId) return navigate("/app");
  removeFlow(dealId);
  state.form = {
    marketQuery: state.form.marketQuery,
    adminQuery: state.form.adminQuery,
    qty: String(state.dealPayload?.deal?.min_units || 1),
    deliveryOptionId: "",
    phone: "",
    code: "",
    holderName: "",
    cardNumber: "",
    expiry: "",
    cvv: "",
    sellerTitle: state.form.sellerTitle,
    sellerContextId: state.form.sellerContextId,
    sellerContextName: state.form.sellerContextName,
    sellerPrice: state.form.sellerPrice,
    sellerMinUnits: state.form.sellerMinUnits,
    sellerMaxUnits: state.form.sellerMaxUnits,
    sellerDeadline: state.form.sellerDeadline,
    sellerCommissionRate: state.form.sellerCommissionRate,
    sellerDeliveryType1: state.form.sellerDeliveryType1,
    sellerDeliveryLabel1: state.form.sellerDeliveryLabel1,
    sellerDeliveryCost1: state.form.sellerDeliveryCost1,
    sellerDeliveryType2: state.form.sellerDeliveryType2,
    sellerDeliveryLabel2: state.form.sellerDeliveryLabel2,
    sellerDeliveryCost2: state.form.sellerDeliveryCost2,
    sellerDeliveryType3: state.form.sellerDeliveryType3,
    sellerDeliveryLabel3: state.form.sellerDeliveryLabel3,
    sellerDeliveryCost3: state.form.sellerDeliveryCost3
  };
  navigate(`/app/deal/${encodeURIComponent(dealId)}`);
}

async function busy(loadingMessage, fn, fallbackMessage) {
  state.loading = true;
  state.loadingMessage = loadingMessage;
  state.error = null;
  render();
  try {
    await fn();
  } catch (error) {
    state.error = friendlyError(error, fallbackMessage);
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

function render() {
  root.innerHTML = `
    <main class="shell">
      ${renderNav()}
      ${renderPreviewStrip()}
      ${state.banner ? renderBanner(state.banner) : ""}
      ${state.error ? renderErrorCard(state.error) : ""}
      ${state.loading ? renderInfoStrip(state.loadingMessage || "טוען...") : ""}
      ${renderCurrentRoute()}
      ${renderPublicTrustFooter()}
    </main>
  `;
}

function renderPreviewStrip() {
  const preview = state.previewMeta?.preview;
  if (!preview?.is_demo_preview) return "";
  return `
    <section class="info-strip tone-warning">
      <strong>סביבת הדגמה פעילה</strong>
      <p>זוהי סביבת הצגה. מסלולי המוצר זמינים להצגה ולבדיקה, אבל חיוב, שילוח, תשלומים חיצוניים, אימות ספקים (KYC) והתראות אינם פועלים כאן כמערכות חיות.</p>
    </section>
  `;
}

function renderCurrentRoute() {
  const route = state.route;
  if (route.name === "home") return renderHome();
  if (route.name === "deal") return renderDealPage();
  if (route.name === "otp") return renderOtpPage(route.dealId);
  if (route.name === "payment") return renderPaymentPage(route.dealId);
  if (route.name === "confirmation") return renderConfirmationPage(route.dealId);
  if (route.name === "tracking") return renderTrackingPage();
  if (route.name === "terms") return renderTermsPage();
  if (route.name === "privacy") return renderPrivacyPage();
  if (route.name === "refunds") return renderRefundsPage();
  if (route.name === "contact") return renderContactPage();
  if (route.name === "seller") return renderSellerPage();
  if (route.name === "seller-new") return renderSellerNewPage();
  if (route.name === "seller-deal") return renderSellerDealPage();
  if (route.name === "affiliate") return renderAffiliatePage();
  if (route.name === "admin") return renderAdminPage();
  if (route.name === "admin-deal") return renderAdminDealPage();
  if (route.name === "admin-user") return renderAdminUserPage();
  return renderEmptyState("העמוד לא נמצא", "הקישור הזה לא קיים או שכבר אינו זמין.");
}

function renderHomeLegacy() {
  const payload = state.homePayload?.site;
  const preview = state.previewMeta?.preview;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">האתר הראשי של סיטון</span>
        <h1>פותחים עסקה, מעלים דף אישי, ומפיצים לינק ישיר לקונים</h1>
        <p class="muted">
          סיטון היא פלטפורמה לעסקאות קבוצתיות מבוססות לינק. האתר הראשי הוא שער העבודה למוכר: מכאן פותחים עסקה, מפרסמים דף ציבורי אישי, ומפיצים לינק ישיר שדרכו הקונים מצטרפים.
        </p>
        <div class="actions">
          <a class="button primary" href="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}" data-nav="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}">פתיחת עסקה חדשה</a>
          <a class="button secondary" href="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}" data-nav="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}">ניהול העסקאות שלי</a>
        </div>
        <div class="summary-item">
          <span class="muted">נקודת הכניסה של הקונה</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
          <p class="small muted">${esc(payload?.buyer_entry_note || "הקונה נכנס ישירות לדף העסקה דרך לינק אישי, בלי חיפוש ובלי קטלוג.")}</p>
        </div>
        <div class="summary-item">
          <span class="muted">הכיוון המוצרי הפעיל</span>
          <strong>${esc(payload?.product_direction || "עסקאות קבוצתיות מבוססות לינק")}</strong>
          <p class="small muted">${esc(payload?.positioning || "אתר מותגי חזק למוכרים, עם דף עסקה ציבורי ולינק ישיר לקונה.")}</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight">
          <span class="muted">תמונת מצב עדכנית</span>
          <strong>${buyerState[0]}</strong>
          <p class="small muted">${moneyState[0]} · ${dealState.label}</p>
        </div>
        <div class="summary-item"><span class="muted">עסקאות שנפתחו</span><strong>${num(payload?.proof_points?.total_deals || 0)}</strong></div>
        <div class="summary-item"><span class="muted">עסקאות חיות עכשיו</span><strong>${num(payload?.proof_points?.live_deals || 0)}</strong></div>
        <div class="summary-item"><span class="muted">עסקאות שהושלמו</span><strong>${num(payload?.proof_points?.completed_deals || 0)}</strong></div>
        ${preview?.is_demo_preview ? `<div class="summary-item"><span class="muted">מצב הסביבה</span><strong>${esc(formatEnvironmentLabel(preview?.deployment_mode || "preview"))}</strong></div>` : `<div class="summary-item"><span class="muted">אופי המוצר</span><strong>מסלול קנייה בלינק ישיר</strong></div>`}
        <div class="summary-item"><span class="muted">הבטחת המסלול</span><strong>המוכר פותח, הקונה מצטרף דרך לינק</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>מה כלול ב-V1</h2>
      <div class="card-list">${(payload?.v1_scope || []).map((item) => `<article class="summary-item"><strong>${esc(item)}</strong></article>`).join("")}</div>
    </section>
    <section class="card section stack">
      <h2>מה לא חלק מהכיוון הנוכחי</h2>
      <div class="card-list">${(payload?.out_of_scope || []).map((item) => `<article class="summary-item"><strong>${esc(item)}</strong></article>`).join("")}</div>
    </section>
  `;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">מסלול הקונה של סיטון</span>
        <h1>חוויית קונה מחוברת לבקאנד החי</h1>
        <p class="muted">
          הכניסה למסלול האמיתי היא דרך קישור עסקה. משם ממשיכים לאימות טלפון, לאישור מסגרת, לאישור ההצטרפות ולמעקב.
        </p>
        <div class="summary-item">
          <span class="muted">פורמט קישור העסקה</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item">
          <span class="muted">מה זמין כרגע</span>
          <strong>דף עסקה, אימות טלפון, אישור מסגרת, אישור ומעקב</strong>
        </div>
        <div class="summary-item">
          <span class="muted">למי המסלול מיועד</span>
          <strong>לקונה שמקבל קישור ישיר לעסקה</strong>
        </div>
      </aside>
    </section>
  `;
}

function renderDealPage() {
  if (!state.dealPayload && state.loading) return "";
  if (!state.dealPayload) return renderEmptyState("אי אפשר להציג את העסקה", "לא הצלחנו לטעון את פרטי העסקה שביקשת.");

  const { deal, metrics, availability } = state.dealPayload;
  const dealCopy = getDealCopy(deal.state);
  const qty = Number(state.form.qty || 1);
  const qtyIssue = validateQty(state.dealPayload, qty);
  const nextAction = nextDealAction(deal.state, availability.canJoin);
  const flow = getFlow(deal.deal_id);
  const affiliateRef = currentAffiliateRef() || flow?.affiliateRef || "";
  const deliveryOptions = getDeliveryOptions(state.dealPayload);
  const selectedDelivery = getSelectedDeliveryOption(state.dealPayload, state.form.deliveryOptionId);
  const deliveryIssue = validateDeliveryChoice(state.dealPayload, state.form.deliveryOptionId);
  const holdTotal = calcHoldTotal(state.dealPayload, qty, selectedDelivery);

  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">עסקה ציבורית</span>
        <span class="badge ${dealCopy.badgeTone}">${dealCopy.label}</span>
        <h1>${esc(deal.title)}</h1>
        <p class="muted">${availability.message || dealCopy.description}</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">כניסה לעסקה</span><strong>רק דרך לינק ישיר</strong></div>
          <div class="trust-point"><span class="muted">בשלב הזה</span><strong>תפיסת מסגרת בלבד</strong></div>
          <div class="trust-point"><span class="muted">חיוב בפועל</span><strong>רק אם העסקה תושלם</strong></div>
        </div>
        <div class="metric-grid">
          <div class="metric"><span class="muted">מחיר ליחידה</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="metric"><span class="muted">כמות שכבר נרשמה</span><strong>${num(metrics.joined_units)} יח'</strong></div>
          <div class="metric"><span class="muted">קיבולת שנותרה</span><strong>${num(metrics.remaining_units)} יח'</strong></div>
        </div>
        <div class="meter"><span style="width:${Math.max(4, metrics.progress_to_capacity_pct)}%"></span></div>
        <div class="progress-caption"><strong>${num(metrics.progress_to_capacity_pct)}%</strong><span class="muted">מתפוסת העסקה כבר נסגרה</span></div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">יעד בסיס לעסקה</span><strong>${num(deal.threshold_units)} יח'</strong></div>
          <div class="summary-item"><span class="muted">מקסימום בעסקה</span><strong>${num(deal.max_units)} יח'</strong></div>
          <div class="summary-item"><span class="muted">סגירת חלון ההצטרפות</span><strong>${dt(deal.deadline)}</strong></div>
          <div class="summary-item"><span class="muted">מספר משתתפים</span><strong>${num(metrics.participants_count)}</strong></div>
        </div>
        ${affiliateRef ? `<div class="info-strip tone-info"><strong>ייחוס שותף נשמר במסלול</strong><p class="small">קוד ההפניה <span class="mono">${esc(affiliateRef)}</span> יישאר מחובר להצטרפות הזאת ויופיע במסכים הפנימיים הרלוונטיים.</p></div>` : ""}
        ${flow ? renderExistingFlow(flow, deal.deal_id) : ""}
        ${renderLegalReferenceStrip("deal")}
      </article>
      <aside class="card hero-side stack">
        <h2>${dealCopy.title}</h2>
        <p class="muted">${nextAction.description}</p>
        <div class="cta-panel">
          <strong>הצטרפות מהירה וברורה</strong>
          <p class="small muted">בחר כמות ואופן קבלה, המשך לאימות טלפון, ואז אשר תפיסת מסגרת בלבד.</p>
        </div>
        <form data-action="start-join" class="stack">
          <div class="field">
            <label for="qty">כמה יחידות תרצה להצטרף?</label>
            <input id="qty" name="qty" type="number" min="1" max="${Math.max(1, metrics.remaining_units)}" step="1" value="${qty}" />
          </div>
          <div class="field">
            <label for="deliveryOptionId">אופן קבלה</label>
            ${deliveryOptions.length > 1 ? `
              <select id="deliveryOptionId" name="deliveryOptionId">
                <option value="">בחר אופן קבלה</option>
                ${deliveryOptions.map((option) => `<option value="${esc(option.option_id)}" ${selectedDelivery?.option_id === option.option_id ? "selected" : ""}>${esc(option.label)} · ${currency(option.cost || 0)}</option>`).join("")}
              </select>
            ` : selectedDelivery ? `
              <div class="info-strip">
                <strong>${esc(selectedDelivery.label)}</strong>
                <p class="small muted">${currency(selectedDelivery.cost || 0)} · ${esc(formatDeliveryTypeLabel(selectedDelivery.option_type))}</p>
              </div>
              <input type="hidden" name="deliveryOptionId" value="${esc(selectedDelivery.option_id)}" />
            ` : `
              <div class="error-card compact">לא הוגדרה אפשרות קבלה לעסקה הזאת.</div>
            `}
          </div>
          ${qtyIssue ? `<div class="error-card compact">${esc(qtyIssue)}</div>` : ""}
          ${deliveryIssue ? `<div class="error-card compact">${esc(deliveryIssue)}</div>` : ""}
          ${selectedDelivery ? `
            <div class="summary-item">
              <span class="muted">אופן קבלה שנבחר</span>
              <strong>${esc(selectedDelivery.label)}</strong>
              <p class="small muted">${esc(formatDeliveryTypeLabel(selectedDelivery.option_type))} · ${currency(selectedDelivery.cost || 0)}</p>
            </div>
          ` : ""}
          <div class="summary-item summary-spotlight">
            <span class="muted">עלות משוערת</span>
            <strong>${currency(holdTotal)}</strong>
            <p class="small muted">בשלב הזה נשמרת תפיסת מסגרת בלבד. חיוב אמיתי יקרה רק אם העסקה תושלם.</p>
          </div>
          ${selectedDelivery ? `
            <div class="summary-item">
              <span class="muted">פירוט תפיסת המסגרת</span>
              <strong>${currency(holdTotal)}</strong>
              <p class="small muted">${num(Math.max(0, qty))} יח' x ${currency(deal.price_per_unit)} + ${currency(selectedDelivery.cost || 0)} ${esc(selectedDelivery.label)}</p>
            </div>
          ` : ""}
            <div class="info-strip tone-warning trust-box">
              <strong>מה נשמר עכשיו</strong>
              <p class="small">המסלול שומר בחירת כמות, אופן קבלה ותפיסת מסגרת בלבד. חיוב בפועל יקרה רק אם העסקה תושלם.</p>
            </div>
            <div class="mini-legal-note">
              <span class="muted">המידע המחייב זמין תמיד:</span>
              ${renderLegalLinkRow()}
            </div>
            <button class="primary" type="submit" ${availability.canJoin ? "" : "disabled"}>${nextAction.cta}</button>
          </form>
      </aside>
    </section>
  `;
}

function renderExistingFlow(flow, dealId) {
  const continueHref = flow.participantId
    ? `/app/track/${encodeURIComponent(flow.participantId)}`
    : flow.otpVerified
      ? `/app/join/${encodeURIComponent(dealId)}/payment`
      : `/app/join/${encodeURIComponent(dealId)}/otp`;
  const continueLabel = flow.participantId
    ? "למסך המעקב שלי"
    : flow.otpVerified
      ? "להמשך לאישור מסגרת"
      : "להמשך לאימות טלפון";

  return `
    <div class="info-strip">
      <strong>יש לך כבר מסלול פתוח לעסקה הזו</strong>
      <p class="small">הכמות שנשמרה: ${num(flow.qty || 0)} יח'. אפשר להמשיך מאיפה שעצרת או להתחיל מחדש.</p>
      <div class="actions">
        <a class="button secondary" href="${continueHref}" data-nav="${continueHref}">${continueLabel}</a>
        <button class="secondary" type="button" data-inline-action="restart-flow">התחל מחדש</button>
      </div>
    </div>
  `;
}

function renderOtpPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) {
    return renderRecoveryState(
      "אין מסלול פתוח לעסקה הזו",
      "כדי להמשיך לאימות טלפון צריך להתחיל מהעסקה ולבחור כמות להצטרפות.",
      `/app/deal/${encodeURIComponent(dealId)}`
    );
  }

  const expired = flow.otpExpiresAt && Date.now() > new Date(flow.otpExpiresAt).getTime();
  const flowState = getFlowStatus(flow);

  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">שלב 1 מתוך 3</span>
        <h1>אימות טלפון לפני הצטרפות</h1>
        <p class="muted">אנחנו מאמתים את הטלפון כדי לשייך את ההשתתפות לקונה הנכון לפני תפיסת מסגרת.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(state.dealPayload?.deal?.title || flow.dealTitle || "עסקה")}</strong></div>
          <div class="summary-item"><span class="muted">כמות שנשמרה</span><strong>${num(flow.qty || 0)} יח'</strong></div>
        </div>
        <div class="status-rail">
          ${renderStep("כמות נשמרה", true)}
          ${renderStep("אימות טלפון", Boolean(flow.otpSessionId), flow.otpVerified)}
          ${renderStep("אישור מסגרת והצטרפות", Boolean(flow.otpVerified))}
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item">
          <span class="muted">מצב המסלול</span>
          <strong>${flowState.title}</strong>
          <p class="small muted">${flowState.message}</p>
        </div>
        <div class="summary-item">
          <span class="muted">עדכון אחרון למסלול</span>
          <strong>${relativeTime(flow.updatedAt)}</strong>
          <p class="small muted">אם משהו מרגיש לא עדכני, אפשר לאפס את שלב אימות הטלפון ולהמשיך מחדש.</p>
        </div>
        <form data-action="otp-start" class="stack">
          <div class="field">
            <label for="phone">מספר טלפון נייד</label>
            <input id="phone" name="phone" type="tel" data-dir="ltr" value="${esc(flow.phone || state.form.phone || "")}" placeholder="0501234567" />
          </div>
          <button class="primary" type="submit">${flow.otpSessionId ? "שלח קוד חדש" : "שלח קוד אימות"}</button>
        </form>
        ${flow.otpSessionId ? `
          <div class="info-strip ${expired ? "tone-warning" : ""}">
            <strong>${expired ? "תוקף הקוד פג" : `שלחנו קוד ל-${esc(flow.otpMaskedDestination || flow.phone || "")}`}</strong>
            <p class="small">${expired ? "אפשר לבקש קוד חדש ולהמשיך." : `הקוד בתוקף עד ${dt(flow.otpExpiresAt)}.`}</p>
            ${flow.developmentCode ? `<p class="small">קוד בדיקה נוכחי: <span class="mono">${esc(flow.developmentCode)}</span></p>` : ""}
          </div>
          <form data-action="otp-verify" class="stack">
            <div class="field">
              <label for="code">קוד אימות</label>
              <input id="code" name="code" type="text" data-dir="ltr" inputmode="numeric" value="${esc(state.form.code || "")}" placeholder="123456" />
            </div>
            <div class="actions">
              <button class="primary" type="submit" ${expired ? "disabled" : ""}>אמת והמשך</button>
              <button class="secondary" type="button" data-inline-action="reset-otp">אפס אימות טלפון</button>
            </div>
          </form>
        ` : ""}
      </aside>
    </section>
  `;
}

function renderPaymentPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) {
    return renderRecoveryState(
      "אין מסלול שמור להמשך",
      "כדי להגיע לאישור מסגרת צריך להתחיל מהעסקה ולשמור קודם בחירת כמות.",
      `/app/deal/${encodeURIComponent(dealId)}`
    );
  }
  if (!flow.otpVerified) {
    return renderRecoveryState(
      "צריך להשלים קודם אימות טלפון",
      "הכמות נשמרה, אבל לפני אישור המסגרת צריך להשלים את אימות הטלפון.",
      `/app/join/${encodeURIComponent(dealId)}/otp`
    );
  }

  const deal = state.dealPayload?.deal;
  const preview = state.previewMeta?.preview;
  const deliveryLabel = flow.deliveryMethodLabel || "לא נבחר";
  const deliveryCost = Number(flow.deliveryCost || 0);
  const holdTotal = Number(flow.estimatedTotal || ((flow.qty || 0) * (deal?.price_per_unit || 0) + deliveryCost));
  const previewPaymentGuardrail = preview?.is_demo_preview ? `
    <div class="info-strip tone-warning">
      <strong>תפיסת מסגרת בלבד</strong>
      <p class="small">זהו שלב אישור מסגרת בלבד. אין כאן חיוב בפועל, סליקה חיה או השלמת תשלום מסחרית.</p>
    </div>
  ` : "";
  const previewPaymentNote = preview?.is_demo_preview
    ? `<p class="small muted">בסביבת ההצגה הזו תפיסת המסגרת נשענת על ספק מדומה, אבל הלוגיקה נשארת זהה: קודם תפיסת מסגרת, ורק אחר כך חיוב אפשרי.</p>`
    : "";
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">שלב 2 מתוך 3</span>
        <h1>אישור מסגרת לפני הצטרפות סופית</h1>
        <p class="muted">זהו שלב אישור מסגרת בלבד. אין כאן חיוב מיידי, אלא תפיסת מסגרת לקראת השלמת העסקה.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">מה קורה עכשיו</span><strong>אישור מסגרת בלבד</strong></div>
          <div class="trust-point"><span class="muted">מה לא קורה עכשיו</span><strong>אין חיוב בפועל</strong></div>
          <div class="trust-point"><span class="muted">מתי כן יחויב</span><strong>רק אם העסקה תושלם</strong></div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(deal?.title || flow.dealTitle || "")}</strong></div>
          <div class="summary-item"><span class="muted">קונה מאומת</span><strong>${esc(flow.buyerId || "")}</strong></div>
          <div class="summary-item"><span class="muted">כמות</span><strong>${num(flow.qty || 0)} יח'</strong></div>
          <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${esc(deliveryLabel)}</strong></div>
          <div class="summary-item"><span class="muted">עלות אופן קבלה</span><strong>${currency(deliveryCost)}</strong></div>
          <div class="summary-item"><span class="muted">עלות משוערת</span><strong>${currency(holdTotal)}</strong></div>
        </div>
          <div class="summary-item">
            <span class="muted">עדכון אחרון למסלול</span>
            <strong>${relativeTime(flow.updatedAt)}</strong>
            <p class="small muted">כך אפשר להבין אם אתה ממשיך מסלול טרי או חוזר אליו אחרי הפסקה.</p>
          </div>
          ${renderLegalReferenceStrip("payment")}
          <div class="info-strip trust-box">
            <strong>השלב הזה כבר מוכן יותר לאינטגרציה אמיתית</strong>
            <p class="small">${PAYMENT_READINESS.settlementModel}. כרגע הספק הפעיל הוא <span>${PAYMENT_READINESS.providerLabel}</span>, אבל ${PAYMENT_READINESS.integrationNote}</p>
        </div>
        <div class="summary-item summary-spotlight">
          <span class="muted">סכום אישור המסגרת</span>
          <strong>${currency(holdTotal)}</strong>
          <p class="small muted">זה הסכום שיישמר כתפיסת מסגרת בשלב הזה. חיוב בפועל יקרה רק אם העסקה תושלם.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        ${previewPaymentGuardrail}
        <div class="cta-panel">
          <strong>שקט ובהיר לפני אישור</strong>
          <p class="small muted">זה המסך האחרון לפני שמירת ההצטרפות. אחרי האישור תעבור מיד למסך הצלחה ומעקב.</p>
        </div>
        <form data-action="pay" class="stack">
          <div class="field"><label for="holderName">שם בעל הכרטיס</label><input id="holderName" name="holderName" type="text" data-dir="rtl" value="${esc(state.form.holderName)}" autocomplete="cc-name" /></div>
          <div class="field"><label for="cardNumber">מספר כרטיס</label><input id="cardNumber" name="cardNumber" type="text" data-dir="ltr" inputmode="numeric" value="${esc(state.form.cardNumber)}" autocomplete="cc-number" placeholder="4111111111111111" /></div>
          <div class="inline-fields">
            <div class="field"><label for="expiry">תוקף</label><input id="expiry" name="expiry" type="text" data-dir="ltr" value="${esc(state.form.expiry)}" autocomplete="cc-exp" placeholder="12/28" /></div>
            <div class="field"><label for="cvv">CVV</label><input id="cvv" name="cvv" type="password" data-dir="ltr" inputmode="numeric" value="${esc(state.form.cvv)}" autocomplete="cc-csc" placeholder="123" /></div>
          </div>
          <button class="primary" type="submit">אשר מסגרת והשלם הצטרפות</button>
          <p class="small muted">לבדיקת כשל מדומה אפשר להשתמש בכרטיס שמסתיים ב-0000.</p>
          ${previewPaymentNote}
        </form>
      </aside>
    </section>
  `;
}

function renderConfirmationPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) {
    return renderRecoveryState(
      "אין סשן שמור למסך הזה",
      "אפשר לחזור לעסקה ולהתחיל מסלול חדש, או להיכנס ישירות למעקב אם כבר יש לך מזהה השתתפות.",
      `/app/deal/${encodeURIComponent(dealId)}`
    );
  }
  if (!flow.participantId) {
    return renderRecoveryState(
      "עדיין אין אישור סופי להצגה",
      "כדי להגיע למסך האישור צריך לסיים קודם את שלב אישור המסגרת וההצטרפות.",
      `/app/join/${encodeURIComponent(dealId)}/payment`
    );
  }

  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis success-surface">
        <span class="eyebrow">שלב 3 מתוך 3</span>
        <span class="badge success">ההצטרפות נשמרה</span>
        <h1>הקונה נרשם לעסקה בהצלחה</h1>
        <p class="muted">השלמנו אימות טלפון, אישור מסגרת והרשמה לעסקה. מכאן עוברים למעקב עד לסגירת העסקה.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">הצטרפות</span><strong>נשמרה בהצלחה</strong></div>
          <div class="trust-point"><span class="muted">תפיסת מסגרת</span><strong>אושרה ונשמרה</strong></div>
          <div class="trust-point"><span class="muted">השלב הבא</span><strong>מעקב עד סגירת העסקה</strong></div>
        </div>
          <div class="summary-grid">
            <div class="summary-item"><span class="muted">מזהה השתתפות</span><strong class="mono">${esc(flow.participantId)}</strong></div>
            <div class="summary-item"><span class="muted">מזהה אישור המסגרת</span><strong class="mono">${esc(flow.authorizationId || "לא זמין")}</strong></div>
            <div class="summary-item"><span class="muted">כמות שנרשמה</span><strong>${num(flow.qty || 0)} יח'</strong></div>
            <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${esc(flow.deliveryMethodLabel || "לא זמין")}</strong></div>
            <div class="summary-item"><span class="muted">עלות אופן קבלה</span><strong>${currency(flow.deliveryCost || 0)}</strong></div>
            <div class="summary-item"><span class="muted">תפיסת מסגרת כוללת</span><strong>${currency(flow.estimatedTotal || 0)}</strong></div>
            <div class="summary-item"><span class="muted">מה נשמר עכשיו</span><strong>השתתפות פעילה עם תפיסת מסגרת</strong></div>
          </div>
          ${renderLegalReferenceStrip("confirmation")}
        </article>
      <aside class="card hero-side stack">
        <div class="info-strip tone-success">
          <strong>מה קורה עכשיו?</strong>
          <p class="small">מסך המעקב יראה אם כרגע רק נרשמת, אם החיוב כבר בוצע, ואם העסקה הושלמה או נכשלה.</p>
        </div>
        <div class="cta-panel success-panel">
          <strong>העסקה שלך כבר בתוך המערכת</strong>
          <p class="small muted">שמור את מסך המעקב, ושלח אותו לעצמך או למי שצריך לעקוב אחרי הסטטוס.</p>
        </div>
        ${flow.authorizationMessage ? `
          <div class="summary-item">
            <span class="muted">הודעת אישור המסגרת</span>
            <p class="small">${esc(flow.authorizationMessage)}</p>
          </div>
        ` : ""}
        <div class="summary-item">
          <span class="muted">המסלול עודכן</span>
          <strong>${relativeTime(flow.updatedAt)}</strong>
        </div>
        <div class="actions">
          <a class="button primary" href="/app/track/${encodeURIComponent(flow.participantId)}" data-nav="/app/track/${encodeURIComponent(flow.participantId)}">למסך המעקב</a>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(dealId)}" data-nav="/app/deal/${encodeURIComponent(dealId)}">חזרה לעסקה</a>
        </div>
      </aside>
    </section>
  `;
}

function renderTrackingPage() {
  if (!state.trackingPayload && state.loading) return "";
  if (!state.trackingPayload) {
    return renderEmptyState("לא מצאנו את ההשתתפות", "כדאי לבדוק את הקישור, או לחזור לעסקה ולהתחיל מסלול חדש.");
  }

  const tracking = state.trackingPayload.tracking;
  const dealState = getDealCopy(tracking.deal_state);
  const buyerState = getLabel(BUYER_COPY, tracking.buyer_state);
  const moneyState = getLabel(MONEY_COPY, tracking.money_state);
  const journey = buildJourney(tracking);
  const next = nextTrackingStep(tracking);
  const linkedFlow = getFlow(tracking.deal_id);

  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">מעקב השתתפות</span>
        <span class="badge ${dealState.badgeTone}">${dealState.label}</span>
        <h1>${esc(tracking.deal_title)}</h1>
        <p class="muted">${next.summary}</p>
        <div class="tracking-next-panel">
          <span class="muted">מה חשוב עכשיו</span>
          <strong>${next.title}</strong>
          <p class="small muted">${next.detail}</p>
        </div>
        <div class="status-grid">
          <div class="status-item"><span class="muted">מצב העסקה</span><strong>${dealState.label}</strong><p class="small muted">${dealState.description}</p></div>
          <div class="status-item"><span class="muted">מצב ההשתתפות</span><strong>${buyerState[0]}</strong><p class="small muted">${buyerState[1]}</p></div>
          <div class="status-item"><span class="muted">מצב כספי</span><strong>${moneyState[0]}</strong><p class="small muted">${moneyState[1]}</p></div>
          <div class="status-item"><span class="muted">אופן קבלה</span><strong>${esc(tracking.delivery_method_label || "לא זמין")}</strong><p class="small muted">${esc(formatDeliveryTypeLabel(tracking.delivery_method_type || ""))}</p></div>
          <div class="status-item"><span class="muted">עלות אופן קבלה</span><strong>${currency(tracking.delivery_cost || 0)}</strong><p class="small muted">נשמרה עם ההצטרפות</p></div>
          <div class="status-item"><span class="muted">עלות משוערת</span><strong>${currency(tracking.estimated_total)}</strong><p class="small muted">${num(tracking.qty)} יח' x ${currency(tracking.price_per_unit)} + ${currency(tracking.delivery_cost || 0)}</p></div>
        </div>
          <div class="stack section compact-section">
            <h3>איפה המסלול שלך עומד?</h3>
            <div class="status-rail tracking-rail">
              ${journey.map((step) => renderStep(step.title, step.done, step.current)).join("")}
            </div>
            <div class="info-strip">
              <strong>מסך המעקב הוא מקור האמת שלך</strong>
              <p class="small muted">כאן רואים יחד את מצב העסקה, מצב ההשתתפות, ומצב הכסף, בלי לעבור בין מסכים נוספים.</p>
            </div>
            ${renderLegalReferenceStrip("tracking")}
          </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight">
          <span class="muted">תמונת מצב עדכנית</span>
          <strong>${buyerState[0]}</strong>
          <p class="small muted">${moneyState[0]} · ${dealState.label}</p>
        </div>
        <div class="summary-item"><span class="muted">מזהה השתתפות</span><strong class="mono">${esc(tracking.participant_id)}</strong></div>
        <div class="summary-item"><span class="muted">מזהה קונה</span><strong>${esc(tracking.buyer_id)}</strong></div>
        <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${esc(tracking.delivery_method_label || "לא זמין")}</strong></div>
        ${linkedFlow?.lastTrackingViewedAt ? `<div class="summary-item"><span class="muted">צפייה אחרונה במסלול</span><strong>${dt(linkedFlow.lastTrackingViewedAt)}</strong></div>` : ""}
        ${linkedFlow?.updatedAt ? `<div class="summary-item"><span class="muted">סשן ה-flow עודכן</span><strong>${relativeTime(linkedFlow.updatedAt)}</strong></div>` : ""}
        <div class="summary-item"><span class="muted">חלון ההצטרפות</span><strong>${dt(tracking.deadline)}</strong></div>
        ${tracking.completion_window_until ? `<div class="summary-item"><span class="muted">סיום חלון השלמה</span><strong>${dt(tracking.completion_window_until)}</strong></div>` : ""}
        <div class="actions"><a class="button secondary" href="/app/deal/${encodeURIComponent(tracking.deal_id)}" data-nav="/app/deal/${encodeURIComponent(tracking.deal_id)}">חזרה לעסקה</a></div>
      </aside>
    </section>
  `;
}

function renderHome() {
  const payload = state.homePayload?.site;
  const preview = state.previewMeta?.preview;
  const sellerContext = payload?.seller_context || currentSellerContext();
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">האתר הראשי של סיטון</span>
        <h1>פותחים עסקה, מעלים דף אישי, ומפיצים לינק ישיר לקונים</h1>
        <p class="muted">
          סיטון היא פלטפורמה לעסקאות קבוצתיות מבוססות לינק. האתר הראשי הוא שער העבודה למוכר: מכאן פותחים עסקה, מפרסמים דף ציבורי אישי, ומפיצים לינק ישיר שדרכו הקונים מצטרפים.
        </p>
        <div class="actions">
          <a class="button primary" href="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}" data-nav="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}">פתיחת עסקה חדשה</a>
          <a class="button secondary" href="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}" data-nav="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}">ניהול העסקאות שלי</a>
        </div>
        <div class="summary-item">
          <span class="muted">נקודת הכניסה של הקונה</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
          <p class="small muted">${esc(payload?.buyer_entry_note || "הקונה נכנס ישירות לדף העסקה דרך לינק אישי, בלי חיפוש ובלי קטלוג.")}</p>
        </div>
        <div class="summary-item">
          <span class="muted">הכיוון המוצרי הפעיל</span>
          <strong>${esc(payload?.product_direction || "עסקאות קבוצתיות מבוססות לינק")}</strong>
          <p class="small muted">${esc(payload?.positioning || "אתר מותגי חזק למוכרים, עם דף עסקה ציבורי ולינק ישיר לקונה.")}</p>
        </div>
      </article>
        <aside class="card hero-side stack">
          <div class="summary-item"><span class="muted">עסקאות שנפתחו</span><strong>${num(payload?.proof_points?.total_deals || 0)}</strong></div>
          <div class="summary-item"><span class="muted">עסקאות חיות עכשיו</span><strong>${num(payload?.proof_points?.live_deals || 0)}</strong></div>
          <div class="summary-item"><span class="muted">עסקאות שהושלמו</span><strong>${num(payload?.proof_points?.completed_deals || 0)}</strong></div>
          ${preview?.is_demo_preview ? `<div class="summary-item"><span class="muted">מצב הסביבה</span><strong>${esc(formatEnvironmentLabel(preview?.deployment_mode || "preview"))}</strong></div>` : `<div class="summary-item"><span class="muted">מצב סביבת העבודה</span><strong>מסלול מוכר פעיל</strong></div>`}
          <div class="summary-item"><span class="muted">הבטחת המסלול</span><strong>המוכר פותח, הקונה מצטרף דרך לינק</strong></div>
          <div class="summary-item summary-spotlight"><span class="muted">מעטפת אמון ציבורית</span><strong>תנאי שימוש, פרטיות, ביטולים והחזרים</strong><p class="small muted">המידע המחייב זמין מהמשטחים הציבוריים כדי שהמוצר ייראה סגור, אחראי וברור גם לפני ההצטרפות.</p></div>
        </aside>
      </section>
    <section class="card section stack">
      <h2>מה כלול ב-V1</h2>
      <div class="card-list">${(payload?.v1_scope || []).map((item) => `<article class="summary-item"><strong>${esc(item)}</strong></article>`).join("")}</div>
    </section>
    <section class="card section stack">
      <h2>מה לא חלק מהכיוון הנוכחי</h2>
      <div class="card-list">${(payload?.out_of_scope || []).map((item) => `<article class="summary-item"><strong>${esc(item)}</strong></article>`).join("")}</div>
    </section>
  `;
}

function renderMarketplaceCard(item) {
  return `
    <article class="summary-item">
      <div class="actions spread">
        <div>
          <span class="muted">${esc(getDealCopy(item.state).label)}</span>
          <h3>${esc(item.title)}</h3>
        </div>
        <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(item.availability.badge || item.state)}</span>
      </div>
      <p class="small muted">${esc(item.availability.message || "")}</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">מחיר</span><strong>${currency(item.price_per_unit)}</strong></div>
        <div class="summary-item"><span class="muted">נרשמו</span><strong>${num(item.metrics.joined_units)}</strong></div>
        <div class="summary-item"><span class="muted">יתרה פנויה</span><strong>${num(item.metrics.remaining_units)}</strong></div>
        <div class="summary-item"><span class="muted">מועד סגירה</span><strong>${dt(item.deadline)}</strong></div>
      </div>
      <div class="actions">
        <a class="button primary" href="/app/deal/${encodeURIComponent(item.deal_id)}" data-nav="/app/deal/${encodeURIComponent(item.deal_id)}">פתיחת העסקה</a>
        <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">מסך המוכר</a>
      </div>
    </article>
  `;
}

function renderSellerPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) {
    return renderSellerAuthGate();
  }
  const payload = state.sellerPayload?.seller_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("אזור המוכר לא זמין", "לא הצלחנו לטעון עכשיו את אזור המוכר.");
  const sellerProfile = payload.seller_profile || currentSellerContext();
  const sellerDisplayName = normalizeSellerDisplayName(sellerProfile.seller_id, sellerProfile.display_name);
  const focus = sellerNextFocus(null, payload.totals);
  const draftDeals = Math.max(
    0,
    Number(payload.totals.total_deals || 0) -
      Number(payload.totals.live_deals || 0) -
      Number(payload.totals.completed_deals || 0) -
      Number(payload.totals.failed_or_cancelled || 0)
  );
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">אזור המוכר</span>
        <h1>פותחים, מפרסמים ומנהלים כל עסקה ממקום אחד</h1>
        <p class="muted">זהו שער העבודה הראשי למוכר: פותחים טיוטה, מפרסמים דף עסקה חי, מעתיקים לינק ישיר לקונים, ועוקבים אחרי ההצטרפויות בלי להישען על חיפוש ציבורי.</p>
        <div class="ops-band">
          <div class="ops-point"><span class="muted">זהות פעילה</span><strong>${esc(sellerDisplayName)}</strong></div>
          <div class="ops-point"><span class="muted">עסקאות חיות</span><strong>${num(payload.totals.live_deals)}</strong></div>
          <div class="ops-point"><span class="muted">עסקאות שהושלמו</span><strong>${num(payload.totals.completed_deals)}</strong></div>
        </div>
        <div class="metric-grid">
          <div class="metric"><span class="muted">כל העסקאות שלי</span><strong>${num(payload.totals.total_deals)}</strong></div>
          <div class="metric"><span class="muted">דפי עסקה חיים</span><strong>${num(payload.totals.live_deals)}</strong></div>
          <div class="metric"><span class="muted">עסקאות שהושלמו</span><strong>${num(payload.totals.completed_deals)}</strong></div>
        </div>
        <div class="actions">
          <a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">פתיחת עסקה חדשה</a>
        </div>
        <div class="kpi-strip">
          <div class="kpi-card strong"><span class="muted">עסקאות פעילות עכשיו</span><strong>${num(payload.totals.live_deals)}</strong><p class="small muted">המסכים שדורשים עכשיו הפצה, מעקב או בקרה.</p></div>
          <div class="kpi-card warning"><span class="muted">טיוטות שמחכות לפרסום</span><strong>${num(draftDeals)}</strong><p class="small muted">טיוטות שעדיין אפשר לדייק לפני יציאה ללינק חי.</p></div>
          <div class="kpi-card success"><span class="muted">עסקאות שהושלמו</span><strong>${num(payload.totals.completed_deals)}</strong><p class="small muted">עסקאות שכבר עברו את המסלול המלא בהצלחה.</p></div>
          <div class="kpi-card danger"><span class="muted">נסגרו ללא השלמה</span><strong>${num(payload.totals.failed_or_cancelled)}</strong><p class="small muted">מקום טוב לזהות מהר איפה צריך למנוע חזרה על אותו דפוס.</p></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        ${renderSellerContextPanel(sellerProfile)}
        <div class="summary-item summary-spotlight"><span class="muted">תמונת שליטה</span><strong>${num(payload.totals.total_deals)} עסקאות</strong><p class="small muted">${num(payload.totals.live_deals)} חיות · ${num(payload.totals.failed_or_cancelled)} נסגרו ללא השלמה</p></div>
        <div class="cta-panel">
          <strong>${esc(focus.title)}</strong>
          <p class="small muted">${esc(focus.detail)}</p>
        </div>
        <div class="surface-note">
          <strong>מה לראות קודם</strong>
          <p class="small muted">עסקה חיה עם חלון קצר או קצב חלש צריכה לבלוט מיד. טיוטה שלא פורסמה עדיין לא מייצרת כסף, ולכן עדיף לסגור אותה מהר או לקדם אותה ללינק חי.</p>
        </div>
        <div class="summary-item"><span class="muted">כלל העריכה</span><strong>עריכה מלאה רק בטיוטה</strong><p class="small muted">אחרי פרסום, הדף הציבורי והלינק הישיר הופכים למקור האמת הפעיל של העסקה.</p></div>
      </aside>
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>העסקאות של המוכר הפעיל</h2>
          <p class="muted section-intro">מכאן רואים מה כבר חי, מה עדיין בטיוטה, ומה דורש עכשיו הפצה, חיוב או סגירה.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>חיות</span><strong>${num(payload.totals.live_deals)}</strong></span>
          <span class="stat-pill"><span>טיוטות</span><strong>${num(draftDeals)}</strong></span>
          <span class="stat-pill"><span>סה"כ</span><strong>${num(payload.totals.total_deals)}</strong></span>
        </div>
      </div>
      ${payload.deals.length ? `<div class="card-list seller-board">${payload.deals.map(renderSellerDealCard).join("")}</div>` : `
        <div class="empty-surface stack">
          <strong>עדיין לא נפתחה אף עסקה תחת הזהות הזו</strong>
          <p class="small muted">כדאי להתחיל מטיוטה אחת חדה, לפרסם אותה, ולהפיץ לינק אישי ראשון לקונים.</p>
          <div class="actions"><a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">פתיחת עסקה ראשונה</a></div>
        </div>
      `}
    </section>
  `;
}

function renderSellerDealCard(item) {
  const progressPct = sellerDealProgressPct(item.metrics, item.max_units);
  const urgency = sellerDeadlineSignal(item.deadline, item.state);
  return `
    <article class="summary-item">
      <div class="seller-card-head">
        <div class="seller-card-meta">
          <span class="muted">עסקה ${esc(getDealCopy(item.state).label)}</span>
          <h3>${esc(item.title)}</h3>
          <div class="pill-row">
            <span class="stat-pill"><span>משתתפים</span><strong>${num(item.metrics.participants_count)}</strong></span>
            <span class="stat-pill"><span>יעד</span><strong>${num(item.threshold_units)}</strong></span>
          </div>
        </div>
        <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(getDealCopy(item.state).label)}</span>
      </div>
      <div class="meter"><span style="width:${Math.max(4, progressPct)}%"></span></div>
      <div class="progress-caption"><strong>${num(progressPct)}%</strong><span class="muted">מתקרת העסקה כבר נסגרה</span></div>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">יחידות שנרשמו</span><strong>${num(item.metrics.joined_units)}</strong></div>
        <div class="summary-item"><span class="muted">יתרה פנויה</span><strong>${num(item.metrics.remaining_units)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת הפלטפורמה</span><strong>${num(Math.round((item.commission_rate || 0) * 100))}%</strong></div>
        <div class="summary-item"><span class="muted">מועד סגירה</span><strong>${dt(item.deadline)}</strong></div>
      </div>
      <div class="urgency-panel ${urgency.tone}">
        <strong>${esc(urgency.title)}</strong>
        <p class="small muted">${esc(urgency.detail)}</p>
      </div>
      <div class="seller-card-footer">
        <div class="surface-note">
          <strong>הפעולה הבאה</strong>
          <p class="small muted">${esc(urgency.tone === "danger" ? "כדאי לבדוק עכשיו אם העסקה צריכה דחיפה אחרונה או מעבר לבקרה תפעולית." : urgency.tone === "warning" ? "העסקה נכנסת לחלון רגיש. שווה לוודא שהלינק הציבורי חד וברור." : "העסקה פתוחה ותחת שליטה. אפשר להמשיך לעקוב אחרי הקצב והקיבולת.")}</p>
        </div>
        <div class="actions">
          <a class="button primary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">ניהול העסקה</a>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(item.deal_id)}" data-nav="/app/deal/${encodeURIComponent(item.deal_id)}">פתיחת הדף הציבורי</a>
        </div>
      </div>
    </article>
  `;
}

function renderSellerNewPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) {
    return renderSellerAuthGate();
  }
  const sellerContext = currentSellerContext();
  const price = Math.max(0, Number(state.form.sellerPrice || 0));
  const minUnits = Math.max(0, Number(state.form.sellerMinUnits || 0));
  const maxUnits = Math.max(minUnits, Number(state.form.sellerMaxUnits || 0));
  const commissionPct = Math.max(0, Number(state.form.sellerCommissionRate || 0) * 100);
  const deliveryOptionsCount = [1, 2, 3].filter((slot) => String(state.form[`sellerDeliveryLabel${slot}`] || "").trim()).length;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">פתיחת עסקה</span>
        <h1>יוצרים את דף העסקה שבאמת יישלח לקונים</h1>
        <p class="muted">פותחים טיוטה, מגדירים אפשרויות קבלה, ומפרסמים רק כשהדף הציבורי מוכן להפצה בלינק ישיר.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">שלב ראשון</span><strong>שומרים טיוטה ברורה</strong></div>
          <div class="trust-point"><span class="muted">אחרי פרסום</span><strong>נוצר דף ציבורי חי</strong></div>
          <div class="trust-point"><span class="muted">הפצה לקונים</span><strong>דרך לינק ישיר בלבד</strong></div>
        </div>
        <form data-action="seller-create" class="form-shell">
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>בסיס העסקה</h3>
              <p class="small muted">מכאן נקבע איך העסקה תיתפס בעיני הקונה: מה נמכר, בכמה, ומה המרווח של הפלטפורמה.</p>
            </div>
            <div class="field"><label for="sellerTitle">כותרת העסקה</label><input id="sellerTitle" name="sellerTitle" type="text" value="${esc(state.form.sellerTitle)}" /></div>
            <div class="inline-fields">
              <div class="field"><label for="sellerPrice">מחיר ליחידה</label><input id="sellerPrice" name="sellerPrice" type="number" step="0.01" value="${esc(state.form.sellerPrice)}" /></div>
              <div class="field"><label for="sellerCommissionRate">עמלת הפלטפורמה</label><input id="sellerCommissionRate" name="sellerCommissionRate" type="number" step="0.01" value="${esc(state.form.sellerCommissionRate)}" /></div>
            </div>
            <div class="form-preview-grid">
              <div class="summary-item"><span class="muted">מחזור מינימלי משוער</span><strong>${currency(price * minUnits)}</strong><p class="small muted">${num(minUnits)} יח' לפי המחיר הנוכחי.</p></div>
              <div class="summary-item"><span class="muted">מחזור מקסימלי משוער</span><strong>${currency(price * maxUnits)}</strong><p class="small muted">${num(maxUnits)} יח' אם כל הקיבולת נסגרת.</p></div>
            </div>
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>יעד, קיבולת וסגירה</h3>
              <p class="small muted">החלק הזה קובע את תחושת הדחיפות והמסגרת העסקית שהקונה יראה על הדף.</p>
            </div>
            <div class="inline-fields">
              <div class="field"><label for="sellerMinUnits">מינימום יחידות</label><input id="sellerMinUnits" name="sellerMinUnits" type="number" step="1" value="${esc(state.form.sellerMinUnits)}" /></div>
              <div class="field"><label for="sellerMaxUnits">מקסימום יחידות</label><input id="sellerMaxUnits" name="sellerMaxUnits" type="number" step="1" value="${esc(state.form.sellerMaxUnits)}" /></div>
            </div>
            <div class="field"><label for="sellerDeadline">מועד סגירת חלון ההצטרפות</label><input id="sellerDeadline" name="sellerDeadline" type="datetime-local" value="${esc(state.form.sellerDeadline)}" /></div>
            <div class="surface-note">
              <strong>בדיקת שפיות מהירה</strong>
              <p class="small muted">כדאי שהמינימום יהיה יעד שאפשר להגיע אליו, שהמקסימום לא ירגיש מנותק מההפצה, ושהדדליין ייצור דחיפות בלי לבלבל את הקונה.</p>
            </div>
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>אפשרויות קבלה</h3>
              <p class="small muted">אפשרויות הקבלה צריכות להיות קצרות, מובנות, וקלות להשוואה כבר בדף הציבורי.</p>
            </div>
            <p class="small muted">מוסיפים אפשרות קבלה אחת או יותר. הבחירה של הקונה נשמרת על כל הצטרפות ונכנסת גם לסיכום תפיסת המסגרת.</p>
            ${[1, 2, 3].map((slot) => `
              <div class="form-option-card stack">
                <div class="inline-fields">
                  <div class="field">
                    <label for="sellerDeliveryType${slot}">סוג</label>
                    <select id="sellerDeliveryType${slot}" name="sellerDeliveryType${slot}">
                      ${["pickup", "delivery", "distribution_point"].map((option) => `<option value="${option}" ${state.form[`sellerDeliveryType${slot}`] === option ? "selected" : ""}>${formatDeliveryTypeLabel(option)}</option>`).join("")}
                    </select>
                  </div>
                  <div class="field">
                    <label for="sellerDeliveryCost${slot}">עלות</label>
                    <input id="sellerDeliveryCost${slot}" name="sellerDeliveryCost${slot}" type="number" step="0.01" min="0" value="${esc(state.form[`sellerDeliveryCost${slot}`])}" />
                  </div>
                </div>
                <div class="field">
                  <label for="sellerDeliveryLabel${slot}">תווית לקונה</label>
                  <input id="sellerDeliveryLabel${slot}" name="sellerDeliveryLabel${slot}" type="text" value="${esc(state.form[`sellerDeliveryLabel${slot}`])}" placeholder="${slot === 1 ? "איסוף עצמי" : "תווית אפשרות קבלה"}" />
                </div>
              </div>
            `).join("")}
          </section>
          <div class="actions">
            <button class="primary" type="submit">יצירת טיוטה</button>
            <a class="button secondary" href="/app/seller" data-nav="/app/seller">חזרה לאזור המוכר</a>
          </div>
        </form>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight"><span class="muted">זהות המוכר הפעילה</span><strong>${esc(sellerContext.display_name)}</strong><p class="small muted">מזהה מוכר: <span class="mono">${esc(sellerContext.seller_id)}</span></p></div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">מחיר נוכחי</span><strong>${currency(price)}</strong></div>
          <div class="summary-item"><span class="muted">עמלה</span><strong>${num(commissionPct)}%</strong></div>
          <div class="summary-item"><span class="muted">יעד פתיחה</span><strong>${num(minUnits)} יח'</strong></div>
          <div class="summary-item"><span class="muted">קיבולת</span><strong>${num(maxUnits)} יח'</strong></div>
        </div>
        <div class="cta-panel">
          <strong>מה יקרה אחרי שמירת הטיוטה</strong>
          <p class="small muted">הטיוטה תיכנס ישר לאזור המוכר, ומשם אפשר לפרסם דף ציבורי חי, לפתוח לינק ישיר ולהתחיל לעקוב אחרי הצטרפויות.</p>
        </div>
        <div class="form-checklist">
          <div class="summary-item"><span class="muted">אפשרויות קבלה מוכנות</span><strong>${num(deliveryOptionsCount || 1)}</strong><p class="small muted">לפחות אפשרות קבלה אחת צריכה להיראות כמו בחירה אמיתית לקונה.</p></div>
          <div class="summary-item"><span class="muted">מה בודקים לפני פרסום</span><strong>כותרת, יעד ודדליין</strong><p class="small muted">אלה שלושת המקומות שהכי משפיעים על בהירות, אמון ודחיפות במסך הציבורי.</p></div>
        </div>
        <div class="info-strip trust-box">
          <strong>כלל העבודה במסך הזה</strong>
          <p class="small">כאן מגדירים פעם אחת את המסגרת העסקית: מחיר, יעד, חלון זמן ואפשרויות קבלה. רק אחרי שטיוטה נראית חדה, מפרסמים אותה לדף חי.</p>
        </div>
        <div class="surface-note">
          <strong>מעטפת trust בפרסום</strong>
          <p class="small muted">אחרי פרסום, הדף הציבורי והמסכים שאחריו מציגים footer משפטי קבוע וקישורים ברורים למידע המחייב. לא נוסף כאן אישור משפטי מחייב בתוך הטופס כדי לא לפתוח לוגיקה חדשה או state חדש.</p>
        </div>
      </aside>
    </section>
  `;
}

function renderSellerDealPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) {
    return renderSellerAuthGate();
  }
  const payload = state.sellerDealPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("ניהול העסקה לא זמין", "לא הצלחנו לטעון עכשיו את מסך ניהול העסקה.");
  const deal = payload.deal;
  const receipts = payload.receipts_surface;
  const delivery = payload.delivery_surface;
  const progressPct = sellerDealProgressPct(deal.metrics, deal.max_units);
  const urgency = sellerDeadlineSignal(deal.deadline, deal.state);
  const focus = sellerNextFocus(deal, null);
  const receiptsNote = normalizeSurfaceNote(receipts.note, "receipts");
  const deliveryNote = normalizeSurfaceNote(delivery.note, "delivery");
  const activeSellerId = payload.seller_profile?.seller_id || currentSellerContext().seller_id;
  const activeSellerDisplayName = normalizeSellerDisplayName(
    activeSellerId,
    payload.seller_profile?.display_name || currentSellerContext().display_name
  );
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">ניהול עסקה</span>
        <span class="badge ${DEAL_TONE[deal.state] || "warning"}">${esc(getDealCopy(deal.state).label)}</span>
        <h1>${esc(deal.title)}</h1>
        <p class="muted">זהו חדר הבקרה של המוכר לדף הציבורי, ללינק הישיר לקונים, לרשימת המשתתפים ולעדכוני הקבלה והמסירה.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">מצב עריכה</span><strong>${payload.seller_actions.edit_locked ? "נעול אחרי פרסום" : "עדיין בטיוטה"}</strong></div>
          <div class="trust-point"><span class="muted">דף ציבורי</span><strong>${payload.seller_actions.can_publish ? "מוכן לפרסום" : "כבר פורסם או נסגר"}</strong></div>
          <div class="trust-point"><span class="muted">קישור קונה</span><strong>לינק ישיר אחד לעסקה</strong></div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">מחיר ליחידה</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="summary-item"><span class="muted">יחידות שנרשמו</span><strong>${num(deal.metrics.joined_units)}</strong></div>
          <div class="summary-item"><span class="muted">משתתפים</span><strong>${num(deal.metrics.participants_count)}</strong></div>
          <div class="summary-item"><span class="muted">עמלת הפלטפורמה</span><strong>${num(Math.round((deal.commission_rate || 0) * 100))}%</strong></div>
        </div>
        <div class="live-summary-grid">
          <div class="summary-item summary-spotlight"><span class="muted">נותר למלא</span><strong>${num(Math.max(0, deal.max_units - deal.metrics.joined_units))} יח'</strong><p class="small muted">מתוך קיבולת כוללת של ${num(deal.max_units)} יח'.</p></div>
          <div class="summary-item"><span class="muted">סף פתיחה</span><strong>${num(deal.threshold_units)} יח'</strong><p class="small muted">יעד הבסיס לפני סגירת חלון ההצטרפות.</p></div>
          <div class="summary-item"><span class="muted">הקישור הפעיל</span><strong class="mono">${esc(payload.seller_profile?.direct_link || `/app/deal/${deal.deal_id}`)}</strong><p class="small muted">זהו הלינק שהקונים צריכים לראות ולהבין במהירות.</p></div>
        </div>
        <div class="meter"><span style="width:${Math.max(4, progressPct)}%"></span></div>
        <div class="progress-caption"><strong>${num(progressPct)}%</strong><span class="muted">מתקרת העסקה כבר נסגרה</span></div>
        <div class="actions">
          ${payload.seller_actions.can_publish ? `<form data-action="seller-publish" data-deal-id="${esc(deal.deal_id)}"><button class="primary" type="submit">פרסום הדף הציבורי</button></form>` : ""}
          <button class="secondary" type="button" data-inline-action="seller-clone" data-deal-id="${esc(deal.deal_id)}">יצירת טיוטה דומה</button>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(deal.deal_id)}" data-nav="/app/deal/${encodeURIComponent(deal.deal_id)}">פתיחת הדף הציבורי</a>
        </div>
        <div class="info-strip">
          <strong>מה נחשף לציבור אחרי פרסום</strong>
          <p class="small">הדף הציבורי והמסכים שאחריו מציגים כעת footer משפטי קבוע, מסרי trust סביב תפיסת מסגרת בלבד, וגישה ברורה ליצירת קשר ולמידע המחייב.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight"><span class="muted">תמונת מצב עדכנית</span><strong>${esc(getDealCopy(deal.state).label)}</strong><p class="small muted">${num(deal.metrics.joined_units)} יח' מתוך ${num(deal.max_units)} · ${num(progressPct)}% סגירה</p></div>
        <div class="urgency-panel ${urgency.tone}">
          <strong>${esc(urgency.title)}</strong>
          <p class="small muted">${esc(urgency.detail)}</p>
        </div>
        <div class="countdown-chip"><span>דדליין</span><strong>${dt(deal.deadline)}</strong></div>
        <div class="cta-panel">
          <strong>${esc(focus.title)}</strong>
          <p class="small muted">${esc(focus.detail)}</p>
        </div>
        <div class="surface-note">
          <strong>מה חשוב עכשיו</strong>
          <p class="small muted">${esc(payload.seller_actions.can_publish ? "אם הטיוטה נראית חדה, זה המקום לפרסם ולא להשאיר את העסקה בלי דף חי." : urgency.tone === "danger" ? "זה חלון שצריך בקרה מהירה: קצב, קישור ציבורי, ומשתתפים שכבר בפנים." : "המסך הזה נועד להחזיק תמונת מצב תפעולית אחת, בלי לחפש מידע בכמה מקומות.")}</p>
        </div>
        <div class="summary-item"><span class="muted">מצב עריכה</span><strong>${payload.seller_actions.edit_locked ? "נעול אחרי פרסום" : "טיוטה ניתנת לעריכה"}</strong></div>
        <div class="summary-item"><span class="muted">זהות המוכר הפעילה</span><strong>${esc(activeSellerDisplayName)}</strong><p class="small muted"><span class="mono">${esc(activeSellerId)}</span></p></div>
        <div class="summary-item"><span class="muted">הלינק הישיר</span><strong class="mono">${esc(payload.seller_profile?.direct_link || `/app/deal/${deal.deal_id}`)}</strong></div>
        <div class="summary-item"><span class="muted">אפשרויות קבלה</span><strong>${num((payload.delivery_options || []).length)}</strong></div>
        <div class="summary-item"><span class="muted">נוצרה ב-</span><strong>${dt(deal.created_at)}</strong></div>
        <div class="summary-item"><span class="muted">מועד סגירה</span><strong>${dt(deal.deadline)}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>אפשרויות קבלה</h2>
          <p class="muted section-intro">אלה האפשרויות שיראו לקונה בדף הציבורי ושיישמרו על כל הצטרפות.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>אפשרויות</span><strong>${num((payload.delivery_options || []).length)}</strong></span>
        </div>
      </div>
      ${payload.delivery_options?.length ? `
        <div class="card-list">
          ${payload.delivery_options.map((option) => `
            <article class="summary-item">
              <div class="actions spread">
                <strong>${esc(presentDeliveryOptionLabel(option.label, option.option_type))}</strong>
                <span class="badge success">${currency(option.cost || 0)}</span>
              </div>
              <p class="small muted">${esc(formatDeliveryTypeLabel(option.option_type || ""))}</p>
            </article>
          `).join("")}
        </div>
      ` : `<p class="muted">לא הוגדרו עדיין אפשרויות קבלה לעסקה הזאת.</p>`}
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>משתתפים</h2>
          <p class="muted section-intro">כאן רואים מי כבר נרשם, איזה אופן קבלה נבחר, ומה מצב ההשתתפות והתפיסה הכספית.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>משתתפים</span><strong>${num(payload.participants.length)}</strong></span>
        </div>
      </div>
      ${payload.participants.length ? renderTablePanel("רשימת משתתפים", "זה המקום לזהות מהר מי בפנים, באיזה סטטוס, ואיפה יש חריגות שצריך להסביר.", payload.participants, ["participant_id", "buyer_id", "qty", "delivery_method_label", "delivery_cost", "buyer_state", "money_state", "created_at"]) : `<div class="empty-surface"><p class="muted">עדיין אין מצטרפים לעסקה הזאת.</p></div>`}
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>ניסיונות חיוב</h2>
          <p class="muted section-intro">האזור הזה נכנס לפעולה כשהעסקה מגיעה לשלב החיוב בפועל או למסלול השלמה.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>ניסיונות</span><strong>${num(payload.payment_attempts.length)}</strong></span>
        </div>
      </div>
      ${payload.payment_attempts.length ? renderTablePanel("ניסיונות חיוב אחרונים", "כאן בודקים אם יש מעבר תקין בין ניסיון, תוצאה, וזמן הפעולה האחרון.", payload.payment_attempts, ["attempt_type", "correlation_id", "result_class", "created_at"]) : `<div class="empty-surface"><p class="muted">עדיין לא נרשמו ניסיונות חיוב.</p></div>`}
    </section>
    <section class="card section stack">
      <h2>קבלות וסיכום עסקה שהושלמה</h2>
      <p class="muted">${esc(receiptsNote)}</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">מצב מסמכים</span><strong>${esc(receipts.status)}</strong></div>
        <div class="summary-item"><span class="muted">ברוטו</span><strong>${currency(receipts.summary.gross_amount)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת סיטון</span><strong>${currency(receipts.summary.siton_fee_amount)}</strong></div>
        <div class="summary-item"><span class="muted">הקצאה לשותפים</span><strong>${currency(receipts.summary.affiliate_fee_amount)}</strong></div>
        <div class="summary-item summary-spotlight"><span class="muted">נטו למוכר</span><strong>${currency(receipts.summary.seller_net_amount)}</strong></div>
        <div class="summary-item"><span class="muted">מסמכים</span><strong>${num(receipts.summary.receipt_document_count)}</strong></div>
      </div>
      ${receipts.documents.length ? renderTablePanel("מסמכי קבלה פנימיים", "הטבלה הזו מחברת בין משתתפים, ברוטו, שותפים וסטטוס העברה כדי לתת תמונת כסף אחת.", receipts.documents, ["receipt_id", "participant_id", "buyer_id", "qty", "gross_amount", "affiliate_name", "affiliate_fee_amount", "payout_status"]) : `<div class="empty-surface"><p class="muted">עדיין אין מסמכים להנפקה. רק עסקה שהושלמה עם חיוב מוצלח מייצרת את המשטח הזה.</p></div>`}
      <p class="small muted">זהו משטח פנימי למוכנות חשבונאית, לא מסמך חיצוני שהופק בפועל.</p>
    </section>
    <section class="card section stack">
      <h2>ניהול מסירה וקבלה</h2>
      <p class="muted">${esc(deliveryNote)}</p>
      ${delivery.rows.length ? `<div class="card-list">${delivery.rows.map((row) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(formatDeliveryStatusLabel(row.status))}</span>
              <h3>${esc(row.buyer_id)}</h3>
            </div>
            <strong>${num(row.qty)} יחידות</strong>
          </div>
          <p class="small muted">מספר מעקב: ${esc(row.tracking_number || "לא הוגדר")} • מצב כספי: ${esc(formatVisibleMoneyState(row.money_state))}</p>
          <p class="small muted">מסמנים נשלח או נמסר רק יחד עם מספר מעקב. מסמנים תקלה רק כשמוסיפים הסבר ברור.</p>
          <form class="stack" data-action="seller-delivery-update" data-deal-id="${esc(deal.deal_id)}" data-participant-id="${esc(row.participant_id)}">
            <div class="inline-fields">
              <div class="field">
                <label>סטטוס</label>
                <select name="deliveryStatus">
                  ${["ready_to_fulfill","shipped","delivered","issue"].map((option) => `<option value="${option}" ${row.status === option ? "selected" : ""}>${formatDeliveryStatusLabel(option)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>מספר מעקב</label>
                <input name="trackingNumber" type="text" data-dir="ltr" value="${esc(row.tracking_number || "")}" />
              </div>
            </div>
            <div class="field">
              <label>הערת תקלה</label>
              <input name="issueNote" type="text" value="${esc(row.issue_note || "")}" placeholder="הערת מוכר פנימית, אם נדרש" />
            </div>
            <button class="secondary" type="submit">שמירת עדכון</button>
          </form>
        </article>
      `).join("")}</div>` : `<p class="muted">ניהול המסירה נפתח רק למשתתפים שחויבו בהצלחה בעסקה שהושלמה.</p>`}
      <p class="small muted">העדכונים כאן מייצגים סטטוס מסירה ומעקב בלבד, ולא חיבור חי לחברת שילוח.</p>
    </section>
  `;
}

function renderAffiliatePage() {
  const payload = state.affiliatePayload?.affiliate_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("מסך השותפים לא זמין", "לא הצלחנו לטעון עכשיו את המסך הפנימי של השותפים.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="badge warning">מסך פנימי</span>
        <span class="eyebrow">שותפים והפניות</span>
        <h1>מסך פנימי לייחוס שותפים ולמוכנות תשלום</h1>
        <p class="muted">המסך הזה נשאר פנימי. הוא מרכז ייחוס, אימות ומוכנות תשלום לשותפים, אבל אינו חלק מהמסלול הראשי של המוכר והקונה.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">מצב ייחוס</span><strong>${esc(payload.attribution_status)}</strong></div>
          <div class="summary-item"><span class="muted">מצב תשלום</span><strong>${esc(payload.payout_status)}</strong></div>
          <div class="summary-item"><span class="muted">מצב אימות</span><strong>${esc(payload.verification_status)}</strong></div>
          <div class="summary-item"><span class="muted">אמצעי תשלום</span><strong>${esc(payload.payout_method)}</strong></div>
        </div>
        <div class="info-strip tone-info">
          <strong>הערת מוכנות פנימית</strong>
          <p>${esc(payload.note)}</p>
        </div>
        <div class="info-strip tone-warning">
          <strong>גבול התשלום במסך הפנימי</strong>
          <p>הסטטוסים שמוצגים כאן מתארים מוכנות ותהליך פנימי בלבד. אין כאן הפעלה של מסילת תשלום חיצונית.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">קמפיינים פעילים במסך</span><strong>${num(payload.campaigns.length)}</strong></div>
        <div class="summary-item"><span class="muted">פרטי תשלום שמורים</span><strong>${esc(payload.payout_details_masked)}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>סיכום שותפים</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">קונים משויכים</span><strong>${num(payload.totals.total_attributions)}</strong></div>
        <div class="summary-item"><span class="muted">עמלות בהמתנה</span><strong>${currency(payload.totals.pending_commission)}</strong></div>
        <div class="summary-item"><span class="muted">עמלות שאושרו</span><strong>${currency(payload.totals.approved_commission)}</strong></div>
        <div class="summary-item"><span class="muted">עמלות ששולמו</span><strong>${currency(payload.totals.paid_commission)}</strong></div>
      </div>
      <div class="summary-item">
        <span class="muted">הערת אימות פנימית</span>
        <strong>${esc(payload.verification_surface.admin_note || "עדיין לא נוספה הערת אימות פנימית")}</strong>
      </div>
      <form class="stack" data-action="affiliate-save-payout">
        <div class="inline-fields">
          <div class="field">
            <label>אמצעי תשלום</label>
            <select name="affiliatePayoutMethod">
              ${["bank_transfer","manual_wire"].map((option) => `<option value="${option}" ${payload.payout_method === option ? "selected" : ""}>${option}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>פרטי תשלום פנימיים</label>
            <input name="affiliatePayoutDetails" type="text" placeholder="IBAN / account / descriptor" />
          </div>
        </div>
        <button class="primary" type="submit">שמירת פרופיל תשלום</button>
      </form>
    </section>
    <section class="card section stack">
      <h2>קמפיינים זמינים לשותף</h2>
      <div class="card-list">
        ${payload.campaigns.map((campaign) => `
          <article class="summary-item">
            <span class="muted">${esc(campaign.state)}</span>
            <h3>${esc(campaign.title)}</h3>
            <p class="small muted">עמלה: ${num(Math.round((campaign.commission_rate || 0) * 100))}%</p>
            <p class="small muted">קונים משויכים: ${num(campaign.attributed_buyers)} • בהמתנה ${currency(campaign.pending_commission)} • אושר ${currency(campaign.approved_commission)} • שולם ${currency(campaign.paid_commission)}</p>
            <p class="small mono">${esc(campaign.share_link)}</p>
            <div class="actions">
              <a class="button secondary" href="/app/deal/${encodeURIComponent(campaign.deal_id)}" data-nav="/app/deal/${encodeURIComponent(campaign.deal_id)}">פתיחת העסקה</a>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderAdminPage() {
  const payload = state.adminPayload?.admin_surface;
  const systemStatus = state.adminSystemStatusPayload?.system_status;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("מסך הניהול הפנימי לא זמין", "לא הצלחנו לטעון עכשיו את מסך הניהול הפנימי.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="badge warning">מסך פנימי</span>
        <span class="eyebrow">ניהול ותפעול</span>
        <h1>מסך פנימי לפעולות תפעול, בקרה ותמיכה</h1>
        <p class="muted">המסך הזה הוא פנימי בלבד. הוא תומך בתפעול, בתמיכה ובבקרה מערכתית, ואינו חלק מהסיפור הראשי של המוכר והקונה.</p>
        <form class="stack" data-action="admin-search">
          <div class="field">
            <label for="adminQuery">חיפוש פנימי</label>
            <input id="adminQuery" name="adminQuery" type="search" data-dir="ltr" value="${esc(state.form.adminQuery)}" placeholder="מזהה עסקה, כותרת, מזהה משתתף או מזהה קונה" />
          </div>
          <button class="primary" type="submit">חיפוש</button>
        </form>
        <div class="metric-grid">
          <div class="metric"><span class="muted">עסקאות</span><strong>${num(payload.totals.deals)}</strong></div>
          <div class="metric"><span class="muted">עסקאות חיות</span><strong>${num(payload.totals.live)}</strong></div>
          <div class="metric"><span class="muted">עסקאות חריגות</span><strong>${num(payload.totals.exceptional)}</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">טיוטות</span><strong>${num(payload.totals.draft)}</strong></div>
        <div class="summary-item"><span class="muted">מצב מערכת</span><strong>${systemStatus?.app_health?.ok ? "תקין" : "דורש תשומת לב"}</strong></div>
        <div class="summary-item"><span class="muted">מצב סביבה</span><strong>${esc(formatEnvironmentLabel(systemStatus?.deployment?.mode || state.previewMeta?.preview?.deployment_mode || "preview"))}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>עסקאות חריגות</h2>
      ${payload.exceptional_deals.length ? `<div class="card-list">${payload.exceptional_deals.map(renderAdminDealCard).join("")}</div>` : `<p class="muted">לא חזרו עסקאות חריגות כרגע.</p>`}
    </section>
    <section class="card section stack">
      <h2>תוצאות חיפוש פנימי</h2>
      ${payload.search_results.length ? renderRowsTable(payload.search_results, ["entity_type", "entity_id", "headline", "state", "detail"]) : `<p class="muted">עדיין אין תוצאות. אפשר לחפש עסקאות, משתתפים או מזהי קונה.</p>`}
    </section>
    <section class="card section stack">
      <h2>תור אימות ובקרה</h2>
      ${payload.kyc_queue.length ? `<div class="card-list">${payload.kyc_queue.map((item) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(item.subject_type)}</span>
              <h3>${esc(item.display_name)}</h3>
            </div>
            <strong>${esc(item.status)}</strong>
          </div>
          <p class="small muted">פירוט: ${esc(item.detail || "לא זמין")} • עודכן ב-${dt(item.updated_at)}</p>
          <div class="actions">
            <form data-action="admin-kyc-decision" data-subject-type="${esc(item.subject_type)}" data-subject-id="${esc(item.subject_id)}" data-decision="approve" class="stack">
              <input type="hidden" name="adminNote" value="Approved during copy and narrative unification pass" />
              <button class="secondary" type="submit">אישור</button>
            </form>
            <form data-action="admin-kyc-decision" data-subject-type="${esc(item.subject_type)}" data-subject-id="${esc(item.subject_id)}" data-decision="reject" class="stack">
              <input type="hidden" name="adminNote" value="Rejected during copy and narrative unification pass" />
              <button class="secondary" type="submit">דחייה</button>
            </form>
          </div>
        </article>
      `).join("")}</div>` : `<p class="muted">אין כרגע פריטי אימות שממתינים לטיפול.</p>`}
    </section>
    <section class="card section stack">
      <h2>התחשבנות ותשלומים</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">עסקאות מוכר שהושלמו</span><strong>${num(payload.settlements.seller_workspace.completed_deals)}</strong></div>
        <div class="summary-item"><span class="muted">ברוטו למוכר</span><strong>${currency(payload.settlements.seller_workspace.gross_amount)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת פלטפורמה</span><strong>${currency(payload.settlements.seller_workspace.platform_fee_amount)}</strong></div>
      </div>
      ${payload.settlements.affiliates.length ? `<div class="card-list">${payload.settlements.affiliates.map((item) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(item.verification_status)}</span>
              <h3>${esc(item.display_name)}</h3>
            </div>
            <strong>${esc(item.payout_status)}</strong>
          </div>
          <p class="small muted">בהמתנה ${currency(item.pending_commission)} • אושר ${currency(item.approved_commission)} • שולם ${currency(item.paid_commission)}</p>
          <form data-action="admin-affiliate-payout" data-affiliate-id="${esc(item.affiliate_id)}" class="inline-fields">
            <div class="field">
              <label>מצב תשלום</label>
              <select name="affiliatePayoutStatus">
                ${["pending_review","approved","paid","hold"].map((option) => `<option value="${option}" ${item.payout_status === option ? "selected" : ""}>${option}</option>`).join("")}
              </select>
            </div>
            <button class="secondary" type="submit">עדכון מצב תשלום</button>
          </form>
        </article>
      `).join("")}</div>` : `<p class="muted">עדיין אין שורות התחשבנות לשותפים.</p>`}
    </section>
    <section class="card section stack">
      <h2>מרכז תמיכה פנימי</h2>
      <form class="stack" data-action="admin-support-create">
        <div class="inline-fields">
          <div class="field">
            <label>סוג ישות</label>
            <select name="supportScopeType">
              ${["deal","participant","affiliate","seller","system"].map((option) => `<option value="${option}">${option}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>מזהה ישות</label>
            <input name="supportScopeKey" type="text" placeholder="deal id / participant id / seller-default" />
          </div>
        </div>
        <div class="field"><label>כותרת</label><input name="supportTitle" type="text" placeholder="סיכום קצר לפנייה" /></div>
        <div class="inline-fields">
          <div class="field">
            <label>עדיפות</label>
            <select name="supportPriority">
              <option value="normal">רגיל</option>
              <option value="high">גבוה</option>
            </select>
          </div>
          <div class="field"><label>סיכום</label><input name="supportSummary" type="text" placeholder="מה דורש בדיקה?" /></div>
        </div>
        <button class="primary" type="submit">פתיחת פנייה</button>
      </form>
      ${payload.support_tickets.length ? `<div class="card-list">${payload.support_tickets.map((ticket) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(ticket.scope_type)}:${esc(ticket.scope_key)}</span>
              <h3>${esc(ticket.title)}</h3>
            </div>
            <strong>${esc(ticket.status)}</strong>
          </div>
          <p class="small muted">${esc(ticket.summary || "ללא סיכום")} • ${esc(ticket.priority)}</p>
          <form data-action="admin-support-update" data-ticket-id="${esc(ticket.ticket_id)}" class="inline-fields">
            <div class="field">
              <label>סטטוס</label>
              <select name="supportTicketStatus">
                ${["open","investigating","resolved"].map((option) => `<option value="${option}" ${ticket.status === option ? "selected" : ""}>${option}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>סיכום</label>
              <input name="supportTicketSummary" type="text" value="${esc(ticket.summary || "")}" />
            </div>
            <button class="secondary" type="submit">שמירת פנייה</button>
          </form>
        </article>
      `).join("")}</div>` : `<p class="muted">עדיין אין פניות פתוחות.</p>`}
    </section>
    <section class="card section stack">
      <h2>עומק מערכת ובקרה</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">כמות DLQ</span><strong>${num(payload.forensics.dlq_count)}</strong></div>
        <div class="summary-item"><span class="muted">Webhookים שנכשלו</span><strong>${num(payload.forensics.failed_webhooks)}</strong></div>
        <div class="summary-item"><span class="muted">Webhookים שנדחו</span><strong>${num(payload.forensics.ignored_webhooks)}</strong></div>
        <div class="summary-item"><span class="muted">Webhookים בהמתנה</span><strong>${num(payload.forensics.pending_webhooks)}</strong></div>
        <div class="summary-item"><span class="muted">אירועי audit אחרונים</span><strong>${num(payload.forensics.recent_audit_events)}</strong></div>
      </div>
    </section>
    <section class="card section stack">
      <h2>מצב המערכת</h2>
      ${systemStatus ? `
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">בריאות אפליקטיבית</span><strong>${systemStatus.app_health.ok ? "תקין" : "ירוד"}</strong></div>
          <div class="summary-item"><span class="muted">מצב תשלומים</span><strong>${esc(systemStatus.integrations.payment.mode)}</strong></div>
          <div class="summary-item"><span class="muted">מצב התראות</span><strong>${esc(systemStatus.integrations.notifications.mode)}</strong></div>
          <div class="summary-item"><span class="muted">תור שליחה פעיל</span><strong>${num(systemStatus.operational_counts.active_outbox)}</strong></div>
          <div class="summary-item"><span class="muted">כמות DLQ</span><strong>${num(systemStatus.operational_counts.dlq_count)}</strong></div>
          <div class="summary-item"><span class="muted">Webhookים בהמתנה</span><strong>${num(systemStatus.operational_counts.pending_webhooks)}</strong></div>
          <div class="summary-item"><span class="muted">Webhookים שנכשלו</span><strong>${num(systemStatus.operational_counts.failed_webhooks)}</strong></div>
          <div class="summary-item"><span class="muted">פניות תמיכה פתוחות</span><strong>${num(systemStatus.operational_counts.open_support_tickets)}</strong></div>
        </div>
        <div class="info-strip tone-info">
          <strong>גבול ההפעלה החיצונית</strong>
          <p>${esc(systemStatus.notes.join(" "))}</p>
        </div>
      ` : `<p class="muted">לא הצלחנו לטעון כרגע את מצב המערכת.</p>`}
    </section>
  `;
}

function renderAdminDealCard(item) {
  return `
    <article class="summary-item">
      <span class="muted">${esc(getDealCopy(item.state).label)}</span>
      <h3>${esc(item.title)}</h3>
      <p class="small muted">נרשמו ${num(item.metrics.joined_units)} מתוך ${num(item.max_units)} יחידות</p>
      <div class="actions">
        <a class="button primary" href="/app/admin/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(item.deal_id)}">פתיחת הפרופיל הפנימי</a>
        <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">מסך המוכר</a>
      </div>
    </article>
  `;
}

function renderAdminDealPage() {
  const payload = state.adminDealPayload?.profile;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("פרופיל העסקה הפנימי לא זמין", "לא הצלחנו לטעון עכשיו את פרופיל העסקה הפנימי.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">פרופיל עסקה פנימי</span>
        <h1>${esc(payload.deal.title || payload.deal.deal_id)}</h1>
        <p class="muted">תמונת אמת פנימית של מצב העסקה, המשתתפים, האירועים התפעוליים, ניסיונות החיוב וה-audit.</p>
        ${renderRowsTable([payload.deal], ["deal_id", "state", "price_per_unit", "min_units", "max_units", "threshold_units", "deadline", "commission_rate"])}
      </article>
      <aside class="card hero-side stack">
        <div class="actions">
          <a class="button secondary" href="/app/admin" data-nav="/app/admin">חזרה למסך הניהול</a>
          <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(payload.deal.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(payload.deal.deal_id)}">פתיחת מסך המוכר</a>
        </div>
      </aside>
    </section>
    <section class="card section stack"><h2>משתתפים</h2>${payload.participants.length ? renderRowsTable(payload.participants, ["participant_id", "buyer_id", "qty", "buyer_state", "money_state", "created_at"]) : `<p class="muted">לא נמצאו משתתפים.</p>`}</section>
    <section class="card section stack"><h2>תור שליחה</h2>${payload.outbox.length ? renderRowsTable(payload.outbox, ["event_type", "status", "available_at", "created_at"]) : `<p class="muted">לא נמצאו רשומות תור שליחה.</p>`}</section>
    <section class="card section stack"><h2>ניסיונות חיוב</h2>${payload.payment_attempts.length ? renderRowsTable(payload.payment_attempts, ["attempt_type", "correlation_id", "result_class", "created_at"]) : `<p class="muted">לא נמצאו ניסיונות חיוב.</p>`}</section>
    <section class="card section stack"><h2>ייחוסי שותפים</h2>${payload.affiliate_attributions.length ? renderRowsTable(payload.affiliate_attributions, ["participant_id", "share_code", "display_name", "commission_amount", "payout_status"]) : `<p class="muted">לא נמצאו ייחוסים לשותפים.</p>`}</section>
    <section class="card section stack"><h2>רשומות מסירה</h2>${payload.delivery.length ? renderRowsTable(payload.delivery, ["participant_id", "status", "tracking_number", "issue_note", "updated_at"]) : `<p class="muted">לא נמצאו רשומות מסירה.</p>`}</section>
    <section class="card section stack"><h2>פניות תמיכה</h2>${payload.support_tickets.length ? renderRowsTable(payload.support_tickets, ["ticket_id", "scope_type", "scope_key", "title", "priority", "status", "updated_at"]) : `<p class="muted">לא נמצאו פניות תמיכה לעסקה הזאת.</p>`}</section>
    <section class="card section stack"><h2>יומן בקרה</h2>${payload.audit.length ? renderRowsTable(payload.audit, ["entity_type", "state_type", "from_state", "to_state", "action_name", "created_at"]) : `<p class="muted">לא נמצאו אירועי יומן בקרה.</p>`}</section>
  `;
}

function renderAdminUserPage() {
  const payload = state.adminUserPayload?.profile;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("פרופיל המשתמש הפנימי לא זמין", "לא הצלחנו לטעון עכשיו את פרופיל המשתמש הפנימי.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">פרופיל משתמש פנימי</span>
        <h1>${esc(payload.buyer_id)}</h1>
        <p class="muted">המסך הזה מרכז את כל ההצטרפויות שנשמרו עבור מזהה הקונה שנוצר אחרי אימות טלפון.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">סך ההצטרפויות</span><strong>${num(payload.totals.total_joins)}</strong></div>
          <div class="summary-item"><span class="muted">הצטרפויות פעילות</span><strong>${num(payload.totals.active_joins)}</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="actions"><a class="button secondary" href="/app/admin" data-nav="/app/admin">חזרה למסך הניהול</a></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>היסטוריית הצטרפויות</h2>
      ${payload.joins.length ? renderRowsTable(payload.joins, ["participant_id", "deal_id", "title", "deal_state", "qty", "buyer_state", "money_state", "created_at"]) : `<p class="muted">לא נמצאו הצטרפויות עבור מזהה הקונה הזה.</p>`}
    </section>
  `;
}

const INTERNAL_TABLE_HEADER_LABELS = {
  entity_type: "סוג ישות",
  entity_id: "מזהה ישות",
  headline: "כותרת",
  state: "מצב",
  detail: "פירוט",
  deal_id: "מזהה עסקה",
  price_per_unit: "מחיר ליחידה",
  min_units: "מינימום יחידות",
  max_units: "מקסימום יחידות",
  threshold_units: "יעד בסיס",
  deadline: "מועד סגירה",
  commission_rate: "עמלה",
  participant_id: "מזהה משתתף",
  buyer_id: "מזהה קונה",
  qty: "כמות",
  buyer_state: "מצב משתתף",
  money_state: "מצב כספי",
  created_at: "נוצר ב-",
  event_type: "סוג אירוע",
  status: "סטטוס",
  available_at: "זמין מ-",
  attempt_type: "סוג ניסיון",
  correlation_id: "מזהה קורלציה",
  result_class: "סיווג תוצאה",
  delivery_method_label: "אופן קבלה",
  delivery_cost: "עלות קבלה",
  receipt_id: "מזהה קבלה",
  share_code: "קוד שיתוף",
  display_name: "שם תצוגה",
  commission_amount: "סכום עמלה",
  affiliate_fee_amount: "עמלת שותף",
  payout_status: "מצב תשלום",
  tracking_number: "מספר מעקב",
  issue_note: "הערת תקלה",
  updated_at: "עודכן ב-",
  ticket_id: "מזהה פנייה",
  scope_type: "סוג ישות",
  scope_key: "מזהה ישות",
  title: "כותרת",
  priority: "עדיפות",
  state_type: "סוג מצב",
  from_state: "ממצב",
  to_state: "למצב",
  action_name: "פעולה",
  deal_state: "מצב עסקה",
  gross_amount: "סכום ברוטו",
  affiliate_name: "שם שותף"
};

function formatInternalTableHeader(column) {
  return INTERNAL_TABLE_HEADER_LABELS[column] || column;
}

function formatVisibleBuyerState(value) {
  return getLabel(BUYER_COPY, String(value || ""))[0];
}

function formatVisibleMoneyState(value) {
  return getLabel(MONEY_COPY, String(value || ""))[0];
}

function formatEnvironmentLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "סביבת הדגמה";
  if (normalized === "preview" || normalized === "demo" || normalized === "demo-preview") return "סביבת הדגמה";
  if (normalized === "internal" || normalized === "internal-runtime") return "סביבת עבודה פנימית";
  if (normalized === "production") return "סביבת ייצור";
  if (normalized === "staging") return "סביבת בדיקות";
  return String(value);
}

function formatDeliveryStatusLabel(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "לא עודכן";
  if (normalized === "ready_to_fulfill") return "מוכן למסירה";
  if (normalized === "shipped") return "נשלח";
  if (normalized === "delivered") return "נמסר";
  if (normalized === "issue") return "דורש טיפול";
  if (normalized === "Pending") return "ממתין למסירה";
  if (normalized === "InTransit") return "בדרך";
  if (normalized === "Delivered") return "נמסר";
  if (normalized === "Issue") return "דורש טיפול";
  return normalized;
}

function sellerDealProgressPct(metrics, maxUnits) {
  const max = Math.max(1, Number(maxUnits || 0));
  const joined = Math.max(0, Number(metrics?.joined_units || 0));
  return Math.max(0, Math.min(100, Math.round((joined / max) * 100)));
}

function sellerDeadlineSignal(deadline, stateName) {
  const diff = new Date(deadline).getTime() - Date.now();
  if (!Number.isFinite(diff)) {
    return { tone: "warning", title: "מועד הסגירה לא זמין", detail: "כדאי לבדוק שהעסקה נשמרה עם חלון הצטרפות תקין." };
  }
  if (["Completed", "Failed", "Cancelled"].includes(String(stateName || ""))) {
    return { tone: stateName === "Completed" ? "success" : "danger", title: stateName === "Completed" ? "העסקה כבר נסגרה בהצלחה" : "העסקה נסגרה ללא המשך", detail: "אין עוד חלון הצטרפות פתוח, והמסך נשאר ככלי בקרה ומעקב." };
  }
  if (diff <= 0) {
    return { tone: "danger", title: "חלון ההצטרפות כבר נסגר", detail: "כדאי להתמקד עכשיו רק במעקב, בחיוב או בסגירה התפעולית של העסקה." };
  }
  const hours = diff / 3_600_000;
  if (hours <= 6) {
    return { tone: "danger", title: "חלון ההצטרפות קרוב לסיום", detail: `נותרו בערך ${Math.max(1, Math.round(hours))} שעות לסגירת הדף הציבורי.` };
  }
  if (hours <= 24) {
    return { tone: "warning", title: "העסקה נכנסת ליום האחרון שלה", detail: "זה הזמן לחזק הפצה, לעקוב אחרי קצב ההצטרפות ולוודא שהדף הציבורי חד וברור." };
  }
  return { tone: "success", title: "חלון ההצטרפות עדיין פתוח", detail: "יש עדיין זמן להפצה ולצבירת הצטרפויות לפני הסגירה." };
}

function sellerNextFocus(deal, totals) {
  if (deal?.state === "Draft") {
    return { title: "להשלים טיוטה ולפרסם דף חי", detail: "לפני פרסום כדאי לעבור שוב על מחיר, דדליין ואפשרויות הקבלה, ואז להוציא לינק אישי להפצה." };
  }
  if (deal?.state === "PendingTarget" || deal?.state === "TargetReached") {
    return { title: "להמשיך הפצה ולעקוב אחרי הקצב", detail: "הדף הציבורי כבר חי. עכשיו חשוב לראות קצב הצטרפות, חלון זמן וקיבולת שנותרה." };
  }
  if (deal?.state === "ReadyForCharging" || deal?.state === "Charging" || deal?.state === "CompletionWindow") {
    return { title: "להתמקד בבקרה תפעולית", detail: "כאן בודקים חיובים, מסמכים ומסירה, ולא פותחים עוד עריכה על העסקה עצמה." };
  }
  if ((totals?.live_deals || 0) > 0) {
    return { title: "יש כבר עסקאות חיות שדורשות תשומת לב", detail: "הדשבורד נועד לעזור לך לזהות מה דורש הפצה, מה מתקדם, ומה כבר נסגר." };
  }
  return { title: "לבנות את הדף הראשון שלך בצורה חדה", detail: "פתיחת עסקה טובה מתחילה בכותרת ברורה, מחיר מדויק, חלון זמן נכון ואופן קבלה פשוט להבנה." };
}

function normalizeSurfaceNote(note, kind) {
  const value = String(note || "").trim();
  if (!value) return "";
  if (kind === "receipts") {
    if (value.includes("Receipts are generated only")) {
      return "קבלות נוצרות רק עבור משתתפים שחויבו בהצלחה או הושלמו במסלול שחזור, ורק אחרי שהעסקה מגיעה להשלמה מלאה.";
    }
    if (value.includes("Receipts stay blocked until")) {
      return "קבלות נשארות חסומות עד שהעסקה מגיעה למצב הושלמה. עסקאות שנכשלו או בוטלו אינן מייצרות מסמכי מוכר.";
    }
  }
  if (kind === "delivery") {
    if (value.includes("Only successfully charged or recovered buyers")) {
      return "ניהול מסירה נפתח רק לקונים שחויבו בהצלחה או הושלמו במסלול שחזור. בסביבת הדגמה זהו משטח בקרה פנימי ולא חיבור חי לחברת שילוח.";
    }
    if (value.includes("Delivery operations become active only")) {
      return "ניהול המסירה הופך לפעיל רק אחרי שהעסקה הושלמה בהצלחה.";
    }
  }
  return value;
}

function presentDeliveryOptionLabel(label, type) {
  const value = String(label || "").trim();
  if (!value || /^\?+$/.test(value.replace(/\s+/g, "")) || value.includes("???")) {
    return formatDeliveryTypeLabel(String(type || ""));
  }
  return value;
}

function renderTablePanel(title, detail, rows, columns) {
  return `
    <div class="table-panel">
      <div class="table-toolbar">
        <div>
          <strong>${esc(title)}</strong>
          <p class="small muted">${esc(detail)}</p>
        </div>
        <span class="badge">${num(rows.length)} שורות</span>
      </div>
      ${renderRowsTable(rows, columns)}
    </div>
  `;
}

function renderRowsTable(rows, columns) {
  return `
    <div class="table-like">
      <div class="table-row table-head">${columns.map((column) => `<div class="table-cell"><span class="table-cell-label">שדה</span><span class="table-cell-value">${esc(formatInternalTableHeader(column))}</span></div>`).join("")}</div>
      ${rows.map((row) => `<div class="table-row">${columns.map((column) => `<div class="table-cell"><span class="table-cell-label">${esc(formatInternalTableHeader(column))}</span><span class="table-cell-value">${esc(formatCell(row[column], column))}</span></div>`).join("")}</div>`).join("")}
    </div>
  `;
}

function formatCell(value, column = "") {
  if (value === null || value === undefined || value === "") return "לא זמין";
  if (column === "deal_state" || (column === "state" && typeof value === "string" && DEAL_COPY[value])) return getDealCopy(String(value)).label;
  if (column === "buyer_state") return formatVisibleBuyerState(value);
  if (column === "money_state") return formatVisibleMoneyState(value);
  if (column === "delivery_method_type") return formatDeliveryTypeLabel(String(value));
  if (column === "status") return formatDeliveryStatusLabel(String(value));
  if (["price_per_unit", "delivery_cost", "gross_amount", "commission_amount", "affiliate_fee_amount"].includes(column)) return currency(value);
  if (["qty", "min_units", "max_units", "threshold_units"].includes(column)) return num(value);
  if (column.endsWith("_at") || column === "deadline" || column === "available_at") return dt(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderRecoveryState(title, message, href) {
  return `
    <section class="card section stack">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(message)}</p>
      <div class="actions">
        <a class="button primary" href="${href}" data-nav="${href}">חזרה למסלול הנכון</a>
        <a class="button secondary" href="/app" data-nav="/app">לעמוד הבית</a>
      </div>
    </section>
  `;
}

function renderEmptyState(title, message) {
  return `
    <section class="card section stack">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(message)}</p>
      <div class="actions">
        <a class="button secondary" href="/app" data-nav="/app">חזרה למסך הבית</a>
      </div>
    </section>
  `;
}

function renderNavLegacy() {
  const isInternalSurface = INTERNAL_SURFACE_ROUTES.has(state.route.name);
  const sellerContext = currentSellerContext();
  return `
      <nav class="page-nav">
        <div class="actions">
          <a href="/app" data-nav="/app" class="button secondary">סיטון</a>
          <a href="/app/seller" data-nav="/app/seller" class="button secondary">אזור מוכר</a>
        </div>
      ${!isInternalSurface ? `<div class="route-chip">מוכר פעיל: ${esc(sellerContext.display_name)}</div>` : ""}
      ${isInternalSurface ? `<div class="route-chip">מסך פנימי</div>` : ""}
      <a href="/app" data-nav="/app" class="button secondary">סיטון</a>
      <div class="route-chip">${ROUTE_LABELS[state.route.name] || "מסלול קונה"}</div>
    </nav>
  `;
}

function renderBanner(banner) {
  return `
    <section class="info-strip tone-${banner.tone || "info"}">
      <strong>${esc(banner.title)}</strong>
      <p>${esc(banner.message)}</p>
    </section>
  `;
}

function renderPublicTrustFooter() {
  if (!PUBLIC_TRUST_ROUTES.has(state.route.name)) return "";
  return `
    <footer class="trust-footer card section stack">
      <div class="trust-footer-grid">
        <div class="stack compact-section">
          <span class="eyebrow">מעטפת אמון ציבורית</span>
          <h2>מידע מחייב ברור, בלי להעמיס על המסלול</h2>
          <p class="muted">בסיטון הקונה מתקדם דרך לינק ישיר לעסקה. בשלב ההצטרפות נשמרת תפיסת מסגרת בלבד, והחיוב בפועל מתבצע רק אם העסקה נסגרת בהצלחה. אם העסקה לא נסגרת, המסגרת משתחררת, מתבטלת או לא הופכת לחיוב בפועל לפי מצב העסקה.</p>
        </div>
        <div class="trust-footer-panel">
          <div class="summary-item summary-spotlight">
            <span class="muted">המידע המחייב</span>
            <strong>תנאי שימוש, פרטיות, ביטולים והחזרים, יצירת קשר</strong>
            <p class="small muted">העמודים האלה זמינים מכל משטח ציבורי רלוונטי כדי שלא יהיה פער בין ההבטחה לבין מה שהקונה רואה בפועל.</p>
          </div>
          <div class="mini-legal-note">
            ${renderLegalLinkRow()}
          </div>
        </div>
      </div>
    </footer>
  `;
}

function renderLegalLinkRow() {
  return `
    <div class="legal-link-row">
      <a href="/app/terms" data-nav="/app/terms">תנאי שימוש</a>
      <a href="/app/privacy" data-nav="/app/privacy">מדיניות פרטיות</a>
      <a href="/app/refunds" data-nav="/app/refunds">ביטולים והחזרים</a>
      <a href="/app/contact" data-nav="/app/contact">יצירת קשר</a>
    </div>
  `;
}

function renderLegalReferenceStrip(context) {
  const detail = context === "payment"
    ? "לפני אישור המסגרת אפשר לראות כאן בדיוק מה מחייב, איך נשמרת הפרטיות, ומה קורה אם העסקה לא נסגרת."
    : context === "tracking"
      ? "גם אחרי ההצטרפות המידע המחייב נשאר זמין, כולל איך פונים ואיפה רואים מה קורה עם המסגרת."
      : context === "confirmation"
        ? "ההצטרפות נשמרה, אבל גם כאן המידע המחייב נשאר נגיש וברור."
        : "המידע המחייב נגיש כבר משלב הדף הציבורי כדי ליצור אמון עוד לפני ההצטרפות.";
  return `
    <div class="info-strip legal-strip">
      <strong>המידע המחייב והקשר</strong>
      <p class="small">${detail}</p>
      ${renderLegalLinkRow()}
    </div>
  `;
}

function renderLegalPage(title, eyebrow, intro, sections) {
  return `
    <section class="hero legal-hero">
      <article class="card hero-main stack hero-emphasis legal-page">
        <span class="eyebrow">${esc(eyebrow)}</span>
        <h1>${esc(title)}</h1>
        <p class="muted">${esc(intro)}</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">כניסה למסלול</span><strong>דרך לינק ישיר לעסקה</strong></div>
          <div class="summary-item"><span class="muted">בשלב ההצטרפות</span><strong>תפיסת מסגרת בלבד</strong></div>
          <div class="summary-item"><span class="muted">חיוב בפועל</span><strong>רק אם העסקה נסגרת בהצלחה</strong></div>
          <div class="summary-item"><span class="muted">איפה רואים הכול</span><strong>בדף העסקה, במעקב ובעמודים האלה</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack legal-side">
        <div class="summary-item summary-spotlight">
          <span class="muted">ניווט מהיר</span>
          <strong>עמודי trust ציבוריים</strong>
          <p class="small muted">העמודים האלה הם שכבת האמון הבסיסית של המוצר הציבורי, ולא placeholder פנימי.</p>
        </div>
        <div class="mini-legal-note">
          ${renderLegalLinkRow()}
        </div>
      </aside>
    </section>
    <section class="card section stack legal-sections">
      ${sections.map((section) => `
        <article class="legal-block">
          <h2>${esc(section.title)}</h2>
          <p class="muted">${esc(section.body)}</p>
        </article>
      `).join("")}
    </section>
  `;
}

function renderTermsPage() {
  return renderLegalPage(
    "תנאי שימוש",
    "שימוש בפלטפורמה",
    "תנאי השימוש מגדירים איך משתמשים במשטחים הציבוריים של סיטון, מהו אופי העסקה הקבוצתית, ואיפה עוברת האחריות בין הפלטפורמה, המוכר והקונה.",
    [
      { title: "מהו השירות", body: "סיטון היא פלטפורמה לניהול עסקאות קבוצתיות מבוססות לינק. המוכר פותח עסקה, מפרסם דף עסקה ציבורי, והקונה מצטרף דרך קישור ישיר ולא דרך קטלוג ציבורי פתוח." },
      { title: "מה קורה בשלב ההצטרפות", body: "בשלב ההצטרפות נשמרים פרטי המסלול, כולל כמות, אופן קבלה ואישור מסגרת. אין חיוב בפועל רק מעצם ההצטרפות. החיוב בפועל מתבצע רק אם העסקה נסגרת בהצלחה ובהתאם למצב העסקה." },
      { title: "אחריות המוכר", body: "המוכר אחראי לנכונות פרטי העסקה, למחיר, לחלון הזמנים, לאפשרויות הקבלה, ולתקשורת הישירה הנדרשת מול הקונים במסגרת העסקה שפרסם." },
      { title: "אחריות הקונה", body: "הקונה אחראי למסור פרטים נכונים, לעקוב אחר מצב ההשתתפות במסך המעקב, ולוודא שהכמות ואופן הקבלה שנשמרו אכן תואמים את רצונו לפני אישור המסגרת." },
      { title: "היקף השירות", body: "הפלטפורמה מספקת את משטחי ההצטרפות, האישור והמעקב. היא אינה מרחיבה כאן את ההתחייבויות מעבר למה שמופיע במפורש במסלול הציבורי ובמצבי העסקה בפועל." }
    ]
  );
}

function renderPrivacyPage() {
  return renderLegalPage(
    "מדיניות פרטיות",
    "פרטיות ושמירת מידע",
    "המדיניות הזו מסבירה איזה מידע נשמר לאורך מסלול ההצטרפות, למה הוא נשמר, ואיך הקונה רואה את המידע המחייב בלי להרגיש שהוא נכנס למסלול עמום.",
    [
      { title: "איזה מידע נאסף", body: "במהלך השימוש במסלול ההצטרפות נשמרים פרטים תפעוליים כמו כמות, בחירת אופן קבלה, מספר טלפון לצורך אימות, ומזהי השתתפות הנדרשים להצגת סטטוס ומעקב." },
      { title: "למה שומרים את המידע", body: "המידע נשמר כדי לאמת את הקונה, לייצב את מסלול ההצטרפות, להציג מצב עסקה עדכני, ולאפשר המשך למסך אישור המסגרת ולמסך המעקב של ההשתתפות." },
      { title: "מידע תשלומי", body: "בשלב הציבורי המתואר כאן נשמרת תפיסת מסגרת בלבד. המערכת אינה מציגה זאת כחיוב בפועל, והמידע התפעולי משמש את מסלול האישור בהתאם למצב העסקה." },
      { title: "שיתוף מידע", body: "המידע מוצג במשטחים הנדרשים לתפעול העסקה ולניהול המוכר, במידה הדרושה למסלול עצמו. אין כאן התחייבות לשימושים חיצוניים שלא הוצגו למשתמש במפורש." },
      { title: "שליטה ונגישות", body: "הקונה יכול לחזור למסך המעקב דרך הקישור הייעודי שנשמר לו, והמוכר רואה את המידע הנחוץ לניהול העסקה מתוך משטחי המוכר הרלוונטיים." }
    ]
  );
}

function renderRefundsPage() {
  return renderLegalPage(
    "מדיניות ביטולים והחזרים",
    "ביטולים, שחרור מסגרת והחזרים",
    "העמוד הזה מבהיר את הנקודה הכי רגישה במסלול: מה ההבדל בין תפיסת מסגרת לבין חיוב בפועל, ומה קורה אם העסקה לא מגיעה לסגירה מוצלחת.",
    [
      { title: "לפני סגירת עסקה", body: "בשלב ההצטרפות ואישור המסגרת לא נוצר חיוב בפועל רק מעצם הכניסה למסלול. המערכת שומרת תפיסת מסגרת בלבד עד להכרעת מצב העסקה." },
      { title: "אם העסקה לא נסגרת", body: "אם העסקה לא מגיעה להשלמה, המסגרת אמורה להשתחרר, להתבטל או לא להפוך לחיוב בפועל, בהתאם למצב הסופי של העסקה ולשכבת האישור הרלוונטית." },
      { title: "אם בוצע חיוב והעסקה שונתה לאחר מכן", body: "במקרה שבו הושלם חיוב בפועל ובהמשך נדרש ביטול או החזר, מסך המעקב והסטטוסים במערכת הם מקור האמת לגבי המצב התפעולי שהקונה רואה." },
      { title: "אחריות להסבר לקונה", body: "המוכר נדרש להציג עסקה ברורה ולהימנע מיצירת פער בין מה שהקונה מבין בדף העסקה לבין ההתנהגות התפעולית של העסקה בפועל." },
      { title: "איפה רואים סטטוס", body: "מסך המעקב נשאר הנקודה הפעילה ביותר לקונה אחרי הצטרפות, ובו רואים האם נשמרה מסגרת, האם שוחררה, והאם חל שינוי שמצריך מעקב נוסף." }
    ]
  );
}

function renderContactPage() {
  return renderLegalPage(
    "יצירת קשר",
    "קשר ותמיכה",
    "יצירת הקשר בסיטון בנויה סביב העסקה עצמה: היכן הקונה נמצא במסלול, מה המוכר פרסם, ומהו המסך שממנו ברור ביותר להמשיך טיפול.",
    [
      { title: "פנייה לגבי עסקה פעילה", body: "במקרה של שאלה על עסקה, כמות, אופן קבלה או מצב ההצטרפות, יש לפעול דרך דף העסקה הציבורי והמידע שמופיע במסך המעקב של אותה השתתפות." },
      { title: "פנייה למוכר", body: "המוכר הוא הגורם הראשון שאחראי לפרטי העסקה שפורסמה, לחלון ההצטרפות, לאפשרויות הקבלה ולמידע המסחרי שנחשף לקונים." },
      { title: "מידע מחייב לפני פעולה", body: "לפני אישור מסגרת או המשך במסלול, כדאי לעבור על תנאי השימוש, מדיניות הפרטיות ומדיניות הביטולים וההחזרים כדי להבין את מבנה האחריות ואת אופי העסקה." },
      { title: "מה אין בשלב הזה", body: "בשלב הציבורי הנוכחי לא נפתח כאן מוקד חדש או לוגיקת פנייה מערכתית חדשה. שכבת הקשר נשארת מינימלית, ברורה, ומבוססת על המשטחים שכבר קיימים במוצר." }
    ]
  );
}

function renderNav() {
  const isInternalSurface = INTERNAL_SURFACE_ROUTES.has(state.route.name);
  const sellerContext = currentSellerContext();
  return `
      <nav class="page-nav">
        <div class="actions">
          <a href="/app" data-nav="/app" class="button secondary">סיטון</a>
          <a href="/app/seller" data-nav="/app/seller" class="button secondary">אזור מוכר</a>
        </div>
      ${isInternalSurface ? `<div class="route-chip">מסך פנימי</div>` : ""}
      <div class="route-chip">${ROUTE_LABELS[state.route.name] || "מסלול קונה"}</div>
    </nav>
  `;
}

function renderErrorCard(error) {
  return `
    <section class="error-card">
      <strong>${esc(error.title || "אירעה שגיאה")}</strong>
      <p>${esc(error.message || "נסה שוב בעוד רגע.")}</p>
    </section>
  `;
}

function renderInfoStrip(message) {
  return `<div class="info-strip"><strong>${esc(message)}</strong></div>`;
}

function renderStep(title, done, current = false) {
  return `
    <div class="journey-step ${done ? "done" : ""} ${current ? "current" : ""}">
      <span class="journey-bullet">${done ? "V" : current ? ">" : ""}</span>
      <span>${esc(title)}</span>
    </div>
  `;
}

const API_TIMEOUT_MS = 15_000;

async function api(url, options = {}) {
  const sellerContext = currentSellerContext();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(usesDemoSellerContext() ? { "x-seller-id": sellerContext.seller_id } : {}),
        ...(options.headers || {})
      },
      ...options
    });
  } catch (fetchErr) {
    if (fetchErr && fetchErr.name === "AbortError") {
      const err = new Error("request timed out");
      err.status = 0;
      throw err;
    }
    throw fetchErr;
  } finally {
    clearTimeout(timeoutId);
  }
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (response.ok) return payload;
  const error = new Error(payload?.message || payload?.error || fallbackStatus(response.status) || "request_failed");
  error.status = response.status;
  throw error;
}

const paymentService = {
  authorize(paymentDetails) {
    return api("/api/payments/authorize", {
      method: "POST",
      body: json(paymentDetails)
    });
  }
};

const buyerFlowService = {
  joinDeal(dealId, { buyerId, qty, affiliateRef, deliveryOptionId, authorizationId, authorizationProvider, authorizationCorrelationId }) {
    return api(`/deals/${encodeURIComponent(dealId)}/join`, {
      method: "POST",
      headers: {
        "x-request-id": `frontend:${Date.now()}`,
        "idempotency-key": `frontend:${dealId}:${buyerId}:${qty}:${deliveryOptionId || "none"}`
      },
      body: json({
        buyer_id: buyerId,
        qty,
        affiliate_ref: affiliateRef || undefined,
        delivery_option_id: deliveryOptionId || undefined,
        authorization_id: authorizationId || undefined,
        authorization_provider: authorizationProvider || undefined,
        authorization_correlation_id: authorizationCorrelationId || undefined
      })
    });
  }
};

function friendlyError(error, fallback) {
  const message = String(error?.message || fallback || "");
  const lower = message.toLowerCase();
  const status = Number(error?.status || 0);

  if (status === 404 && lower.includes("deal not found")) {
    return { title: "העסקה לא נמצאה", message: "הקישור הזה לא מצביע לעסקה קיימת. כדאי לוודא שקיבלת מזהה עסקה תקין." };
  }
  if (status === 404 && lower.includes("participant not found")) {
    return { title: "לא מצאנו את ההשתתפות", message: "קישור המעקב הזה כבר לא תקין או שאינו שייך להשתתפות קיימת." };
  }
  if (status === 401 && lower.includes("seller session is required")) {
    return { title: "נדרשת התחברות מוכר", message: "ב-runtime הזה אזור המוכר נפתח רק עם session מוכר שהשרת מכיר. צריך להתחבר מחדש כדי להמשיך." };
  }
  if (status === 401 && lower.includes("seller id or access code is invalid")) {
    return { title: "פרטי הגישה לא נכונים", message: "מזהה המוכר או קוד הגישה לא תואמים לרשימת המוכרים המורשים של סביבת ה-launch." };
  }
  if (status === 403 && lower.includes("manual seller context switching is disabled")) {
    return { title: "החלפת זהות ידנית נחסמה", message: "במסלול non-demo השרת קובע את זהות המוכר דרך session פעיל, ולכן אי אפשר להחליף זהות דרך הטופס המקומי." };
  }
  if (status === 503 && lower.includes("seller auth is not configured")) {
    return { title: "seller auth לא הוגדר בסביבה", message: "הסביבה נמצאת כבר במסלול non-demo, אבל חסרים secret או invited seller credentials. לכן אזור המוכר חסום עד שהקונפיגורציה תושלם." };
  }
  if (lower.includes("join not allowed")) {
    return { title: "חלון ההצטרפות כבר סגור", message: "אי אפשר להצטרף לעסקה במצב הנוכחי שלה. אם כבר נרשמת, אפשר לעבור למעקב." };
  }
  if (lower.includes("max_units exceeded")) {
    return { title: "אין מספיק קיבולת פנויה", message: "הכמות שביקשת כבר לא זמינה. כדאי לחזור לדף העסקה ולעדכן את הכמות." };
  }
  if (lower.includes("invalid otp")) {
    return { title: "קוד האימות שגוי", message: "הקוד לא תואם לסשן הפעיל. אפשר לנסות שוב או לבקש קוד חדש." };
  }
  if (lower.includes("otp expired")) {
    return { title: "תוקף הקוד פג", message: "צריך לבקש קוד חדש כדי להמשיך במסלול." };
  }
  if (lower.includes("otp session not found")) {
    return { title: "אין סשן אימות פעיל", message: "נראה שהסשן הקודם כבר לא זמין. אפשר לבקש קוד חדש ולחדש את הזרימה." };
  }
  if (lower.includes("authorization failed")) {
    return { title: "אישור המסגרת נכשל", message: "אמצעי התשלום נדחה על ידי שכבת אישור המסגרת הקיימת. אפשר לנסות אמצעי אחר." };
  }
  if (status >= 500) {
    return { title: "המערכת כרגע לא זמינה", message: "לא הצלחנו להשלים את הפעולה בגלל בעיית שרת. כדאי לנסות שוב בעוד רגע." };
  }
  if (lower.includes("networkerror") || lower.includes("failed to fetch") || lower.includes("load failed")) {
    return { title: "בעיית חיבור", message: "לא הצלחנו להגיע לשרת. בדוק את החיבור לאינטרנט ונסה שוב." };
  }
  return {
    title: "אירעה שגיאה",
    message: fallback || message || "נסה שוב בעוד רגע."
  };
}

function fallbackStatus(status) {
  if (status === 400) return "invalid_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server_error";
  return "";
}

function validateQty(payload, qty) {
  if (!Number.isInteger(qty) || qty < 1) return "יש להזין כמות שלמה וחיובית.";
  const left = Number(payload?.metrics?.remaining_units ?? 0);
  if (qty > left) return `כרגע נותרו רק ${left} יחידות פנויות לעסקה הזו.`;
  return "";
}

function getDeliveryOptions(payload) {
  return payload?.deal?.delivery_options || [];
}

function formatDeliveryTypeLabel(type) {
  if (type === "pickup") return "איסוף עצמי";
  if (type === "delivery") return "משלוח";
  if (type === "distribution_point") return "נקודת חלוקה";
  return type || "לא צוין";
}

function getSelectedDeliveryOption(payload, selectedId) {
  const options = getDeliveryOptions(payload);
  if (!options.length) return null;
  if (selectedId) return options.find((option) => option.option_id === selectedId) || null;
  return options.length === 1 ? options[0] : null;
}

function validateDeliveryChoice(payload, selectedId) {
  const options = getDeliveryOptions(payload);
  if (!options.length) return "לא הוגדרה אפשרות קבלה לעסקה הזו.";
  if (options.length === 1) return "";
  return getSelectedDeliveryOption(payload, selectedId) ? "" : "צריך לבחור אופן קבלה לפני ההמשך.";
}

function calcHoldTotal(payload, qty, selectedOption) {
  const base = Math.max(0, Number(qty || 0)) * Number(payload?.deal?.price_per_unit || 0);
  const deliveryCost = Number(selectedOption?.cost || 0);
  return base + deliveryCost;
}

function collectSellerDeliveryOptions(formData) {
  const options = [];
  for (let index = 1; index <= 3; index += 1) {
    const type = String(formData.get(`sellerDeliveryType${index}`) || "").trim();
    const label = String(formData.get(`sellerDeliveryLabel${index}`) || "").trim();
    const rawCost = String(formData.get(`sellerDeliveryCost${index}`) || "").trim();
    if (!type && !label && !rawCost) continue;
    if (!label) continue;
    const cost = Number(rawCost || 0);
    if (!Number.isFinite(cost) || cost < 0) continue;
    options.push({
      option_type: type || "pickup",
      label,
      cost,
      sort_order: options.length
    });
  }
  return options;
}

function validatePayment(payload) {
  if (!payload.holder_name || !payload.card_number || !payload.expiry || !payload.cvv) {
    return "יש למלא שם בעל כרטיס, מספר כרטיס, תוקף ו-CVV.";
  }
  if (!/^\d{12,19}$/.test(payload.card_number)) {
    return "מספר הכרטיס צריך להכיל בין 12 ל-19 ספרות.";
  }
  return "";
}

function getFlow(dealId) {
  const all = readFlow();
  const flow = all[dealId] || null;
  if (!flow) return null;
  // Discard flows written by an incompatible schema version
  if (flow._v !== undefined && flow._v !== FLOW_SCHEMA_VERSION) {
    removeFlow(dealId);
    return null;
  }
  if (flow.updatedAt && Date.now() - new Date(flow.updatedAt).getTime() > FLOW_TTL_MS) {
    removeFlow(dealId);
    return null;
  }
  return flow;
}

function saveFlow(dealId, next) {
  const all = readFlow();
  all[dealId] = { ...(all[dealId] || {}), ...next, updatedAt: new Date().toISOString(), _v: FLOW_SCHEMA_VERSION };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
  return all[dealId];
}

function clearFlowFields(dealId, keys) {
  const all = readFlow();
  if (!all[dealId]) return;
  for (const key of keys) delete all[dealId][key];
  all[dealId].updatedAt = new Date().toISOString();
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
}

function removeFlow(dealId) {
  const all = readFlow();
  delete all[dealId];
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
}

function readFlow() {
  try {
    return JSON.parse(sessionStorage.getItem(FLOW_KEY) || "{}");
  } catch {
    return {};
  }
}

function defaultSellerContext() {
  return {
    seller_id: "seller-default",
    display_name: "אזור מוכר ברירת מחדל",
    verification_status: "approved",
    settlement_status: "active",
    is_default_context: true,
    context_source: "default_fallback"
  };
}

function sellerAuthMode() {
  return (
    state.sellerAuth?.mode ||
    state.homePayload?.site?.seller_auth?.mode ||
    state.previewMeta?.preview?.seller_auth?.mode ||
    (state.previewMeta?.preview?.is_demo_preview ? "demo-context" : "server-session")
  );
}

function usesDemoSellerContext() {
  return sellerAuthMode() === "demo-context";
}

function currentSellerAuth() {
  return (
    state.sellerAuth ||
    state.homePayload?.site?.seller_auth ||
    state.previewMeta?.preview?.seller_auth || {
      mode: sellerAuthMode(),
      configured: usesDemoSellerContext(),
      authenticated: usesDemoSellerContext(),
      allow_manual_context_switch: usesDemoSellerContext(),
      seller_context: null
    }
  );
}

function readSellerContext() {
  if (!usesDemoSellerContext()) {
    return state.sellerAuth?.seller_context || state.homePayload?.site?.seller_context || defaultSellerContext();
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(SELLER_CONTEXT_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return defaultSellerContext();
    return { ...defaultSellerContext(), ...parsed };
  } catch {
    return defaultSellerContext();
  }
}

function currentSellerContext() {
  if (state.sellerContext) return state.sellerContext;
  state.sellerContext = readSellerContext();
  return state.sellerContext;
}

function normalizeSellerDisplayName(sellerId, displayName) {
  if (
    sellerId === "seller-default" &&
    (!displayName || displayName === "Default Seller Workspace")
  ) {
    return "אזור מוכר ברירת מחדל";
  }
  return displayName || "";
}

function syncSellerContext(next) {
  const normalized = { ...defaultSellerContext(), ...(next || {}) };
  if (
    normalized.seller_id === "seller-default" &&
    (!normalized.display_name || normalized.display_name === "Default Seller Workspace")
  ) {
    normalized.display_name = "אזור מוכר ברירת מחדל";
  }
  normalized.display_name = normalizeSellerDisplayName(normalized.seller_id, normalized.display_name);
  state.sellerContext = normalized;
  state.form.sellerContextId = normalized.seller_id || "";
  state.form.sellerContextName = normalized.display_name || "";
  if (usesDemoSellerContext()) {
    localStorage.setItem(SELLER_CONTEXT_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function hydrateSellerContext() {
  syncSellerContext(readSellerContext());
}

function hydrateForm() {
  state.form.sellerContextId = currentSellerContext().seller_id;
  state.form.sellerContextName = currentSellerContext().display_name;
  const routeDealId = state.route.dealId;
  if (!routeDealId) return;
  const flow = getFlow(routeDealId);
  if (!flow) return;
  hydrateFormFromFlow(flow);
}

function hydrateFormFromFlow(flow) {
  state.form.qty = String(flow.qty || state.form.qty);
  state.form.deliveryOptionId = flow.deliveryOptionId || "";
  state.form.phone = flow.phone || "";
}

function renderSellerAuthGate() {
  const auth = currentSellerAuth();
  const configured = auth.configured !== false;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">אזור המוכר</span>
        <h1>${configured ? "נדרשת התחברות מוכר" : "seller auth עדיין לא הוגדר"}</h1>
        <p class="muted">${configured ? "ב-runtime הזה אזור המוכר נשען על session מוכר שנקבע בשרת. בלי session תקין אי אפשר לפתוח, לפרסם או לנהל עסקאות." : "ה-runtime כבר במסלול non-demo, אבל חסרים secret או invited seller credentials. זה נחסם בכוונה כדי לא לייצר תחושת ביטחון שגויה."}</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">מקור הסמכות</span><strong>session שרת</strong></div>
          <div class="trust-point"><span class="muted">מה כבר לא קובע</span><strong>localStorage או header</strong></div>
          <div class="trust-point"><span class="muted">מסלול דמו</span><strong>נשאר מבודד בנפרד</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        ${renderSellerContextPanel(auth.seller_context || currentSellerContext())}
      </aside>
    </section>
  `;
}

function renderSellerContextPanel(context) {
  const sellerContext = { ...defaultSellerContext(), ...(context || {}) };
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext()) {
    return `
      <section class="summary-item stack">
        <div class="actions spread">
          <div>
            <span class="muted">גישה למשטח המוכר</span>
            <strong>${auth.authenticated ? esc(sellerContext.display_name) : auth.configured === false ? "נדרש חיבור סביבה" : "התחברות מוכר"}</strong>
          </div>
          <span class="badge ${auth.authenticated ? "success" : auth.configured === false ? "danger" : "warning"}">${auth.authenticated ? "session פעיל" : auth.configured === false ? "לא מוגדר" : "נעול"}</span>
        </div>
        <p class="small muted">${auth.authenticated ? `השרת מזהה כרגע את המוכר כ-<span class="mono">${esc(sellerContext.seller_id)}</span>, והמסכים נשענים על session שרת ולא על header מקומי.` : auth.configured === false ? "הסביבה לא קיבלה עדיין SELLER_SESSION_SECRET או invited seller credentials, ולכן אזור המוכר חסום בכוונה." : "כדי להיכנס לאזור המוכר צריך מזהה מוכר וקוד גישה שהוגדרו מראש ל-launch המבוקר."}</p>
        ${auth.authenticated ? `
          <form data-action="seller-logout" class="stack">
            <div class="actions">
              <button class="secondary" type="submit">ניתוק session מוכר</button>
            </div>
          </form>
        ` : auth.configured === false ? "" : `
          <form data-action="seller-login" class="stack">
            <div class="inline-fields">
              <div class="field">
                <label for="sellerContextId">מזהה מוכר</label>
                <input id="sellerContextId" name="sellerContextId" type="text" data-dir="ltr" value="${esc(state.form.sellerContextId || "")}" placeholder="seller-north" />
              </div>
              <div class="field">
                <label for="sellerAccessCode">קוד גישה</label>
                <input id="sellerAccessCode" name="sellerAccessCode" type="password" data-dir="ltr" value="${esc(state.form.sellerAccessCode || "")}" placeholder="launch-code" />
              </div>
            </div>
            <div class="actions">
              <button class="primary" type="submit">פתיחת session מוכר</button>
            </div>
          </form>
        `}
      </section>
    `;
  }
  if (
    sellerContext.seller_id === "seller-default" &&
    (!sellerContext.display_name || sellerContext.display_name === "Default Seller Workspace")
  ) {
    sellerContext.display_name = "אזור מוכר ברירת מחדל";
  }
  sellerContext.display_name = normalizeSellerDisplayName(sellerContext.seller_id, sellerContext.display_name);
  return `
    <section class="summary-item stack">
      <div class="actions spread">
        <div>
          <span class="muted">זהות המוכר הפעילה</span>
          <strong>${esc(sellerContext.display_name)}</strong>
        </div>
        <span class="badge ${sellerContext.is_default_context ? "warning" : "success"}">${sellerContext.is_default_context ? "ברירת מחדל פנימית" : "מוכר פעיל"}</span>
      </div>
      <p class="small muted">כל עסקה חדשה תיווצר תחת <span class="mono">${esc(sellerContext.seller_id)}</span>. אזור המוכר מציג רק את העסקאות של הזהות הפעילה.</p>
      ${sellerContext.is_default_context ? `<p class="small muted">כדאי לשמור מזהה מוכר ברור כדי לא לעבוד תחת ברירת מחדל עמומה.</p>` : ""}
      <form data-action="seller-context" class="stack">
        <div class="inline-fields">
          <div class="field">
            <label for="sellerContextId">מזהה מוכר</label>
            <input id="sellerContextId" name="sellerContextId" type="text" data-dir="ltr" value="${esc(state.form.sellerContextId || sellerContext.seller_id)}" placeholder="seller-north" />
          </div>
          <div class="field">
            <label for="sellerContextName">שם מוכר לתצוגה</label>
            <input id="sellerContextName" name="sellerContextName" type="text" data-dir="rtl" value="${esc(state.form.sellerContextName || sellerContext.display_name)}" placeholder="סיטון צפון" />
          </div>
        </div>
        <div class="actions">
          <button class="secondary" type="submit">שמירת זהות מוכר פעילה</button>
        </div>
      </form>
    </section>
  `;
}

function getFlowStatus(flow) {
  if (!flow.otpSessionId) {
    return { title: "עדיין לא נשלח קוד אימות", message: "השלב הבא הוא שליחת קוד לטלפון של הקונה." };
  }
  if (flow.otpVerified) {
    return { title: "הטלפון כבר אומת", message: "אפשר לעבור ישירות לשלב אישור המסגרת." };
  }
  if (flow.otpExpiresAt && Date.now() > new Date(flow.otpExpiresAt).getTime()) {
    return { title: "קוד האימות פג", message: "צריך לבקש קוד חדש כדי להמשיך." };
  }
  return { title: "ממתין להזנת הקוד", message: "הקוד נשלח. מה שנשאר הוא להזין אותו ולהמשיך." };
}

function getDealCopy(stateName) {
  const item = DEAL_COPY[stateName];
  if (!item) {
    return { label: stateName, title: "מצב עסקה לא ממופה", description: "נמצא סטטוס עסקה שלא קיבל ניסוח ייעודי.", badgeTone: "warning" };
  }
  return { label: item[0], title: item[0], description: item[1], badgeTone: stateName === "PendingTarget" || stateName === "TargetReached" || stateName === "Completed" ? "success" : stateName === "Failed" || stateName === "Cancelled" ? "danger" : "warning" };
}

function getLabel(map, key) {
  return map[key] || [key, "נמצא מצב שלא קיבל ניסוח ייעודי."];
}

function nextDealAction(stateName, canJoin) {
  if (canJoin) {
    return {
      cta: "המשך לאימות ולהצטרפות",
      description: "המסלול ייקח אותך דרך אימות טלפון, אישור מסגרת ושמירת ההשתתפות."
    };
  }
  if (stateName === "Draft") return { cta: "ההצטרפות עדיין לא זמינה", description: "אפשר לשמור את הקישור ולחזור מאוחר יותר." };
  if (stateName === "Cancelled" || stateName === "Failed") return { cta: "העסקה כבר סגורה", description: "כאן כבר אי אפשר להצטרף. אם השתתפת, השתמש במסך המעקב." };
  return { cta: "ההצטרפות סגורה", description: "אין כרגע מסלול הצטרפות פעיל לעסקה הזו." };
}

function buildJourney(tracking) {
  const authorizationDone = ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargedSuccess", "ChargeFailedRecovery", "RecoveredCharge", "AuthReleased", "Refunded"].includes(tracking.money_state);
  const chargingDone = ["Charging", "CompletionWindow", "Completed", "Failed"].includes(tracking.deal_state) || ["ChargeAttempt", "ChargedSuccess", "RecoveredCharge"].includes(tracking.money_state);
  const finalDone = ["Completed", "Failed", "Cancelled"].includes(tracking.deal_state) || ["DealCompleted", "DealFailed", "Dropped", "Recovered"].includes(tracking.buyer_state);
  return [
    { title: "נרשמת לעסקה", done: true, current: tracking.buyer_state === "JoinedAuthorized" },
    { title: "יש אישור מסגרת", done: authorizationDone, current: tracking.money_state === "AuthHeld" || tracking.money_state === "AuthLocked" },
    { title: "העסקה התקדמה לחיוב", done: chargingDone, current: tracking.money_state === "ChargeAttempt" || tracking.buyer_state === "ChargingAttempt" },
    { title: "נסגרה תוצאה סופית", done: finalDone, current: !finalDone && tracking.deal_state === "CompletionWindow" }
  ];
}

function nextTrackingStep(tracking) {
  if (tracking.deal_state === "Completed") {
    return {
      title: "אין עוד פעולה נדרשת ממך",
      detail: "העסקה הושלמה והמסך נשאר כמסך מידע ומעקב בלבד.",
      summary: "העסקה הושלמה וההשתתפות שלך נסגרה בהצלחה."
    };
  }
  if (tracking.deal_state === "Failed" || tracking.deal_state === "Cancelled") {
    return {
      title: "המסלול הזה נסגר",
      detail: "העסקה לא הושלמה. המסך מציג את התוצאה הסופית של ההשתתפות והמשמעות הכספית שלה.",
      summary: "העסקה לא הושלמה ולכן אין שלב המשך למסלול הזה."
    };
  }
  if (tracking.money_state === "AuthHeld" && tracking.buyer_state === "JoinedAuthorized") {
    return {
      title: "כרגע ממתינים להתקדמות העסקה",
      detail: "נרשמת בהצלחה, בוצעה תפיסת מסגרת, ועכשיו ממתינים לשלב הבא בעסקה עצמה.",
      summary: "השתתפת בהצלחה. עדיין אין חיוב בפועל, ורק נשמר אישור המסגרת."
    };
  }
  if (tracking.money_state === "ChargeAttempt" || tracking.buyer_state === "ChargingAttempt") {
    return {
      title: "המערכת מנסה לחייב כרגע",
      detail: "זהו שלב תפעולי. אין צורך בפעולה מצד הקונה כרגע.",
      summary: "העסקה הגיעה לשלב החיוב והמערכת מנסה לבצע חיוב בפועל."
    };
  }
  if (tracking.buyer_state === "ChargeFailedCompletion" || tracking.money_state === "ChargeFailedRecovery") {
    return {
      title: "המערכת מנסה להשלים את ההשתתפות",
      detail: "כרגע אין צעד ידני נוסף במסך הזה. התוצאה תתעדכן לפי מסלול שחזור או סגירה.",
      summary: "נדרש מסלול השלמה בעקבות כשל חיוב, והמערכת עדיין מסיימת את הסגירה."
    };
  }
  return {
    title: "כדאי להמשיך לעקוב מהמסך הזה",
    detail: "המסך יציג את מצב העסקה וההשתתפות ככל שהבקאנד יתקדם בשלבים.",
    summary: "ההשתתפות שלך קיימת במערכת, והמסך הזה הוא מקור האמת שלה."
  };
}

function currency(value) {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function num(value) {
  return new Intl.NumberFormat("he-IL").format(Number(value || 0));
}

function dt(value) {
  return value ? new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "לא זמין";
}

function relativeTime(value) {
  if (!value) return "לא זמין";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return "ממש עכשיו";
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return `לפני ${days} ימים`;
}

function toDatetimeLocal(value) {
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fail(title, message) {
  state.error = { title, message };
  render();
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
