const root = document.getElementById("app");
const FLOW_KEY = "siton_flow_v2";
const FLOW_SCHEMA_VERSION = 2;
const SAFE_RESUME_KEY = "siton_safe_resume_v1";
const SAFE_RESUME_SCHEMA_VERSION = 1;
const SELLER_CONTEXT_KEY = "siton_seller_context_v1";
const FLOW_TTL_MS = 1000 * 60 * 60 * 6;
const SAFE_RESUME_TTL_MS = 1000 * 60 * 60 * 24;
const POLL_INTERVAL_MS = 12000;
const TRACKING_POLL_INTERVAL_MS = 6000;
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
  sellerProfile: null,
  dealPayload: null,
  dealChatPayload: null,
  dealChatStatus: "idle",
  trackingPayload: null,
  recoveryPayload: null,
  recoveryActionState: "idle",
  recoveryActionMessage: "",
  recoveryActionTone: "",
  sellerPayload: null,
  sellerAnalyticsPayload: null,
  sellerAnalyticsPeriod: "all",
  sellerAnalyticsLoading: false,
  sellerAnalyticsError: null,
  sellerDealPayload: null,
  sellerDeliveryHandoff: null,
  affiliatePayload: null,
  adminPayload: null,
  adminMissionPayload: null,
  adminLaunchPayload: null,
  adminSystemStatusPayload: null,
  adminNotificationsStatusPayload: null,
  adminInvoiceStatusPayload: null,
  adminSellerRiskPayload: null,
  adminSupportCasesPayload: null,
  adminDemoReadinessPayload: null,
  adminActionsPayload: null,
  adminSellerStatusModal: null,
  adminCaseCloseModal: null,
  adminSellerStatusReason: "",
  adminDealPayload: null,
  adminDealOpsPayload: null,
  adminParticipantOpsPayload: null,
  adminUserPayload: null,
  adminPollingPaused: false,
  adminSafeActionDraft: null,
  error: null,
  banner: null,
  sellerImageUploadStatus: "idle",
  sellerImageUploadError: "",
  sellerPreviewOpen: false,
  createDealFieldErrors: {},
  form: {
    adminQuery: "",
    adminCaseStatus: "",
    adminCaseType: "",
    adminCasePriority: "",
    affiliateDealId: "",
    affiliateLinkName: "",
    qty: "1",
    deliveryOptionId: "",
    phone: "",
    code: "",
    payerName: "",
    sellerTitle: "",
    sellerDescription: "",
    sellerImageDataUrl: "",
    sellerImageName: "",
    sellerImagesJson: "[]",
    sellerContextId: "",
    sellerContextName: "",
    sellerAccessCode: "",
    sellerPrice: "10",
    sellerMinUnits: "",
    sellerMaxUnits: "",
    sellerDeadline: "",
    sellerFulfillmentType: "delivery",
    sellerDeliveryType1: "pickup",
    sellerDeliveryLabel1: "",
    sellerDeliveryCost1: "0",
    sellerDeliveryPointName1: "",
    sellerDeliveryAddress1: "",
    sellerDeliveryCity1: "",
    sellerDeliveryInstructions1: "",
    sellerDeliveryLocationUrl1: "",
    sellerDeliveryType2: "delivery",
    sellerDeliveryLabel2: "",
    sellerDeliveryCost2: "0",
    sellerDeliveryPointName2: "",
    sellerDeliveryAddress2: "",
    sellerDeliveryCity2: "",
    sellerDeliveryInstructions2: "",
    sellerDeliveryLocationUrl2: "",
    sellerDeliveryType3: "distribution_point",
    sellerDeliveryLabel3: "",
    sellerDeliveryCost3: "0",
    sellerDeliveryPointName3: "",
    sellerDeliveryAddress3: "",
    sellerDeliveryCity3: "",
    sellerDeliveryInstructions3: "",
    sellerDeliveryLocationUrl3: "",
    sellerDeliveryType4: "distribution_point",
    sellerDeliveryLabel4: "",
    sellerDeliveryCost4: "0",
    sellerDeliveryPointName4: "",
    sellerDeliveryAddress4: "",
    sellerDeliveryCity4: "",
    sellerDeliveryInstructions4: "",
    sellerDeliveryLocationUrl4: "",
    sellerDeliveryType5: "distribution_point",
    sellerDeliveryLabel5: "",
    sellerDeliveryCost5: "0",
    sellerDeliveryPointName5: "",
    sellerDeliveryAddress5: "",
    sellerDeliveryCity5: "",
    sellerDeliveryInstructions5: "",
    sellerDeliveryLocationUrl5: "",
    sellerBizName: "",
    sellerContactName: "",
    sellerSupportPhone: "",
    sellerSupportEmail: "",
    sellerBizDesc: "",
    sellerBizId: "",
    sellerFinalTerms: "",
    sellerFinalConfirm: "",
    sellerPublishCriticalTermsAccepted: "",
    sellerPublishThresholdAccepted: "",
    chatDisplayName: "",
    chatBody: ""
  }
};

const REQUIRED_PAYMENT_NOTICE =
  "הסכום יתפוס מסגרת אשראי בלבד. לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה. אם העסקה לא נסגרת, המסגרת משתחררת אוטומטית.";
const REQUIRED_SUCCESS_HEADLINE = "\u05d4\u05e6\u05d8\u05e8\u05e4\u05ea \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4";
const REQUIRED_CHARGE_CONDITION =
  "\u05d4\u05d7\u05d9\u05d5\u05d1 \u05d9\u05ea\u05d1\u05e6\u05e2 \u05e8\u05e7 \u05d0\u05dd \u05d4\u05e2\u05e1\u05e7\u05d4 \u05ea\u05d9\u05e1\u05d2\u05e8 \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4";
const REQUIRED_RELEASE_NOTICE =
  "\u05d0\u05dd \u05d4\u05e2\u05e1\u05e7\u05d4 \u05dc\u05d0 \u05ea\u05d9\u05e1\u05d2\u05e8, \u05de\u05e1\u05d2\u05e8\u05ea \u05d4\u05d0\u05e9\u05e8\u05d0\u05d9 \u05ea\u05e9\u05ea\u05d7\u05e8\u05e8 \u05dc\u05dc\u05d0 \u05d7\u05d9\u05d5\u05d1";

const UX_REGRESSION_COPY = [
  "פותחים עסקה, מעלים דף אישי, ומפיצים לינק ישיר לקונים",
  "פתיחת עסקה חדשה",
  "ניהול העסקאות שלי",
  "עריכה מלאה רק בטיוטה",
  "אישור מסגרת בלבד",
  "גישה תפעולית",
  "C-ton Admin",
  "מרכז הפצה למדידה, ייחוס ושיתוף לינקים",
  "מרכז הפצה",
  "מזהה ישות",
  "מזהה משתתף",
  "סוג אירוע",
  "מזהה קורלציה",
  "זהות המוכר הפעילה",
  "שמירת זהות מוכר פעילה",
  "כל עסקה חדשה תיווצר תחת",
  "כניסה לעסקה",
  "רק דרך לינק ישיר",
  "סכום אישור המסגרת",
  "זה הסכום שיישמר כתפיסת מסגרת בשלב הזה",
  "הצטרפת בהצלחה",
  "הצטרפות",
  "נשמרה בהצלחה",
  "מסך המעקב הוא מקור האמת שלך",
  "תמונת מצב עדכנית",
  "תמונת שליטה",
  "העסקאות של המוכר הפעיל",
  "שומרים טיוטה ברורה",
  "מה יקרה אחרי שמירת הטיוטה",
  "מתקרת העסקה כבר נסגרה",
  "כאן רואים מי כבר נרשם",
  "אלה האפשרויות שיראו לקונה בדף הציבורי"
];

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
  seller: "ניהול העסקאות שלי",
  "seller-new": "יצירת עסקה חדשה",
  "seller-deal": "ניהול עסקה",
  affiliate: "מרכז הפצה",
  admin: "מרכז תפעול",
  "admin-support": "Support Hub",
  "admin-deal": "פרופיל עסקה לתפעול",
  "admin-participant": "פרופיל משתתף לתפעול",
  "admin-user": "פרופיל משתמש לתפעול",
  home: "האתר הראשי",
  deal: "דף עסקה",
  otp: "אימות טלפון",
  payment: "אישור מסגרת",
  confirmation: "אישור הצטרפות",
  tracking: "מעקב השתתפות",
  recovery: "השלמת תשלום",
  terms: "תנאי שימוש",
  privacy: "מדיניות פרטיות",
  refunds: "ביטולים והחזרים",
  accessibility: "הצהרת נגישות",
  "seller-terms": "תנאי מוכר",
  "distributor-terms": "תנאי מפיץ",
  contact: "יצירת קשר",
  "not-found": "עמוד לא נמצא"
};

const PAYMENT_READINESS = {
  settlementModel: "קודם מתבצעת תפיסת מסגרת, ורק אחרי סגירת העסקה בהצלחה יכול להתבצע חיוב בפועל",
  integrationNote: "מסלול ההצטרפות נשאר זהה: אישור מסגרת עכשיו, חיוב רק אם העסקה נסגרת בהצלחה."
};

const INTERNAL_SURFACE_ROUTES = new Set(["affiliate", "admin", "admin-support", "admin-deal", "admin-user"]);
const PUBLIC_TRUST_ROUTES = new Set(["home", "deal", "otp", "payment", "confirmation", "tracking", "recovery", "terms", "privacy", "refunds", "accessibility", "seller-terms", "distributor-terms", "contact"]);

const DEAL_TONE = {
  Draft: "warning",
  PendingTarget: "pending",
  TargetReached: "success",
  ClosedForJoining: "closed",
  ReadyForCharging: "warning",
  Charging: "charging",
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.sellerPreviewOpen) {
    state.sellerPreviewOpen = false;
    render();
  }
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
    if (action === "qty-step") adjustJoinQty(actionTarget.dataset.delta);
    if (action === "restart-flow") restartFlow();
    if (action === "reset-otp") resetOtp();
    if (action === "seller-clone") void cloneSellerDeal(actionTarget.dataset.dealId);
    if (action === "share-link") void shareLink(actionTarget.dataset.shareUrl, actionTarget.dataset.shareTitle);
    if (action === "copy-link") void copyLink(actionTarget.dataset.shareUrl);
    if (action === "copy-text") void copyText(actionTarget.dataset.copyText || "");
    if (action === "seller-preview-open") {
      state.sellerPreviewOpen = true;
      render();
      queueMicrotask(() => document.querySelector("[data-seller-preview-dialog]")?.focus());
      return;
    }
    if (action === "seller-preview-close") {
      state.sellerPreviewOpen = false;
      render();
      return;
    }
    if (action === "seller-excel-export") void downloadSellerDealExport(actionTarget.dataset.dealId);
    if (action === "download-delivery-handoff-excel") void downloadDeliveryHandoffExcel(actionTarget.dataset.dealId);
    if (action === "copy-delivery-address") void copyLink(actionTarget.dataset.address);
    if (action === "seller-analytics-period") void loadSellerAnalytics(actionTarget.dataset.period || "all");
    if (action === "seller-analytics-refresh") void loadSellerAnalytics(state.sellerAnalyticsPeriod || "all");
    if (action === "admin-refresh") void loadAdmin(state.form.adminQuery);
    if (action === "admin-polling-toggle") {
      state.adminPollingPaused = !state.adminPollingPaused;
      render();
      return;
    }
    if (action === "admin-safe-action-open") {
      state.adminSafeActionDraft = {
        action_type: actionTarget.dataset.actionType || "open_support_case",
        target_type: actionTarget.dataset.targetType || "system",
        target_id: actionTarget.dataset.targetId || "mission-control"
      };
      render();
      return;
    }
    if (action === "admin-safe-action-close") {
      state.adminSafeActionDraft = null;
      render();
      return;
    }
    if (action === "refresh-demo-readiness") { void loadDemoReadiness(); return; }
    if (action === "admin-seller-status-open") openSellerStatusModal(actionTarget);
    if (action === "admin-seller-status-close") closeSellerStatusModal();
    if (action === "admin-case-escalate") void escalateSupportCase(actionTarget.dataset.caseId);
    if (action === "admin-case-close-open") openCaseCloseModal(actionTarget);
    if (action === "admin-case-close-close") closeCaseCloseModal();
    if (action === "clear-product-image") clearSellerProductImage();
    if (action === "remove-product-image") removeSellerImage(actionTarget.dataset.imageIndex);
    if (action === "make-product-image-primary") makeSellerImagePrimary(actionTarget.dataset.imageIndex);
    if (action === "add-pickup-location") addSellerPickupLocation();
    if (action === "remove-pickup-location") removeSellerPickupLocation(actionTarget.dataset.slot);
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  if (target.name === "adminSellerStatusReason") {
    state.adminSellerStatusReason = target.value;
    const submit = document.querySelector("[data-admin-seller-status-submit]");
    if (submit instanceof HTMLButtonElement) submit.disabled = !target.value.trim();
    return;
  }
  if (target.name === "adminCaseCloseResolution") {
    const submit = document.querySelector("[data-admin-case-close-submit]");
    if (submit instanceof HTMLButtonElement) submit.disabled = !target.value.trim();
  }
  if (!(target.name in state.form)) return;
  state.form[target.name] = target.value;
  if (target.closest("[data-action='seller-create']")) {
    clearCreateDealErrorForField(target.name);
    updateSellerCreatePreviewFromState();
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target instanceof HTMLInputElement && target.name === "sellerImage") void handleSellerImageSelection(target);
  if (target.name in state.form && target.type === "checkbox") {
    state.form[target.name] = target.checked ? "on" : "";
  }
  if (target.name in state.form && target.type === "radio" && target.checked) {
    state.form[target.name] = target.value;
    render();
  }
  if (target.name === "sellerFulfillmentType" || /^sellerDeliveryType\d+$/.test(target.name)) {
    state.form[target.name] = target.value;
    render();
  }
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
  hydrateSellerContext();
  hydrateForm();
  render();
  await loadPreviewMeta();
  hydrateSellerContext();
  if (!usesDemoSellerContext()) {
    await loadSellerSession();
  }
  hydrateForm();
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
  if (normalized === "/" || normalized === "/app") return { name: "home" };
  const patterns = [
    ["deal", /^\/app\/deal\/([^/]+)$/],
    ["otp", /^\/app\/join\/([^/]+)\/otp$/],
    ["payment", /^\/app\/join\/([^/]+)\/payment$/],
    ["confirmation", /^\/app\/join\/([^/]+)\/confirmation$/],
    ["tracking", /^\/app\/track\/([^/]+)$/],
    ["recovery", /^\/app\/recovery\/([^/]+)$/],
    ["terms", /^\/app\/terms$/],
    ["privacy", /^\/app\/privacy$/],
    ["refunds", /^\/app\/refunds$/],
    ["accessibility", /^\/app\/accessibility$/],
    ["seller-terms", /^\/app\/seller-terms$/],
    ["distributor-terms", /^\/app\/distributor-terms$/],
    ["contact", /^\/app\/contact$/],
    ["seller", /^\/app\/seller$/],
    ["seller-new", /^\/app\/seller\/new$/],
    ["seller-deal", /^\/app\/seller\/deals\/([^/]+)$/],
    ["affiliate", /^\/app\/affiliate$/],
    ["admin", /^\/app\/admin$/],
    ["admin-support", /^\/app\/admin\/support$/],
    ["admin-deal", /^\/app\/admin\/deals\/([^/]+)$/],
    ["admin-participant", /^\/app\/admin\/participants\/([^/]+)$/],
    ["admin-user", /^\/app\/admin\/users\/([^/]+)$/]
  ];

  for (const [name, regex] of patterns) {
    const match = normalized.match(regex);
    if (!match) continue;
    if (name === "seller" || name === "seller-new" || name === "affiliate" || name === "admin" || name === "admin-support" || name === "terms" || name === "privacy" || name === "refunds" || name === "accessibility" || name === "seller-terms" || name === "distributor-terms" || name === "contact") {
      return { name };
    }
    return name === "tracking" || name === "recovery"
      ? { name, participantId: decodeURIComponent(match[1]) }
      : name === "admin-participant"
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
  if (route.name === "recovery") return loadRecovery(route.participantId);
  if (route.name === "seller") return loadSeller();
  if (route.name === "seller-new") return prepareSellerNew();
  if (route.name === "seller-deal") return loadSellerDeal(route.dealId);
  if (route.name === "affiliate") return loadAffiliate();
  if (route.name === "admin") return loadAdmin(state.form.adminQuery);
  if (route.name === "admin-support") return loadAdminSupportCases();
  if (route.name === "admin-deal") return loadAdminDeal(route.dealId);
  if (route.name === "admin-participant") return loadAdminParticipant(route.participantId);
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
    await loadDealChat(dealId, false);
    state.form.qty = String(getFlow(dealId)?.qty || 1);
    void recordAffiliateVisit(dealId);
  }, "לא הצלחנו לטעון את העסקה.");
}

async function loadDealChat(dealId, shouldRender = true) {
  state.dealChatStatus = "loading";
  try {
    state.dealChatPayload = await api(`/api/deals/${encodeURIComponent(dealId)}/chat`);
    state.dealChatStatus = "ready";
  } catch (err) {
    state.dealChatPayload = { ok: false, messages: [], generated_at: new Date().toISOString() };
    state.dealChatStatus = Number(err?.status || 0) === 403 ? "closed" : "error";
  }
  if (shouldRender) render();
}

async function loadTracking(participantId) {
  await busy("טוען את סטטוס ההשתתפות...", async () => {
    state.trackingPayload = await api(trackingApiUrl(participantId));
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

async function loadRecovery(participantId) {
  await busy("טוען את מסך השלמת התשלום...", async () => {
    state.recoveryPayload = await api(trackingApiUrl(participantId));
  }, "לא הצלחנו לטעון את מסך השלמת התשלום.");
}

async function refreshRecoverySilently(participantId) {
  try {
    state.recoveryPayload = await api(trackingApiUrl(participantId));
    render();
  } catch {}
}

async function submitRecoveryRequest(participantId) {
  if (!participantId) return;
  state.recoveryActionState = "submitting";
  state.recoveryActionMessage = "";
  state.recoveryActionTone = "";
  render();
  try {
    const idemKey = `recovery:${participantId}:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const trackingToken = currentTrackingToken(participantId);
    const response = await api(`/api/participants/${encodeURIComponent(participantId)}/recovery`, {
      method: "POST",
      headers: {
        "x-request-id": idemKey,
        "idempotency-key": idemKey,
        ...(trackingToken ? { authorization: `Bearer ${trackingToken}` } : {})
      },
      body: json({})
    });
    state.recoveryActionState = "succeeded";
    state.recoveryActionTone = "tone-success";
    state.recoveryActionMessage = String(response?.message || "ניסיון השלמת התשלום נכנס לתור.");
    state.banner = {
      tone: "success",
      title: response?.status === "already_recovered" ? "התשלום כבר הושלם" : "ניסיון ההשלמה נשלח",
      message: state.recoveryActionMessage
    };
    await refreshRecoverySilently(participantId);
  } catch (err) {
    state.recoveryActionState = "failed";
    state.recoveryActionTone = "tone-warning";
    const status = Number(err?.status || 0);
    if (status === 409) {
      state.recoveryActionMessage = "לא ניתן להשלים את התשלום במצב הזה. אם חלון ההשלמה הסתיים או שהמצב כבר השתנה, מסך המעקב יציג את התמונה העדכנית.";
    } else if (status === 400) {
      state.recoveryActionMessage = "הבקשה לא תקינה. אפשר לחזור למסך המעקב ולנסות שוב.";
    } else {
      state.recoveryActionMessage = "לא הצלחנו להשלים את התשלום. אפשר לנסות שוב כל עוד חלון ההשלמה פתוח.";
    }
    state.banner = {
      tone: "warning",
      title: "ניסיון ההשלמה נכשל",
      message: state.recoveryActionMessage
    };
  } finally {
    render();
  }
}

async function loadHome() {
  await busy("טוען את האתר הראשי של C-ton...", async () => {
    state.homePayload = await api("/api/site/home");
    state.sellerAuth = state.homePayload?.site?.seller_auth || state.sellerAuth;
    syncSellerContext(state.homePayload?.site?.seller_context || null);
  }, "לא הצלחנו לטעון את האתר הראשי של C-ton.");
}

async function loadSeller() {
  await busy('טוען את ניהול העסקאות...', async () => {
    state.sellerPayload = await api('/api/seller/deals');
    state.sellerAuth = state.sellerPayload?.seller_surface?.seller_auth || state.sellerAuth;
    syncSellerContext(state.sellerPayload?.seller_surface?.seller_profile || null);
    try {
      const profileRes = await api('/api/seller/profile');
      if (profileRes?.ok) {
        state.sellerProfile = profileRes.profile;
        const p = profileRes.profile;
        state.form.sellerBizName = p.business_name || '';
        state.form.sellerContactName = p.contact_name || '';
        state.form.sellerSupportPhone = p.support_phone || '';
        state.form.sellerSupportEmail = p.support_email || '';
        state.form.sellerBizDesc = p.business_description || '';
        state.form.sellerBizId = p.business_identifier || '';
      }
    } catch (_) { /* profile fetch failure is non-fatal */ }
    await loadSellerAnalytics(state.sellerAnalyticsPeriod || "all", false);
  }, 'לא הצלחנו לטעון את ניהול העסקאות.');
}

async function loadSellerAnalytics(period = "all", shouldRender = true) {
  const allowed = new Set(["all", "30d", "90d", "year"]);
  const normalizedPeriod = allowed.has(period) ? period : "all";
  state.sellerAnalyticsPeriod = normalizedPeriod;
  state.sellerAnalyticsLoading = true;
  state.sellerAnalyticsError = null;
  if (shouldRender) render();
  try {
    state.sellerAnalyticsPayload = await api(`/api/seller/analytics?period=${encodeURIComponent(normalizedPeriod)}`);
  } catch (err) {
    state.sellerAnalyticsPayload = null;
    state.sellerAnalyticsError = err;
  } finally {
    state.sellerAnalyticsLoading = false;
    if (shouldRender) render();
  }
}

async function saveSellerProfile(form) {
  const bizName = String(form.sellerBizName?.value || state.form.sellerBizName || "").trim();
  if (!bizName) {
    state.banner = { tone: "warning", title: "שדה חסר", message: "יש להזין שם עסק לפני שמירה." };
    render(); return;
  }
  await busy("שומר פרטי מוכר...", async () => {
    const res = await api("/api/seller/profile", {
      method: "PUT",
      body: JSON.stringify({
        business_name: bizName,
        contact_name: String(form.sellerContactName?.value || state.form.sellerContactName || "").trim() || undefined,
        support_phone: String(form.sellerSupportPhone?.value || state.form.sellerSupportPhone || "").trim() || undefined,
        support_email: String(form.sellerSupportEmail?.value || state.form.sellerSupportEmail || "").trim() || undefined,
        business_description: String(form.sellerBizDesc?.value || state.form.sellerBizDesc || "").trim() || undefined,
        business_identifier: String(form.sellerBizId?.value || state.form.sellerBizId || "").trim() || undefined
      })
    });
    if (res?.ok) {
      state.sellerProfile = res.profile;
      const p = res.profile;
      state.form.sellerBizName = p.business_name || "";
      state.form.sellerContactName = p.contact_name || "";
      state.form.sellerSupportPhone = p.support_phone || "";
      state.form.sellerSupportEmail = p.support_email || "";
      state.form.sellerBizDesc = p.business_description || "";
      state.form.sellerBizId = p.business_identifier || "";
      state.banner = { tone: "success", title: "נשמר", message: "פרטי המוכר עודכנו בהצלחה." };
    }
  }, "לא הצלחנו לשמור את פרטי המוכר.");
}

async function sendDealChatMessage(form) {
  const dealId = state.dealPayload?.deal?.deal_id || state.route.dealId;
  if (!dealId) return;
  const formData = new FormData(form);
  const displayName = String(formData.get("chatDisplayName") || state.form.chatDisplayName || "").trim();
  const body = String(formData.get("chatBody") || state.form.chatBody || "").trim();
  if (!body) return fail("אי אפשר לשלוח הודעה ריקה", "כתבו שאלה או עדכון קצר לפני השליחה.");
  if (body.length > 500) return fail("ההודעה ארוכה מדי", "אפשר לשלוח עד 500 תווים בהודעה אחת.");

  await busy("שולח הודעה...", async () => {
    await api(`/api/deals/${encodeURIComponent(dealId)}/chat`, {
      method: "POST",
      body: json({
        display_name: displayName || "משתתף",
        body
      })
    });
    state.form.chatDisplayName = displayName || "משתתף";
    state.form.chatBody = "";
    await loadDealChat(dealId, false);
    state.banner = { tone: "success", title: "ההודעה נשלחה", message: "השיחה עודכנה בלי לרענן את דף העסקה." };
  }, "לא הצלחנו לשלוח את ההודעה.");
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
    if (state.sellerDealPayload?.deal?.state === "Completed") {
      try {
        state.sellerDeliveryHandoff = await api(`/api/seller/deals/${encodeURIComponent(dealId)}/delivery-handoff`);
      } catch { state.sellerDeliveryHandoff = null; }
    } else {
      state.sellerDeliveryHandoff = null;
    }
  }, "לא הצלחנו לטעון את מסך ניהול העסקה.");
}

async function loadAffiliate() {
  await busy("טוען את מסך השותפים הפנימי...", async () => {
    state.affiliatePayload = await api("/api/affiliate/overview");
    const campaigns = state.affiliatePayload?.affiliate_surface?.campaigns || [];
    if (!state.form.affiliateDealId && campaigns.length) {
      const firstShareable = campaigns.find((campaign) => ["PendingTarget", "TargetReached"].includes(campaign.state));
      state.form.affiliateDealId = firstShareable?.deal_id || "";
    }
  }, "לא הצלחנו לטעון את מסך השותפים הפנימי.");
}

async function createAffiliateLink(form) {
  const formData = new FormData(form);
  const dealId = String(formData.get("affiliateDealId") || state.form.affiliateDealId || "").trim();
  const internalName = String(formData.get("affiliateLinkName") || state.form.affiliateLinkName || "").trim();
  if (!dealId) return fail("לא נבחרה עסקה", "יש לבחור עסקה פתוחה להפצה.");
  if (!internalName) return fail("חסר שם פנימי", "יש לתת ללינק שם שיעזור לזהות את ערוץ ההפצה.");
  await busy("יוצר לינק ייחודי...", async () => {
    const response = await api("/api/affiliate/links", {
      method: "POST",
      body: json({ deal_id: dealId, internal_name: internalName })
    });
    state.form.affiliateLinkName = "";
    state.banner = {
      tone: "success",
      title: "לינק ההפצה נוצר",
      message: "הלינק הייחודי מוכן להעתקה, שיתוף ומדידת ביצועים."
    };
    await loadAffiliate();
    if (response?.link?.share_link) await copyLink(response.link.share_link);
  }, "לא הצלחנו ליצור את לינק ההפצה.");
}

async function recordAffiliateVisit(dealId) {
  const sourceCode = currentAffiliateRef();
  if (!sourceCode) return;
  const entryKey = `siton_affiliate_entry:${dealId}:${sourceCode}`;
  let entryId = "";
  try {
    entryId = sessionStorage.getItem(entryKey) || "";
    if (!entryId) {
      entryId = globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(entryKey, entryId);
    }
  } catch {
    entryId = `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const clickId = globalThis.crypto?.randomUUID?.() || `click-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await api("/api/affiliate/links/visit", {
      method: "POST",
      body: json({ deal_id: dealId, source_code: sourceCode, click_id: clickId, entry_id: entryId })
    });
  } catch {
    // Measurement is deliberately non-blocking and must never interrupt a buyer.
  }
}

async function loadAdmin(query = "") {
  await busy("טוען את מרכז התפעול...", async () => {
    const [overview, missionControl, launchConsole, systemStatus, notificationsStatus, invoiceStatus, sellerRisk, supportCases, adminActions, demoReadiness] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(query || "")}`),
      api(`/api/admin/mission-control?q=${encodeURIComponent(query || "")}`),
      api("/api/admin/launch-console"),
      api("/api/admin/system-status"),
      api("/api/admin/notifications-status"),
      api("/api/admin/invoice-status"),
      api("/api/admin/sellers/risk"),
      api("/api/admin/support-cases"),
      api("/api/admin/actions"),
      api("/api/admin/demo-readiness").catch(() => null)
    ]);
    state.adminPayload = overview;
    state.adminMissionPayload = missionControl;
    state.adminLaunchPayload = launchConsole;
    state.adminSystemStatusPayload = systemStatus;
    state.adminNotificationsStatusPayload = notificationsStatus;
    state.adminInvoiceStatusPayload = invoiceStatus;
    state.adminSellerRiskPayload = sellerRisk;
    state.adminSupportCasesPayload = supportCases;
    state.adminActionsPayload = adminActions;
    state.adminDemoReadinessPayload = demoReadiness;
  }, "לא הצלחנו לטעון את מרכז התפעול.");
}

async function loadAdminSupportCases() {
  const params = new URLSearchParams();
  if (state.form.adminCaseStatus) params.set("status", state.form.adminCaseStatus);
  if (state.form.adminCaseType) params.set("case_type", state.form.adminCaseType);
  if (state.form.adminCasePriority) params.set("priority", state.form.adminCasePriority);
  await busy("טוען את Support Hub...", async () => {
    state.adminSupportCasesPayload = await api(`/api/admin/support-cases${params.toString() ? `?${params.toString()}` : ""}`);
  }, "לא הצלחנו לטעון את תיקי התפעול.");
}

async function loadDemoReadiness() {
  await busy("בודק מוכנות דמו...", async () => {
    state.adminDemoReadinessPayload = await api("/api/admin/demo-readiness").catch(() => null);
  }, "לא הצלחנו לבדוק מוכנות דמו.");
}


async function loadAdminDeal(dealId) {
  await busy("טוען את פרופיל העסקה הפנימי...", async () => {
    const [profile, opsSummary] = await Promise.all([
      api(`/api/admin/deals/${encodeURIComponent(dealId)}/profile`),
      api(`/api/admin/deals/${encodeURIComponent(dealId)}/ops-summary`)
    ]);
    state.adminDealPayload = profile;
    state.adminDealOpsPayload = opsSummary;
  }, "לא הצלחנו לטעון את פרופיל העסקה הפנימי.");
}

async function loadAdminParticipant(participantId) {
  await busy("טוען את פרופיל המשתתף לתפעול...", async () => {
    state.adminParticipantOpsPayload = await api(`/api/admin/participants/${encodeURIComponent(participantId)}/ops`);
  }, "לא הצלחנו לטעון את פרופיל המשתתף לתפעול.");
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

  const intervalMs = String(pollKey || "").startsWith("tracking:")
    ? TRACKING_POLL_INTERVAL_MS
    : POLL_INTERVAL_MS;
  routePollTimer = setInterval(() => {
    void runRouteSilently();
  }, intervalMs);
}

function currentPollKey() {
  const route = state.route;
  if (route.name === "home") return "";
  if (route.name === "deal") return `deal:${route.dealId}`;
  if (route.name === "tracking") return `tracking:${route.participantId}`;
  if (route.name === "recovery") return `recovery:${route.participantId}`;
  if (route.name === "seller") return "seller";
  if (route.name === "seller-new") return "";
  if (route.name === "seller-deal") return `seller-deal:${route.dealId}:${currentSellerContext().seller_id}`;
  if (route.name === "admin") return "admin";
  if (route.name === "admin-support") return "admin-support";
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
  if (route.name === "recovery") {
    await refreshRecoverySilently(route.participantId);
    return;
  }
  if (route.name === "seller") {
    await refreshSellerSilently();
    return;
  }
  if (route.name === "admin") {
    if (state.adminPollingPaused) return;
    await refreshAdminSilently();
    return;
  }
  if (route.name === "admin-support") {
    await loadAdminSupportCases();
  }
}

async function refreshDealSilently(dealId) {
  try {
    const next = await api(`/api/deals/${encodeURIComponent(dealId)}/public`);
    const previous = state.dealPayload;
    state.dealPayload = next;
    await loadDealChat(dealId, false);
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
    const next = await api(trackingApiUrl(participantId));
    const previous = state.trackingPayload;
    state.trackingPayload = next;
    if (!previous) {
      render();
      return;
    }

    const stateChanged =
      previous.tracking.deal_state !== next.tracking.deal_state ||
      previous.tracking.buyer_state !== next.tracking.buyer_state ||
      previous.tracking.money_state !== next.tracking.money_state;
    const liveChanged =
      previous.tracking.live?.version !== next.tracking.live?.version ||
      previous.tracking.progress?.current_units !== next.tracking.progress?.current_units ||
      previous.tracking.activity_feed?.[0]?.at !== next.tracking.activity_feed?.[0]?.at;

    if (stateChanged) {
      state.banner = {
        tone: "success",
        title: "סטטוס ההשתתפות עודכן",
        message: "המסך רענן את מצב העסקה וההשתתפות בלי לאבד את רצף החוויה."
      };
      render();
      return;
    }
    if (liveChanged) {
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
    const [next, missionControl, launchConsole, systemStatus, notificationsStatus, invoiceStatus, sellerRisk, supportCases, adminActions] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(state.form.adminQuery || "")}`),
      api(`/api/admin/mission-control?q=${encodeURIComponent(state.form.adminQuery || "")}`),
      api("/api/admin/launch-console"),
      api("/api/admin/system-status"),
      api("/api/admin/notifications-status"),
      api("/api/admin/invoice-status"),
      api("/api/admin/sellers/risk"),
      api("/api/admin/support-cases"),
      api("/api/admin/actions")
    ]);
    const totalsChanged = !state.adminPayload || JSON.stringify(state.adminPayload.admin_surface.totals) !== JSON.stringify(next.admin_surface.totals);
    const systemChanged =
      !state.adminSystemStatusPayload ||
      JSON.stringify(state.adminSystemStatusPayload.system_status.operational_counts) !== JSON.stringify(systemStatus.system_status.operational_counts);
    const notificationsChanged =
      !state.adminNotificationsStatusPayload ||
      JSON.stringify(state.adminNotificationsStatusPayload.notifications) !== JSON.stringify(notificationsStatus.notifications);
    const invoiceChanged =
      !state.adminInvoiceStatusPayload ||
      JSON.stringify(state.adminInvoiceStatusPayload.invoice_documents) !== JSON.stringify(invoiceStatus.invoice_documents);
    const launchChanged =
      !state.adminLaunchPayload ||
      JSON.stringify(state.adminLaunchPayload.launch_readiness) !== JSON.stringify(launchConsole.launch_readiness) ||
      JSON.stringify(state.adminLaunchPayload.system) !== JSON.stringify(launchConsole.system);
    const missionChanged =
      !state.adminMissionPayload ||
      JSON.stringify(state.adminMissionPayload.exception_cards) !== JSON.stringify(missionControl.exception_cards) ||
      JSON.stringify(state.adminMissionPayload.system) !== JSON.stringify(missionControl.system);
    const sellerRiskChanged =
      !state.adminSellerRiskPayload ||
      JSON.stringify(state.adminSellerRiskPayload.sellers) !== JSON.stringify(sellerRisk.sellers);
    const supportCasesChanged =
      !state.adminSupportCasesPayload ||
      JSON.stringify(state.adminSupportCasesPayload.summary) !== JSON.stringify(supportCases.summary);
    const actionsChanged =
      !state.adminActionsPayload ||
      JSON.stringify(state.adminActionsPayload.actions) !== JSON.stringify(adminActions.actions);
    if (totalsChanged || launchChanged || missionChanged || systemChanged || notificationsChanged || invoiceChanged || sellerRiskChanged || supportCasesChanged || actionsChanged) {
      state.adminPayload = next;
      state.adminMissionPayload = missionControl;
      state.adminLaunchPayload = launchConsole;
      state.adminSystemStatusPayload = systemStatus;
      state.adminNotificationsStatusPayload = notificationsStatus;
      state.adminInvoiceStatusPayload = invoiceStatus;
      state.adminSellerRiskPayload = sellerRisk;
      state.adminSupportCasesPayload = supportCases;
      state.adminActionsPayload = adminActions;
      render();
    }
  } catch {}
}

async function createAdminSafeAction(form) {
  const data = new FormData(form);
  const actionType = String(data.get("action_type") || "").trim();
  const targetType = String(data.get("target_type") || "").trim();
  const targetId = String(data.get("target_id") || "").trim();
  const reason = String(data.get("reason") || "").trim();
  const confirmed = data.get("safe_action_confirm") === "on";
  if (!reason) return fail("חסרה סיבה", "כל Safe Action דורשת reason ברור.");
  if (!confirmed) return fail("נדרש אישור הבנה", "צריך לאשר שהפעולה אינה משנה state ידנית ואינה עוקפת את החוקה.");
  await busy("יוצר Safe Action...", async () => {
    const payload = {
      action_type: actionType,
      target_type: targetType,
      target_id: targetId,
      reason,
      idempotency_key: `admin-ui:${actionType}:${targetType}:${targetId}:${Date.now()}`
    };
    await api("/api/admin/actions", { method: "POST", body: json(payload) });
    state.adminActionsPayload = await api("/api/admin/actions");
    state.adminSafeActionDraft = null;
    state.banner = { tone: "success", title: "Safe Action נרשמה", message: "הפעולה נרשמה בצורה מבוקרת ותופיע בהיסטוריית Admin Actions." };
  }, "לא הצלחנו ליצור Safe Action.");
}

async function submitAction(action, form) {
  if (action === "start-join") return startJoin();
  if (action === "otp-start") return otpStart(form);
  if (action === "otp-verify") return otpVerify(form);
  if (action === "pay") return payAndJoin(form);
  if (action === "deal-chat-send") return sendDealChatMessage(form);
  if (action === "seller-create") return createDeal(form);
  if (action === "seller-context") return saveSellerContextFromForm(form);
  if (action === "seller-login") return loginSellerFromForm(form);
  if (action === "seller-logout") return logoutSeller();
  if (action === "seller-publish") return publishDeal(form.dataset.dealId, form);
  if (action === "seller-profile-save") return saveSellerProfile(form);
  if (action === "affiliate-link-create") return createAffiliateLink(form);
  if (action === "recovery-submit") return submitRecoveryRequest(form.dataset.participantId || state.route.participantId);
  if (action === "admin-search") return loadAdmin(state.form.adminQuery);
  if (action === "admin-kyc-decision") return decideKyc(form);
  if (action === "admin-seller-status") return changeSellerStatus(form);
  if (action === "admin-case-filter") return loadAdminSupportCases();
  if (action === "admin-case-create") return createSupportCase(form);
  if (action === "admin-case-update") return updateSupportCase(form);
  if (action === "admin-case-close") return closeSupportCase(form);
  if (action === "admin-support-create") return createSupportTicket(form);
  if (action === "admin-support-update") return updateSupportTicket(form);
  if (action === "admin-safe-action-create") return createAdminSafeAction(form);
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
      otpToken: response.otp_token || "",
      otpVerified: true,
      otpChallengeId: response.challenge_id || response.otp_session_id || "",
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
  if (formData.get("buyerPaymentDisclosureAcceptance") !== "on") {
    return fail(
      "נדרש אישור תנאים",
      "כדי להמשיך לתפיסת מסגרת צריך לאשר את תנאי העסקה, התקנון, מדיניות הביטולים ומדיניות הפרטיות."
    );
  }
  const buyerName = String(formData.get("buyerName") || "").trim();
  const deliveryAddress = String(formData.get("deliveryAddress") || "").trim();
  const deliveryCity = String(formData.get("deliveryCity") || "").trim();
  const deliveryNote = String(formData.get("deliveryNote") || "").trim();
  if (flow.deliveryMethodType === "shipping" && !deliveryAddress) {
    return fail("חסרה כתובת משלוח", "בחרת משלוח — נא למלא רחוב ומספר.");
  }
  if (flow.deliveryMethodType === "shipping" && !deliveryCity) {
    return fail("חסרה עיר", "בחרת משלוח — נא למלא עיר.");
  }
  if (deliveryNote.length > 200) {
    return fail("הערה ארוכה מדי", "הערת המשלוח לא יכולה לעלות על 200 תווים.");
  }
  const hostedPaymentMethodId = String(formData.get("providerPaymentMethodId") || "").trim();
  const payload = {
    payer_name: String(formData.get("payerName") || "").trim(),
    payment_method_id: hostedPaymentMethodId || paymentService.createHostedPaymentMethodId(route.dealId, flow.buyerId),
    amount_minor: Math.round(Number(flow.estimatedTotal || 0) * 100),
    currency: "ILS",
    buyer_id: flow.buyerId,
    deal_id: route.dealId,
    qty: flow.qty,
    delivery_option_id: flow.deliveryOptionId || undefined,
    otp_token: flow.otpToken || undefined,
    otp_challenge_id: flow.otpChallengeId || undefined
  };
  const issue = validatePayment(payload);
  if (issue) return fail("חסר אישור מסגרת", issue);

  await busy("מאשר את המסגרת ושומר את ההצטרפות...", async () => {
    const authorization = await paymentService.authorize(payload);
    const join = await buyerFlowService.joinDeal(route.dealId, {
      buyerId: flow.buyerId,
      qty: flow.qty,
      affiliateRef: flow.affiliateRef || "",
      deliveryOptionId: flow.deliveryOptionId || "",
      buyerName: buyerName || undefined,
      deliveryAddress: deliveryAddress || undefined,
      deliveryCity: deliveryCity || undefined,
      deliveryNote: deliveryNote || undefined,
      otpToken: flow.otpToken || undefined,
      otpChallengeId: flow.otpChallengeId || undefined,
      authorizationId: authorization.authorization_id,
      authorizationProvider: authorization.provider,
      authorizationCorrelationId: authorization.correlation_id,
      paymentDisclosureAccepted: true
    });
    saveFlow(route.dealId, {
      paymentAuthorized: true,
      paymentAuthorizedAt: new Date().toISOString(),
      authorizationId: authorization.authorization_id,
      authorizationMessage: authorization.hold_message || "",
      participantId: join.participant_id,
      trackingAccessToken: join.tracking_access_token || "",
      trackingUrl: join.tracking_url || "",
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
  rememberSellerCreateForm(formData);
  const title = readCreateDealTitle(formData);
  const description = String(formData.get("sellerDescription") || "").trim();
  const price = Number(formData.get("sellerPrice") || 0);
  const minUnitsRaw = String(formData.get("sellerMinUnits") || "").trim();
  const maxUnitsRaw = String(formData.get("sellerMaxUnits") || "").trim();
  const minUnits = Number(minUnitsRaw);
  const maxUnits = Number(maxUnitsRaw);
  const deadline = String(formData.get("sellerDeadline") || "").trim();
  const finalTerms = formData.get("sellerFinalTerms") === "on";
  const finalConfirm = formData.get("sellerFinalConfirm") === "on";
  const deliveryResult = collectSellerDeliveryOptions(formData);
  const validationErrors = [];
  const fieldErrors = {};
  if (!title) {
    fieldErrors.sellerTitle = "חסר שם לעסקה. אנא הזן שם קצר וברור לעסקה.";
    validationErrors.push("שם העסקה");
  }
  if (!Number.isFinite(price) || price <= 0) {
    fieldErrors.sellerPrice = "יש להזין מחיר חיובי ליחידה.";
    validationErrors.push("מחיר");
  }
  if (!minUnitsRaw) {
    fieldErrors.sellerMinUnits = "יש להזין מינימום יחידות.";
    validationErrors.push("כמות מינימום");
  } else if (!Number.isInteger(minUnits) || minUnits < 1) {
    fieldErrors.sellerMinUnits = "המינימום חייב להיות 1 ומעלה.";
    validationErrors.push("כמות מינימום תקינה");
  }
  if (!maxUnitsRaw) {
    fieldErrors.sellerMaxUnits = "יש להזין מקסימום יחידות.";
    validationErrors.push("כמות מקסימום");
  } else if (!Number.isInteger(maxUnits) || maxUnits < 1 || (Number.isInteger(minUnits) && minUnits >= 1 && maxUnits < minUnits)) {
    fieldErrors.sellerMaxUnits = "המקסימום חייב להיות לפחות המינימום.";
    validationErrors.push("כמות מקסימום תקינה");
  }
  if (!deadline) {
    fieldErrors.sellerDeadline = "יש לבחור מועד סגירת הצטרפות.";
    validationErrors.push("דדליין");
  } else {
    const deadlineMs = new Date(deadline).getTime();
    if (!Number.isFinite(deadlineMs)) {
      fieldErrors.sellerDeadline = "יש לבחור תאריך ושעה תקינים.";
      validationErrors.push("דדליין תקין");
    }
    if (Number.isFinite(deadlineMs) && deadlineMs - Date.now() < 2 * 60 * 60 * 1000) {
      fieldErrors.sellerDeadline = "חלון ההצטרפות חייב להיות לפחות שעתיים קדימה.";
      validationErrors.push("דדליין של לפחות שעתיים קדימה");
    }
    if (Number.isFinite(deadlineMs) && deadlineMs - Date.now() > 7 * 24 * 60 * 60 * 1000) {
      fieldErrors.sellerDeadline = "בדמו אפשר לפתוח עסקה עד 7 ימים קדימה.";
      validationErrors.push("דדליין עד 7 ימים קדימה");
    }
  }
  Object.assign(fieldErrors, deliveryResult.fieldErrors || {});
  validationErrors.push(...deliveryResult.errors);
  if (!deliveryResult.options.length) validationErrors.push("אופן קבלה");
  if (!finalTerms) validationErrors.push("אישור תקנון ותנאי שימוש");
  if (!finalConfirm) validationErrors.push("אישור שהתנאים הקריטיים סופיים");
  if (validationErrors.length) {
    state.createDealFieldErrors = fieldErrors;
    return failValidation(
      "לא ניתן ליצור את העסקה עדיין.",
      ["חסרים הפרטים הבאים:", ...validationErrors]
    );
  }
  state.createDealFieldErrors = {};
  const deliveryOptions = deliveryResult.options;
  const sellerImages = readSellerImages();

  await busy("יוצר טיוטת עסקה...", async () => {
    const sellerContext = currentSellerContext();
    const response = await api("/deals", {
      method: "POST",
      headers: {
        "x-request-id": `seller:${Date.now()}`,
        "idempotency-key": `seller-create:${Date.now()}`
      },
      body: json(buildCreateDealPayload({
        title,
        description,
        price,
        minUnits,
        maxUnits,
        deadline,
        sellerContext,
        deliveryOptions
      }))
    });
    if (sellerImages.length) {
      try {
        for (const [index, image] of sellerImages.entries()) {
          await uploadSellerDealImage(response.deal_id, { ...image, sortOrder: index });
        }
      } catch (error) {
        const err = new Error(`שמירת הטיוטה הצליחה, אבל שמירת התמונות נכשלה (${friendlyApiCode(error)}). נסו להעלות JPG, PNG או WebP עד 2MB ולשמור שוב.`);
        err.statusCode = error?.statusCode || error?.status || 400;
        err.code = "draft_images_not_persisted";
        throw err;
      }
      const persisted = await api(`/api/seller/deals/${encodeURIComponent(response.deal_id)}`);
      const persistedImages = Array.isArray(persisted?.deal?.images) ? persisted.deal.images : [];
      if (persistedImages.length < sellerImages.length) {
        const err = new Error("שמירת הטיוטה הצליחה, אבל לא כל התמונות נשמרו. נסו לשמור שוב לפני פרסום.");
        err.statusCode = 409;
        err.code = "draft_images_not_persisted";
        throw err;
      }
      state.sellerDealPayload = persisted;
    }
    state.banner = {
      tone: "success",
      title: "הטיוטה נשמרה",
      message: "טיוטת העסקה נשמרה. עכשיו אפשר לעבור עליה, לפרסם את הדף הציבורי, ואז להפיץ את הלינק הישיר."
    };
    navigate(`/app/seller/deals/${encodeURIComponent(response.deal_id)}`);
  }, "יצירת העסקה נכשלה.");
  if (state.error) {
    const code = friendlyApiCode(state.error);
    if (code === "title_required" || /title is required/i.test(String(state.error.message || ""))) {
      state.error = {
        title: "חסר שם לעסקה.",
        message: "אנא הזן שם קצר וברור לעסקה. הטיוטה לא נשלחה שוב עד שיהיה שם תקין.",
        items: ["שם העסקה"]
      };
      state.createDealFieldErrors = { sellerTitle: "חסר שם לעסקה. אנא הזן שם קצר וברור לעסקה." };
      render();
    }
    focusCreateDealError();
  }
}

function buildCreateDealPayload({ title, description, price, minUnits, maxUnits, deadline, sellerContext, deliveryOptions }) {
  return {
    title: String(title || "").trim(),
    description: String(description || "").trim(),
    price_per_unit: price,
    min_units: minUnits,
    max_units: maxUnits,
    deadline: new Date(deadline).toISOString(),
    seller_id: sellerContext.seller_id,
    seller_display_name: sellerContext.display_name,
    delivery_options: deliveryOptions
  };
}

const CREATE_DEAL_TITLE_FIELDS = ["title", "sellerTitle", "dealTitle", "productName", "name", "deal_name"];

function readCreateDealTitle(formData) {
  for (const field of CREATE_DEAL_TITLE_FIELDS) {
    const value = String(formData.get(field) || "").trim();
    if (value) return value;
  }
  return "";
}

async function uploadSellerDealImage(dealId, image) {
  if (!dealId || !image?.dataUrl) return null;
  return api(`/api/seller/deals/${encodeURIComponent(dealId)}/images`, {
    method: "POST",
    body: json({
      image_data_url: image.dataUrl,
      original_filename: image.filename || "",
      is_primary: Boolean(image.isPrimary),
      sort_order: Number.isFinite(Number(image.sortOrder)) ? Number(image.sortOrder) : 0
    })
  });
}

async function publishDeal(dealId, form) {
  if (!dealId) return;
  const formData = form ? new FormData(form) : null;
  const legalAccepted = formData?.get("sellerPublishLegalAccepted") === "on";
  const criticalTerms = legalAccepted || formData?.get("sellerPublishCriticalTermsAccepted") === "on";
  const thresholdRule = legalAccepted || formData?.get("sellerPublishThresholdAccepted") === "on";
  if (!legalAccepted) {
    return fail(
      "חסרים אישורי פרסום",
      "לפני פרסום עסקה צריך לאשר את תנאי המוכרים, התקנון ומדיניות C-ton."
    );
  }
  await busy("מפרסם את הדף הציבורי...", async () => {
    await api(`/deals/${encodeURIComponent(dealId)}/publish`, {
      method: "POST",
      headers: {
        "x-request-id": `seller-publish:${Date.now()}`,
        "idempotency-key": `seller-publish:${dealId}`
      },
      body: json({
        seller_terms_accepted: legalAccepted,
        seller_critical_terms_accepted: criticalTerms,
        seller_threshold_90_accepted: thresholdRule
      })
    });
    state.banner = {
      tone: "success",
      title: "העסקה פורסמה בהצלחה",
      message: "העסקה פורסמה והיא פתוחה להצטרפות. עכשיו אפשר לשתף את הלינק הציבורי."
    };
    await loadSellerDeal(dealId);
  }, "פרסום העסקה נכשל.");
}

async function changeSellerStatus(form) {
  const sellerId = form.dataset.sellerId || "";
  const status = form.dataset.status || "";
  if (!sellerId || !status) return;
  const formData = new FormData(form);
  const reason = String(formData.get("adminSellerStatusReason") || state.adminSellerStatusReason || "").trim();
  if (!reason.trim()) {
    return fail("חסרה סיבה", "כל שינוי סטטוס מוכר דורש סיבה כתובה ונרשם לביקורת.");
  }
  await busy("מעדכן סטטוס מוכר...", async () => {
    await api(`/api/admin/sellers/${encodeURIComponent(sellerId)}/status`, {
      method: "POST",
      headers: {
        "x-request-id": `admin-seller-status:${Date.now()}`,
        "idempotency-key": `admin-seller-status:${sellerId}:${status}:${Date.now()}`
      },
      body: json({ status, reason: reason.trim() })
    });
    state.banner = {
      tone: status === "Active" ? "success" : "warning",
      title: "סטטוס המוכר עודכן",
      message: "השינוי נשמר ונרשם לביקורת."
    };
    state.adminSellerStatusModal = null;
    state.adminSellerStatusReason = "";
    await loadAdmin(state.form.adminQuery || "");
  }, "עדכון סטטוס המוכר נכשל.");
}

function openSellerStatusModal(target) {
  state.adminSellerStatusModal = {
    sellerId: target.dataset.sellerId || "",
    sellerName: target.dataset.sellerName || "",
    status: target.dataset.status || "",
    label: target.dataset.label || ""
  };
  state.adminSellerStatusReason = "";
  render();
}

function closeSellerStatusModal() {
  state.adminSellerStatusModal = null;
  state.adminSellerStatusReason = "";
  render();
}

async function saveSellerContextFromForm(form) {
  if (!usesDemoSellerContext()) {
    return fail("החלפת זהות ידנית אינה זמינה", "בסביבה הזו זהות המוכר נקבעת דרך כניסה מאובטחת, ולא דרך שמירה מקומית בדפדפן.");
  }
  const formData = new FormData(form);
  const sellerId = String(formData.get("sellerContextId") || "").trim();
  const displayName = String(formData.get("sellerContextName") || "").trim();
  if (!sellerId) {
    return fail("חסר מזהה מוכר", "יש לבחור מזהה מוכר פעיל לפני כניסה לניהול העסקאות.");
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
      message: `העבודה בניהול העסקאות תתבצע עכשיו תחת ${sellerContext.display_name}.`
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
    return fail("חסרים פרטי כניסה", "יש להזין מזהה מוכר וקוד גישה כדי להיכנס לניהול העסקאות.");
  }

  await busy("פותח את ניהול העסקאות...", async () => {
    const payload = await api("/api/seller/session/login", {
      method: "POST",
      body: json({
        identifier: sellerId,
        access_code: accessCode
      })
    });
    state.sellerAuth = payload?.seller_auth || null;
    syncSellerContext(payload?.seller_auth?.seller_context || null);
    state.form.sellerAccessCode = "";
    state.banner = {
      tone: "success",
      title: "ניהול העסקאות נפתח",
      message: `העבודה בניהול העסקאות מתבצעת עכשיו תחת ${state.sellerAuth?.seller_context?.display_name || sellerId}.`
    };
    await runRoute();
  }, "הכניסה לניהול העסקאות נכשלה.");
}

async function logoutSeller() {
  await busy("סוגר את ניהול העסקאות...", async () => {
    const payload = await api("/api/seller/session/logout", {
      method: "POST"
    });
    state.sellerAuth = payload?.seller_auth || null;
    state.sellerPayload = null;
    state.sellerDealPayload = null;
    state.sellerContext = null;
    state.banner = {
      tone: "success",
      title: "הגישה של המוכר נסגרה",
      message: "ניהול העסקאות חזר למצב נעול עד לכניסה מחודשת."
    };
    await runRoute();
  }, "היציאה מניהול העסקאות נכשלה.");
}

async function cloneSellerDeal(dealId) {
  if (!dealId) return;
  await busy("יוצר טיוטה דומה...", async () => {
    const result = await api(`/api/seller/deals/${encodeURIComponent(dealId)}/duplicate`, {
      method: "POST"
    });
    state.banner = {
      tone: "success",
      title: "נוצרה טיוטה חדשה",
      message: "נוצרה טיוטה חדשה על בסיס העסקה הקודמת. יש לבדוק ולאשר את כל התנאים לפני פרסום."
    };
    await loadSellerDeal(result.new_deal_id);
    navigate(`/app/seller/deals/${encodeURIComponent(result.new_deal_id)}`);
  }, "לא הצלחנו ליצור טיוטה דומה לעסקה.");
}

async function handleSellerImageSelection(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  const existingImages = readSellerImages();
  const remainingSlots = Math.max(0, 5 - existingImages.length);
  const nextFiles = files.slice(0, remainingSlots);
  if (!nextFiles.length) {
    input.value = "";
    state.sellerImageUploadStatus = "error";
    state.sellerImageUploadError = "אפשר להעלות עד 5 תמונות לעסקה.";
    render();
    return;
  }
  for (const file of nextFiles) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      input.value = "";
      state.sellerImageUploadStatus = "error";
      state.sellerImageUploadError = "לא הצלחנו להעלות את התמונה. נסו קובץ JPG, PNG או WebP עד 2MB.";
      render();
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      input.value = "";
      state.sellerImageUploadStatus = "error";
      state.sellerImageUploadError = "לא הצלחנו להעלות את התמונה. נסו קובץ JPG, PNG או WebP עד 2MB.";
      render();
      return;
    }
  }
  state.sellerImageUploadStatus = "loading";
  state.sellerImageUploadError = "";
  render();
  try {
    const images = await Promise.all(nextFiles.map((file) => readImageFile(file)));
    const normalized = normalizeSellerImages([...existingImages, ...images]);
    setSellerImages(normalized);
    state.sellerImageUploadStatus = "idle";
  } catch {
    state.sellerImageUploadStatus = "error";
    state.sellerImageUploadError = "לא הצלחנו להעלות את התמונה. נסו קובץ JPG, PNG או WebP עד 2MB.";
  } finally {
    input.value = "";
    render();
  }
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      dataUrl: String(reader.result || ""),
      filename: file.name,
      mimeType: file.type,
      size: file.size
    });
    reader.onerror = () => reject(new Error("image_read_failed"));
    reader.readAsDataURL(file);
  }).catch(() => {
    fail("טעינת התמונה נכשלה", "לא הצלחנו לקרוא את אחד הקבצים שנבחרו.");
    return null;
  }).then((image) => {
    if (!image) throw new Error("image_read_failed");
    return image;
  });
}

function readSellerImages() {
  try {
    const parsed = JSON.parse(state.form.sellerImagesJson || "[]");
    if (!Array.isArray(parsed)) return [];
    return normalizeSellerImages(parsed
      .filter((image) => image && typeof image === "object" && image.dataUrl)
      .slice(0, 5)
      .map((image) => ({
        dataUrl: String(image.dataUrl || ""),
        filename: String(image.filename || image.name || "product-image"),
        mimeType: String(image.mimeType || ""),
        size: Number(image.size || 0),
        isPrimary: Boolean(image.isPrimary || image.is_primary)
      })));
  } catch {
    return state.form.sellerImageDataUrl
      ? [{ dataUrl: state.form.sellerImageDataUrl, filename: state.form.sellerImageName || "product-image", isPrimary: true }]
      : [];
  }
}

function normalizeSellerImages(images) {
  const source = (Array.isArray(images) ? images : [])
    .filter((image) => image && image.dataUrl)
    .slice(0, 5);
  const hasExplicitPrimary = source.some((image) => Boolean(image.isPrimary || image.is_primary));
  const normalized = source.map((image, index) => ({
      dataUrl: String(image.dataUrl || ""),
      filename: String(image.filename || image.name || "product-image"),
      mimeType: String(image.mimeType || ""),
      size: Number(image.size || 0),
      isPrimary: hasExplicitPrimary ? Boolean(image.isPrimary || image.is_primary) : index === 0
    }));
  const primaryIndex = normalized.findIndex((image) => image.isPrimary);
  normalized.forEach((image, index) => { image.isPrimary = index === (primaryIndex >= 0 ? primaryIndex : 0); });
  return normalized;
}

function setSellerImages(images) {
  const normalized = normalizeSellerImages(images);
  state.form.sellerImagesJson = JSON.stringify(normalized);
  const primary = getSellerPrimaryImage(normalized);
  state.form.sellerImageDataUrl = primary?.dataUrl || "";
  state.form.sellerImageName = primary?.filename || "";
}

function getSellerPrimaryImage(images = readSellerImages()) {
  return images.find((image) => image.isPrimary) || images[0] || null;
}

function removeSellerImage(index) {
  const images = readSellerImages();
  images.splice(Number(index || 0), 1);
  setSellerImages(images);
  state.banner = {
    tone: "warning",
    title: "התמונה הוסרה",
    message: images.length ? "רשימת התמונות עודכנה והתמונה הראשית נשארה הראשונה בגלריה." : "דף העסקה יחזור לתצוגת ברירת המחדל עד שתבחר תמונות מוצר."
  };
  render();
}

function makeSellerImagePrimary(index) {
  const images = readSellerImages();
  const selectedIndex = Number(index || 0);
  const selected = images[selectedIndex];
  if (!selected) return;
  setSellerImages(images.map((image, currentIndex) => ({ ...image, isPrimary: currentIndex === selectedIndex })));
  state.banner = {
    tone: "success",
    title: "התמונה הראשית עודכנה",
    message: "התמונה שנבחרה תופיע כתמונה הראשית בתצוגת העסקה."
  };
  render();
}

function clearSellerProductImage() {
  setSellerImages([]);
  state.sellerImageUploadStatus = "idle";
  state.sellerImageUploadError = "";
  render();
}

function sellerPickupLocationHasData(slot) {
  return ["Label", "PointName", "Address", "City", "Instructions", "LocationUrl"].some((suffix) =>
    String(state.form[`sellerDelivery${suffix}${slot}`] || "").trim()
  );
}

function activeSellerPickupSlots() {
  return [1, 2, 3, 4, 5].filter((slot) => sellerPickupLocationHasData(slot));
}

function addSellerPickupLocation() {
  const slot = [1, 2, 3, 4, 5].find((item) => !sellerPickupLocationHasData(item));
  if (!slot) return fail("מגבלת מיקומים", "אפשר להגדיר עד 5 מיקומי איסוף או נקודות חלוקה לעסקה אחת.");
  const type = state.form.sellerFulfillmentType === "distribution_point" ? "distribution_point" : "pickup";
  state.form[`sellerDeliveryType${slot}`] = type;
  state.form[`sellerDeliveryCost${slot}`] = state.form[`sellerDeliveryCost${slot}`] || "0";
  state.form[`sellerDeliveryLabel${slot}`] = type === "distribution_point" ? `נקודת חלוקה ${slot}` : `איסוף עצמי ${slot}`;
  state.createDealFieldErrors = {};
  render();
  setTimeout(() => {
    const input = document.getElementById(`sellerDeliveryPointName${slot}`);
    if (input) input.focus();
  }, 0);
}

function removeSellerPickupLocation(slot) {
  const index = Number(slot || 0);
  if (!index || index < 1 || index > 5) return;
  for (const suffix of ["Label", "PointName", "Address", "City", "Instructions", "LocationUrl"]) {
    state.form[`sellerDelivery${suffix}${index}`] = "";
  }
  state.form[`sellerDeliveryCost${index}`] = "0";
  delete state.createDealFieldErrors[`sellerDeliveryLabel${index}`];
  delete state.createDealFieldErrors[`sellerDeliveryPointName${index}`];
  delete state.createDealFieldErrors[`sellerDeliveryAddress${index}`];
  delete state.createDealFieldErrors[`sellerDeliveryCity${index}`];
  delete state.createDealFieldErrors[`sellerDeliveryLocationUrl${index}`];
  render();
}

function clearCreateDealErrorForField(fieldName) {
  if (!state.createDealFieldErrors?.[fieldName]) return;
  const next = { ...state.createDealFieldErrors };
  delete next[fieldName];
  state.createDealFieldErrors = next;
}

function updateSellerCreatePreviewFromState() {
  if (state.route.name !== "seller-new") return;
  const price = Math.max(0, Number(state.form.sellerPrice || 0));
  const minUnits = Math.max(0, Number(state.form.sellerMinUnits || 0));
  const maxUnits = Math.max(0, Number(state.form.sellerMaxUnits || 0));
  const previewTarget = minUnits || 8;
  const setText = (selector, value) => {
    const target = document.querySelector(selector);
    if (target) target.textContent = value;
  };
  setText("[data-create-preview-title]", state.form.sellerTitle || "שם העסקה יופיע כאן");
  setText("[data-create-preview-price]", currency(price));
  setText("[data-create-preview-progress]", `0 / ${num(previewTarget)} יחידות`);
  setText("[data-create-preview-status]", `עוד ${num(previewTarget)} יחידות והעסקה יוצאת לפועל`);
  setText("[data-create-preview-goal]", `${num(minUnits)} יח'`);
  setText("[data-create-preview-goal-sum]", currency(price * minUnits));
  setText("[data-create-summary-min-volume]", currency(price * minUnits));
  setText("[data-create-summary-max-volume]", currency(price * maxUnits));
  setText("[data-create-summary-title]", state.form.sellerTitle || "עדיין חסרה");
  setText("[data-create-summary-price]", currency(price));
  setText("[data-create-summary-units]", `${num(minUnits)} / ${num(maxUnits)}`);
}

function focusCreateDealError() {
  setTimeout(() => {
    const target = document.querySelector("[data-create-deal-alert]") || document.querySelector("[data-testid='seller-create-error-summary']") || document.querySelector(".seller-create-hero");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, 0);
}

async function shareLink(url, title) {
  const shareUrl = absoluteUrl(url || location.pathname);
  const shareTitle = title || "עסקה ב-C-ton";
  if (navigator.share) {
    try {
      await navigator.share({ title: shareTitle, url: shareUrl });
      return;
    } catch (error) {
      if (String(error?.name || "") === "AbortError") return;
    }
  }
  await copyLink(shareUrl);
}

async function copyLink(url) {
  const shareUrl = absoluteUrl(url || location.pathname);
  try {
    await navigator.clipboard.writeText(shareUrl);
    state.banner = {
      tone: "success",
      title: "הלינק הועתק",
      message: "אפשר להדביק אותו עכשיו בווטסאפ, בטלגרם, במייל או בכל ערוץ שיתוף אחר."
    };
  } catch {
    state.banner = {
      tone: "warning",
      title: "לא הצלחנו להעתיק אוטומטית",
      message: shareUrl
    };
  }
  render();
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
  await busy("פותח פנייה תפעולית...", async () => {
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
      title: "פניית התמיכה נפתחה",
      message: "הפנייה נוספה עכשיו למרכז התמיכה הפנימי."
    };
    await loadAdmin(state.form.adminQuery);
  }, "לא הצלחנו לפתוח את פנית התמיכה.");
}

async function updateSupportTicket(form) {
  const ticketId = form.dataset.ticketId;
  if (!ticketId) return;
  const formData = new FormData(form);
  await busy("מעדכן את פנית התמיכה...", async () => {
    await api(`/api/admin/support/${encodeURIComponent(ticketId)}`, {
      method: "POST",
      body: json({
        status: String(formData.get("supportTicketStatus") || ""),
        summary: String(formData.get("supportTicketSummary") || "")
      })
    });
    state.banner = {
      tone: "success",
      title: "פניית התמיכה עודכנה",
      message: "מרכז התמיכה רוענן עם הסטטוס האחרון."
    };
    await loadAdmin(state.form.adminQuery);
  }, "לא הצלחנו לעדכן את פנית התמיכה.");
}

async function createSupportCase(form) {
  const formData = new FormData(form);
  const caseType = String(formData.get("caseType") || "").trim();
  const priority = String(formData.get("casePriority") || "Normal").trim();
  const subject = String(formData.get("caseSubject") || "").trim();
  const description = String(formData.get("caseDescription") || "").trim();
  const dealId = String(formData.get("caseDealId") || "").trim();
  const sellerId = String(formData.get("caseSellerId") || "").trim();
  const participantId = String(formData.get("caseParticipantId") || "").trim();
  if (!caseType || !priority || !subject) return fail("חסרים פרטי תיק", "יש לבחור סוג, עדיפות וכותרת לפני פתיחת תיק.");
  await busy("פותח תיק תפעולי...", async () => {
    await api("/api/admin/support-cases", {
      method: "POST",
      headers: {
        "x-request-id": `admin-case-create:${Date.now()}`,
        "idempotency-key": `admin-case-create:${Date.now()}`
      },
      body: json({
        case_type: caseType,
        priority,
        subject,
        description,
        deal_id: dealId || undefined,
        seller_id: sellerId || undefined,
        participant_id: participantId || undefined
      })
    });
    state.banner = {
      tone: "success",
      title: "התיק נפתח",
      message: "התיק נשמר ב-Support Hub ונרשם לאירועי בקרה."
    };
    await loadAdminSupportCases();
  }, "לא הצלחנו לפתוח תיק תפעולי.");
}

async function updateSupportCase(form) {
  const caseId = form.dataset.caseId || "";
  if (!caseId) return;
  const formData = new FormData(form);
  await busy("מעדכן תיק תפעולי...", async () => {
    await api(`/api/admin/support-cases/${encodeURIComponent(caseId)}`, {
      method: "PATCH",
      headers: {
        "x-request-id": `admin-case-update:${caseId}:${Date.now()}`,
        "idempotency-key": `admin-case-update:${caseId}:${Date.now()}`
      },
      body: json({
        status: String(formData.get("caseStatus") || ""),
        priority: String(formData.get("casePriority") || ""),
        assigned_to: String(formData.get("caseAssignedTo") || ""),
        resolution_note: String(formData.get("caseResolutionNote") || ""),
        reason: String(formData.get("caseReason") || formData.get("caseResolutionNote") || "")
      })
    });
    state.banner = { tone: "success", title: "התיק עודכן", message: "השינוי נשמר ונרשם לביקורת." };
    await loadAdminSupportCases();
  }, "עדכון התיק נכשל.");
}

async function escalateSupportCase(caseId) {
  if (!caseId) return;
  await busy("מסלים תיק...", async () => {
    await api(`/api/admin/support-cases/${encodeURIComponent(caseId)}/escalate`, {
      method: "POST",
      headers: {
        "x-request-id": `admin-case-escalate:${caseId}:${Date.now()}`,
        "idempotency-key": `admin-case-escalate:${caseId}:${Date.now()}`
      },
      body: json({ reason: "Escalated from Support Hub" })
    });
    state.banner = { tone: "warning", title: "התיק הוסלם", message: "העדיפות עודכנה ל-Urgent ללא שינוי סטייט או פעולה כספית." };
    await loadAdminSupportCases();
  }, "לא הצלחנו להסלים את התיק.");
}

function openCaseCloseModal(target) {
  state.adminCaseCloseModal = {
    caseId: target.dataset.caseId || "",
    subject: target.dataset.subject || ""
  };
  render();
}

function closeCaseCloseModal() {
  state.adminCaseCloseModal = null;
  render();
}

async function closeSupportCase(form) {
  const caseId = form.dataset.caseId || state.adminCaseCloseModal?.caseId || "";
  const formData = new FormData(form);
  const resolution = String(formData.get("adminCaseCloseResolution") || "").trim();
  if (!caseId || !resolution) return fail("חסרה החלטת סגירה", "אי אפשר לסגור תיק בלי resolution_note.");
  await busy("סוגר תיק תפעולי...", async () => {
    await api(`/api/admin/support-cases/${encodeURIComponent(caseId)}`, {
      method: "PATCH",
      headers: {
        "x-request-id": `admin-case-close:${caseId}:${Date.now()}`,
        "idempotency-key": `admin-case-close:${caseId}:${Date.now()}`
      },
      body: json({ status: "Closed", resolution_note: resolution, reason: resolution })
    });
    state.adminCaseCloseModal = null;
    state.banner = { tone: "success", title: "התיק נסגר", message: "הסגירה נשמרה עם הערת החלטה ונרשמה לביקורת." };
    await loadAdminSupportCases();
  }, "סגירת התיק נכשלה.");
}

function restartFlow() {
  const dealId = state.route.dealId || state.trackingPayload?.tracking?.deal_id || state.dealPayload?.deal?.deal_id;
  if (!dealId) return navigate("/app");
  removeFlow(dealId);
  state.form = {
    adminQuery: state.form.adminQuery,
    qty: String(state.dealPayload?.deal?.min_units || 1),
    deliveryOptionId: "",
    phone: "",
    code: "",
    payerName: "",
    sellerTitle: state.form.sellerTitle,
    sellerDescription: state.form.sellerDescription,
    sellerImageDataUrl: state.form.sellerImageDataUrl,
    sellerImageName: state.form.sellerImageName,
    sellerImagesJson: state.form.sellerImagesJson,
    sellerContextId: state.form.sellerContextId,
    sellerContextName: state.form.sellerContextName,
    sellerAccessCode: state.form.sellerAccessCode,
    sellerPrice: state.form.sellerPrice,
    sellerMinUnits: state.form.sellerMinUnits,
    sellerMaxUnits: state.form.sellerMaxUnits,
    sellerDeadline: state.form.sellerDeadline,
    sellerFulfillmentType: state.form.sellerFulfillmentType,
    sellerDeliveryType1: state.form.sellerDeliveryType1,
    sellerDeliveryLabel1: state.form.sellerDeliveryLabel1,
    sellerDeliveryCost1: state.form.sellerDeliveryCost1,
    sellerDeliveryPointName1: state.form.sellerDeliveryPointName1,
    sellerDeliveryAddress1: state.form.sellerDeliveryAddress1,
    sellerDeliveryCity1: state.form.sellerDeliveryCity1,
    sellerDeliveryInstructions1: state.form.sellerDeliveryInstructions1,
    sellerDeliveryLocationUrl1: state.form.sellerDeliveryLocationUrl1,
    sellerDeliveryType2: state.form.sellerDeliveryType2,
    sellerDeliveryLabel2: state.form.sellerDeliveryLabel2,
    sellerDeliveryCost2: state.form.sellerDeliveryCost2,
    sellerDeliveryPointName2: state.form.sellerDeliveryPointName2,
    sellerDeliveryAddress2: state.form.sellerDeliveryAddress2,
    sellerDeliveryCity2: state.form.sellerDeliveryCity2,
    sellerDeliveryInstructions2: state.form.sellerDeliveryInstructions2,
    sellerDeliveryLocationUrl2: state.form.sellerDeliveryLocationUrl2,
    sellerDeliveryType3: state.form.sellerDeliveryType3,
    sellerDeliveryLabel3: state.form.sellerDeliveryLabel3,
    sellerDeliveryCost3: state.form.sellerDeliveryCost3,
    sellerDeliveryPointName3: state.form.sellerDeliveryPointName3,
    sellerDeliveryAddress3: state.form.sellerDeliveryAddress3,
    sellerDeliveryCity3: state.form.sellerDeliveryCity3,
    sellerDeliveryInstructions3: state.form.sellerDeliveryInstructions3,
    sellerDeliveryLocationUrl3: state.form.sellerDeliveryLocationUrl3,
    sellerFinalTerms: state.form.sellerFinalTerms,
    sellerFinalConfirm: state.form.sellerFinalConfirm
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

async function copyText(value) {
  const content = String(value || "").trim();
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    state.banner = {
      tone: "success",
      title: "הטקסט הועתק",
      message: "אפשר להדביק אותו עכשיו בערוץ השיווק שבחרת."
    };
  } catch {
    state.banner = {
      tone: "warning",
      title: "ההעתקה האוטומטית לא הצליחה",
      message: "אפשר לסמן את הטקסט ולהעתיק אותו ידנית."
    };
  }
  render();
}

function render() {
  syncDocumentFrame();
  const routeLabel = getRouteLabel();
  const routeSummary = getRouteSummary();
  root.innerHTML = `
    <div class="shell app-shell">
      <header class="app-shell-header">
        <section class="shell-surface shell-header-bar" aria-label="כותרת האפליקציה">
          <div class="shell-brand">
            <strong>C-ton</strong>
            <p>${esc(routeSummary)}</p>
          </div>
          <div class="shell-meta">
            <span class="route-chip">${esc(routeLabel)}</span>
            ${INTERNAL_SURFACE_ROUTES.has(state.route.name) ? `<span class="route-chip">משטח תפעולי</span>` : ""}
          </div>
        </section>
        ${renderNav()}
      </header>
      <div class="shell-live-region" aria-live="polite" aria-atomic="true">
        ${renderPreviewStrip()}
        ${state.banner ? renderBanner(state.banner) : ""}
        ${state.error ? renderErrorCard(state.error) : ""}
        ${state.loading ? renderInfoStrip(state.loadingMessage || "טוען...") : ""}
      </div>
      <main id="main-content" class="shell-main" tabindex="-1">
        ${renderCurrentRoute()}
      </main>
      ${renderSellerStatusModal()}
      ${renderCaseCloseModal()}
      ${renderPublicTrustFooter()}
    </div>
  `;
}

function syncDocumentFrame() {
  document.documentElement.setAttribute("lang", "he");
  document.documentElement.setAttribute("dir", "rtl");
  document.body.setAttribute("dir", "rtl");
  document.title = `C-ton | ${getRouteLabel()}`;
}

function getRouteLabel() {
  return ROUTE_LABELS[state.route.name] || "מסלול קונה";
}

function getRouteSummary() {
  const summaries = {
    home: "עסקה קבוצתית חיה, חמה ושקופה.",
    deal: "דף עסקה ציבורי עם בחירת כמות, מצב עסקה והצטרפות מסודרת.",
    otp: "אימות טלפון לפני המשך למסלול ההצטרפות.",
    payment: "שמירת ההצטרפות והמשך למסלול אישור המסגרת.",
    confirmation: "סיכום ברור של ההצטרפות ומה קורה מיד אחריה.",
    tracking: "מעקב קונה אחרי מצב ההשתתפות, האישור והעסקה.",
    recovery: "מסך השלמת תשלום במצב כשל חיוב, ללא שינוי כמות וללא ביטול.",
    seller: "ניהול העסקאות הפעילות, הטיוטות והפעולות של המוכר במקום אחד.",
    "seller-new": "פתיחת עסקה חדשה במסלול מונחה, בעברית מלאה ובמובייל תחילה.",
    "seller-deal": "דף עסקה למוכר עם תמונת מצב, משתתפים, מסירה ומסמכים.",
    affiliate: "מרכז הפצה וייחוס עם מצב אימות וביצועי קמפיינים. המפיץ הוא ערוץ מדידה והפצה בלבד — ללא עמלה או תשלום.",
    admin: "מרכז תפעול, חיפוש, חריגות, תורי אימות ותמונת מערכת.",
    "admin-support": "Support Hub לטיפול בתיקי קצה בלבד, בלי אישור מראש ובלי פעולות כסף.",
    "admin-deal": "פרופיל עסקה לתפעול, בקרה ותמיכה.",
    "admin-participant": "פרופיל משתתף לתפעול, תמיכה ואבחון חוצה מערכות.",
    "admin-user": "פרופיל משתמש לתפעול, תמיכה וחקירה.",
    terms: "תנאי השימוש של C-ton.",
    privacy: "מדיניות הפרטיות של C-ton.",
    refunds: "מדיניות ביטולים והחזרים של C-ton.",
    contact: "פרטי יצירת קשר ושכבת אמון ציבורית."
  };
  return summaries[state.route.name] || "ממשק C-ton מיושר ל-RTL, מובייל ונגישות כברירת מחדל.";
}

function renderPreviewStrip() {
  const preview = state.previewMeta?.preview;
  if (!preview?.is_demo_preview) return "";
  return `
    <section class="info-strip tone-warning">
      <strong>מצב הצגה מבוקר</strong>
      <p>אפשר לעבור את מסלול המוצר ולראות את חוויית הקונה והמוכר. פעולות כספיות ושירותים חיצוניים אינם מבוצעים בפועל במסך הזה.</p>
    </section>
  `;
}

function renderCurrentRoute() {
  const route = state.route;
  if (route.name === "home") return renderCtonHome();
  if (route.name === "deal") return renderCtonDealPage();
  if (route.name === "otp") return renderCtonOtpPage(route.dealId);
  if (route.name === "payment") return renderCtonPaymentPage(route.dealId);
  if (route.name === "confirmation") return renderCtonConfirmationPage(route.dealId);
  if (route.name === "tracking") return renderCtonTrackingPage();
  if (route.name === "recovery") return renderRecoveryPage();
  if (route.name === "terms") return renderTermsPage();
  if (route.name === "privacy") return renderPrivacyPage();
  if (route.name === "refunds") return renderRefundsPage();
  if (route.name === "accessibility") return renderAccessibilityPage();
  if (route.name === "seller-terms") return renderSellerTermsPage();
  if (route.name === "distributor-terms") return renderDistributorTermsPage();
  if (route.name === "contact") return renderContactPage();
  if (route.name === "seller") return renderCtonSellerPage();
  if (route.name === "seller-new") return renderSellerNewPage();
  if (route.name === "seller-deal") return renderCtonSellerDealPage();
  if (route.name === "affiliate") return renderAffiliatePage();
  if (route.name === "admin") return renderAdminPage();
  if (route.name === "admin-support") return renderAdminSupportPage();
  if (route.name === "admin-deal") return renderAdminDealPage();
  if (route.name === "admin-participant") return renderAdminParticipantPage();
  if (route.name === "admin-user") return renderAdminUserPage();
  return renderEmptyState("העמוד לא נמצא", "הקישור הזה לא קיים או שכבר אינו זמין.");
}

function icon(name) {
  const icons = {
    users: "👥",
    trend: "↗",
    clock: "◷",
    shield: "✓",
    card: "▣",
    package: "🏷",
    share: "↗",
    check: "✓",
    alert: "!",
    lock: "▣",
    link: "🔗"
  };
  return `<span class="cton-icon" aria-hidden="true">${icons[name] || "•"}</span>`;
}

function progressStatusSentence(stateName, currentUnits, targetUnits, atRiskUnits) {
  return buildProgressStatus({ stateName, currentUnits, targetUnits, atRiskUnits });
}

function renderCtonProgressCard({ title = "העסקה מתקדמת", stateName, currentUnits, targetUnits, maxUnits, deadline, percentValue, atRiskUnits }) {
  const current = Math.max(0, Number(currentUnits || 0));
  const target = Math.max(1, Number(targetUnits || 1));
  const pct = Math.max(0, Math.min(100, Number(percentValue ?? ((current / target) * 100))));
  const remainingToTarget = Math.max(0, target - current);
  const remainingCapacity = Math.max(0, Number(maxUnits || target) - current);
  return `
    <section class="cton-card cton-progress-card">
      <div class="cton-section-head">
        <h2>${esc(title)}</h2>
        <span class="cton-live-dot">${icon("trend")} בזמן אמת</span>
      </div>
      <div class="cton-progress-numbers">
        <strong>${num(current)} / ${num(target)} יחידות</strong>
        <span>${percent(pct)}</span>
      </div>
      ${renderProgressBlock({ stateName, currentUnits: current, targetUnits: target, percentValue: pct, atRiskUnits })}
      <p class="cton-progress-sentence">${progressStatusSentence(stateName, current, target, atRiskUnits)}</p>
      <div class="cton-progress-facts">
        <span>מינימום: ${num(target)}</span>
        <span>מקסימום: ${num(maxUnits || target)}</span>
        <span>נותרו: ${num(remainingCapacity)}</span>
        <span>${deadline ? `דדליין: ${dt(deadline)}` : `ליעד: ${num(remainingToTarget)}`}</span>
      </div>
    </section>
  `;
}

function renderCtonHome() {
  return `
    <section class="cton-home-hero">
      <div class="cton-hero-copy">
        <h1>C-ton</h1>
        <h2>קונים יחד. משלמים רק כשזה קורה.</h2>
        <p>הופכים ביקוש מפוזר לעסקה אמיתית, בלי לחייב אף אחד לפני שהקבוצה מצליחה.</p>
        <div class="cton-trust-list">
          <span>${icon("users")} מצטרפים לעסקה</span>
          <span>${icon("trend")} רואים את ההתקדמות בזמן אמת</span>
          <span>${icon("shield")} החיוב מתבצע רק אם העסקה מצליחה</span>
        </div>
        <div class="cton-actions">
          <a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">פתחו עסקה חדשה</a>
          <a class="button secondary" href="/app/seller" data-nav="/app/seller">צפו בדמו חי</a>
        </div>
      </div>
      <aside class="cton-live-demo-card">
        <span class="badge pending">עסקה חיה</span>
        <h3>מארז קפה שכונתי</h3>
        <div class="cton-demo-price">₪79</div>
        ${renderProgressBlock({ stateName: "PendingTarget", currentUnits: 37, targetUnits: 50, percentValue: 74 })}
        <p class="cton-progress-sentence">עוד 13 יחידות והעסקה יוצאת לפועל</p>
        <div class="cton-activity-line">${icon("users")} 3 הצטרפו בשעה האחרונה</div>
        <a class="button primary" href="/app/seller" data-nav="/app/seller">הצטרפו לעסקה</a>
      </aside>
    </section>
    <section class="cton-home-cards">
      <article class="cton-card"><h2>לא קונים לבד</h2><p>העסקה מתקדמת רק כשמספיק אנשים מצטרפים.</p></article>
      <article class="cton-card"><h2>לא מחויבים לפני הזמן</h2><p>מתבצעת תפיסת מסגרת בלבד עד שהעסקה מצליחה.</p></article>
      <article class="cton-card"><h2>הכול גלוי</h2><p>היעד, הכמות, הזמן והסטטוס מוצגים בכל רגע.</p></article>
    </section>
    <section class="cton-card cton-how">
      <h2>איך זה עובד</h2>
      <div class="cton-steps">
        <article><span>1</span>${icon("link")}<strong>יוצרים לינק לעסקה</strong></article>
        <article><span>2</span>${icon("users")}<strong>אנשים מצטרפים ומשתפים</strong></article>
        <article><span>3</span>${icon("check")}<strong>אם היעד מושג, העסקה יוצאת לפועל</strong></article>
      </div>
    </section>
    <footer class="cton-mini-footer">
      <strong>C-ton</strong>
      <a href="/legal/terms">תקנון</a>
      <a href="/legal/privacy">מדיניות פרטיות</a>
      <a href="/legal/refunds">ביטולים והחזרים</a>
      <a href="/legal/sellers">תנאי מוכרים</a>
      <a href="/legal/affiliates">תנאי מפיצים</a>
    </footer>
  `;
}

function renderCtonDealPage() {
  return renderCtonDealPageView();
}

function renderCtonDealPageView(payloadOverride = null, options = {}) {
  const payload = payloadOverride || state.dealPayload;
  const preview = Boolean(options.preview);
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("אי אפשר להציג את העסקה", "לא הצלחנו לטעון את פרטי העסקה שביקשת.");
  const { deal, metrics, availability } = payload;
  const seller = payload.seller || deal.seller || {};
  const dealCopy = getDealCopy(deal.state);
  const qty = Math.max(1, Number(state.form.qty || 1));
  const deliveryOptions = getDeliveryOptions(payload);
  const selectedDelivery = getSelectedDeliveryOption(payload, state.form.deliveryOptionId);
  const holdTotal = calcHoldTotal(payload, qty, selectedDelivery);
  const remainingToTarget = Math.max(0, Number(deal.threshold_units || 0) - Number(metrics.joined_units || 0));
  const isDraft = deal.state === "Draft";
  const isShareable = !isDraft && ["PendingTarget", "TargetReached"].includes(deal.state);
  const cta = availability.canJoin
    ? remainingToTarget > 0 ? `הצטרפו עכשיו – עוד ${num(remainingToTarget)} יחידות ליעד` : "הצטרפו עכשיו – העסקה יוצאת לפועל"
    : "העסקה כבר סגורה";
  return `
    <section class="cton-deal-page ${preview ? "seller-public-preview" : ""}" ${preview ? 'aria-label="תצוגה מקדימה מלאה של דף הקונה"' : ""}>
      <article class="cton-deal-main">
        <div class="cton-product-image">
          ${getPrimaryDealImage(deal)?.url ? `<img src="${esc(getPrimaryDealImage(deal).url)}" alt="${esc(deal.title)}" />` : `<div>${icon("package")}<strong>תמונת מוצר</strong></div>`}
        </div>
        ${renderDealImageGallery(deal)}
        <section class="cton-card cton-deal-intro">
          <span class="badge ${dealCopy.badgeTone}">${esc(dealCopy.label)}</span>
          <h1>${esc(deal.title)}</h1>
          <p class="muted">${esc(availability.message || dealCopy.description)}</p>
          <div class="cton-meta-row">
            <span>${icon("users")} ${esc(seller.business_name || "מוכר C-ton")}</span>
            <span>${icon("clock")} ${dt(deal.deadline)}</span>
          </div>
        </section>
        ${renderCtonProgressCard({
          stateName: deal.state,
          currentUnits: metrics.joined_units,
          targetUnits: deal.threshold_units,
          maxUnits: deal.max_units,
          deadline: deal.deadline,
          percentValue: metrics.progress_to_minimum_pct ?? ((Number(metrics.joined_units || 0) / Math.max(1, Number(deal.threshold_units || 1))) * 100)
        })}
        <section class="cton-card">
          <h2>מה מקבלים</h2>
          <p>${esc(deal.description || "דף העסקה מרכז את הפרטים, הכמות, קצב ההצטרפות ואופן הקבלה במקום אחד ברור.")}</p>
        </section>
        ${preview ? `<section class="cton-card cton-share-box"><strong>תצוגה מקדימה בלבד</strong><p class="muted">לא נוצרה עסקה, לא בוצע פרסום, ולא הופעלו שיתוף או הצטרפות.</p></section>` : isShareable ? `<section class="cton-card cton-share-box">${renderShareActions(`/app/deal/${deal.deal_id}`, deal.title)}</section>` : `<section class="cton-card cton-share-box"><strong>העסקה עדיין בטיוטה</strong><p class="muted">פרסום ושיתוף יהיו זמינים רק אחרי שהמוכר מפרסם את העסקה.</p></section>`}
      </article>
      <aside class="cton-join-card">
        <h2>הצטרפות לעסקה</h2>
        <div class="cton-unit-price"><strong>${currency(deal.price_per_unit)}</strong><span>ליחידה</span></div>
        <${preview ? "div" : "form"} ${preview ? "" : 'data-action="start-join"'} class="stack">
          <div class="cton-stepper" aria-label="בחירת כמות">
            <button type="button" data-inline-action="qty-step" data-delta="-1">−</button>
            <input id="qty" name="qty" type="number" min="1" max="${Math.max(1, metrics.remaining_units)}" value="${qty}" />
            <button type="button" data-inline-action="qty-step" data-delta="1">+</button>
          </div>
          <div class="cton-delivery-options">
            ${deliveryOptions.map((option) => `
              <label class="cton-delivery-option ${selectedDelivery?.option_id === option.option_id ? "selected" : ""}">
                <input type="radio" name="deliveryOptionId" value="${esc(option.option_id)}" ${selectedDelivery?.option_id === option.option_id ? "checked" : ""} />
                <strong>${esc(formatDeliveryTypeLabel(option.option_type))}</strong>
                <span>${esc(option.label)} · ${currency(option.cost || 0)}</span>
                ${renderDeliveryOptionDetails(option)}
              </label>
            `).join("")}
          </div>
          <div class="cton-price-summary">
            <span>מחיר יחידה <strong>${currency(deal.price_per_unit)}</strong></span>
            <span>כמות <strong>${num(qty)}</strong></span>
            <span>משלוח <strong>${currency(selectedDelivery?.cost || 0)}</strong></span>
            <span class="total">סך הכול לתפיסת מסגרת <strong>${currency(holdTotal)}</strong></span>
          </div>
          <div class="cton-trust-box">
            ${icon("shield")}
            <p>הסכום יתפוס מסגרת אשראי בלבד. לא מתבצע חיוב בפועל עד שהעסקה נסגרת בהצלחה. אם העסקה לא נסגרת, המסגרת משתחררת אוטומטית.</p>
          </div>
          <button class="primary" type="${preview ? "button" : "submit"}" ${preview || !availability.canJoin ? "disabled" : ""}>${preview ? "תצוגה מקדימה — אין הצטרפות" : cta}</button>
        </${preview ? "div" : "form"}>
        ${preview ? `<div class="info-strip tone-warning"><strong>מצב Preview בטוח</strong><p class="small">המסך משתמש באותו renderer של דף העסקה הציבורי, אך כל פעולות Join, Authorization ופרסום כבויות.</p></div>` : isShareable ? renderShareActions(`/app/deal/${deal.deal_id}`, deal.title) : `<div class="info-strip tone-warning"><strong>אין שיתוף בטיוטה</strong><p class="small">העסקה עדיין פנימית ולא פתוחה לקונים.</p></div>`}
      </aside>
    </section>
    ${preview ? renderLegalReferenceStrip("deal") : `${renderLegalReferenceStrip("deal")}${renderDealChatSection(deal)}`}
  `;
}

function renderCtonOtpPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) return renderRecoveryState("אין מסלול פתוח לעסקה הזו", "כדי להמשיך לאימות קצר צריך להתחיל מדף העסקה.", `/app/deal/${encodeURIComponent(dealId)}`);
  const expired = flow.otpExpiresAt && Date.now() > new Date(flow.otpExpiresAt).getTime();
  return `
    <section class="cton-center-screen">
      <article class="cton-card cton-auth-card">
        <div class="cton-icon-circle">${icon("lock")}</div>
        <h1>${flow.otpSessionId ? "הזינו את הקוד שקיבלתם" : "אימות קצר כדי להצטרף"}</h1>
        <p>נשלח לך קוד חד־פעמי כדי לשייך את ההצטרפות לעסקה.</p>
        <form data-action="otp-start" class="stack">
          <div class="field"><label for="phone">טלפון או אימייל</label><input id="phone" name="phone" type="tel" data-dir="ltr" value="${esc(flow.phone || state.form.phone || "")}" placeholder="0501234567" /></div>
          <button class="primary" type="submit">שלחו לי קוד</button>
        </form>
        ${flow.otpSessionId ? `
          <form data-action="otp-verify" class="stack">
            <div class="field"><label for="code">קוד אימות</label><input class="cton-code-input" id="code" name="code" type="text" data-dir="ltr" inputmode="numeric" value="${esc(state.form.code || "")}" placeholder="123456" /></div>
            <p class="small muted">הקוד משמש רק לאימות ההצטרפות. אין צורך בסיסמה.</p>
            ${expired ? `<div class="error-card">תוקף הקוד פג, בקשו קוד חדש.</div>` : ""}
            <button class="primary" type="submit" ${expired ? "disabled" : ""}>אמת והמשך</button>
          </form>
        ` : ""}
      </article>
    </section>
  `;
}

function renderCtonPaymentPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) return renderRecoveryState("אין מסלול שמור להמשך", "כדי להגיע לאישור מסגרת צריך להתחיל מדף העסקה.", `/app/deal/${encodeURIComponent(dealId)}`);
  if (!flow.otpVerified) return renderRecoveryState("צריך להשלים קודם אימות קצר", "הכמות נשמרה, אבל לפני אישור המסגרת צריך להשלים את האימות.", `/app/join/${encodeURIComponent(dealId)}/otp`);
  const deal = state.dealPayload?.deal;
  const deliveryCost = Number(flow.deliveryCost || 0);
  const holdTotal = Number(flow.estimatedTotal || ((flow.qty || 0) * (deal?.price_per_unit || flow.unitPrice || 0) + deliveryCost));
  return `
    <section class="cton-center-screen">
      <article class="cton-card cton-payment-card">
        <span class="eyebrow">הצטרפות לעסקה</span>
        <h1>אישור הצטרפות לעסקה</h1>
        <div class="cton-payment-summary">
          <h2>${esc(deal?.title || flow.dealTitle || "עסקה")}</h2>
          <div class="summary-grid">
            <div><span>כמות</span><strong>${num(flow.qty || 0)} יח'</strong></div>
            <div><span>אופן קבלה</span><strong>${esc(flow.deliveryMethodLabel || "לא נבחר")}</strong></div>
            <div><span>משלוח</span><strong>${currency(deliveryCost)}</strong></div>
          </div>
          <div class="cton-hold-total"><strong>${currency(holdTotal)}</strong><span class="badge pending">תפיסת מסגרת בלבד</span></div>
        </div>
        <div class="cton-trust-box">${icon("shield")}<p>לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה. אם העסקה לא תיסגר, מסגרת האשראי משתחררת אוטומטית ללא חיוב.</p></div>
        <form data-action="pay" class="stack">
          <div class="cton-card-frame">פרטי האשראי מוזנים ברכיב המאובטח של ספק הסליקה</div>
          <div class="field"><label for="payerName">שם למשלם/ת</label><input id="payerName" name="payerName" type="text" data-dir="rtl" value="${esc(state.form.payerName)}" autocomplete="name" /></div>
          <input type="hidden" id="providerPaymentMethodId" name="providerPaymentMethodId" value="" />
          ${renderBuyerPaymentLegalAcceptance()}
          <button class="primary" type="submit">אשרו תפיסת מסגרת</button>
          <p class="small muted">פרטי האשראי אינם נשמרים ב־C-ton.</p>
        </form>
      </article>
    </section>
  `;
}

function renderCtonConfirmationPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) return renderRecoveryState("אין סשן שמור למסך הזה", "אפשר לחזור לעסקה ולהתחיל מסלול חדש.", `/app/deal/${encodeURIComponent(dealId)}`);
  if (!flow.participantId) return renderRecoveryState("עדיין אין אישור סופי להצגה", "כדי להגיע למסך האישור צריך לסיים קודם את אישור המסגרת.", `/app/join/${encodeURIComponent(dealId)}/payment`);
  const trackingHref = flow.trackingUrl || `/app/track/${encodeURIComponent(flow.participantId)}`;
  const current = Number(state.dealPayload?.metrics?.joined_units || flow.currentUnits || 37);
  const target = Number(state.dealPayload?.deal?.threshold_units || flow.targetUnits || 50);
  return `
    <section class="cton-center-screen">
      <article class="cton-card cton-success-card">
        <div class="cton-success-icon">${icon("check")}</div>
        <h1>הצטרפת בהצלחה</h1>
        <p>המסגרת נתפסה. לא בוצע חיוב בפועל. החיוב יתבצע רק אם העסקה תיסגר בהצלחה.</p>
        ${renderCtonProgressCard({ title: "העסקה ממשיכה לזוז", stateName: "PendingTarget", currentUnits: current, targetUnits: target, percentValue: (current / Math.max(1, target)) * 100 })}
        <div class="cton-share-highlight">
          <h2>עזרת לעסקה להתקדם</h2>
          <p>שתפו עם חברים כדי שנגיע ליעד ביחד.</p>
          ${renderShareActions(trackingHref, flow.dealTitle || "מעקב השתתפות ב-C-ton")}
        </div>
        <a class="button secondary" href="${trackingHref}" data-nav="${trackingHref}">מעבר למסך המעקב שלי</a>
      </article>
    </section>
  `;
}

function renderCtonTrackingPage() {
  if (!state.trackingPayload && state.loading) return "";
  if (!state.trackingPayload) return renderEmptyState("לא מצאנו את ההשתתפות", "כדאי לבדוק את הקישור או לחזור לעסקה.");
  const tracking = state.trackingPayload.tracking;
  const dealCopy = getDealCopy(tracking.deal_state);
  const money = getLabel(MONEY_COPY, tracking.money_state);
  const progress = tracking.progress || {};
  const next = nextTrackingStep(tracking);
  const isCompleted = tracking.deal_state === "Completed";
  const isFailed = ["Failed", "Cancelled"].includes(tracking.deal_state);
  const moneyBadge = isCompleted ? "חויב בהצלחה" : isFailed ? "העסקה נכשלה" : "מסגרת נתפסה";
  const moneyText = isCompleted
    ? "העסקה הושלמה בהצלחה. בוצע חיוב בפועל."
    : isFailed
      ? "לא בוצע חיוב. המסגרת שוחררה."
      : "לא בוצע חיוב בפועל.";
  return `
    <section class="cton-tracking-page">
      <header class="cton-card cton-tracking-header">
        <div>
          <span class="badge ${dealCopy.badgeTone}">${esc(dealCopy.label)}</span>
          <h1>${esc(tracking.deal_title)}</h1>
          <p class="muted">מעודכן ${relativeTime(tracking.live?.generated_at || state.trackingPayload.generated_at)}</p>
        </div>
      </header>
      <section class="cton-card cton-status-hero">
        <h2>${esc(next.title)}</h2>
        <p>${esc(next.summary || next.detail)}</p>
        ${renderCtonProgressCard({
          title: "סטטוס העסקה",
          stateName: tracking.deal_state,
          currentUnits: progress.current_units || 0,
          targetUnits: progress.target_units || tracking.threshold_units || 1,
          maxUnits: progress.max_units || tracking.max_units,
          deadline: tracking.deadline,
          percentValue: progress.progress_to_minimum_pct || 0
        })}
      </section>
      <section class="cton-card cton-personal-card">
        <h2>ההצטרפות שלך</h2>
        <div class="cton-data-grid">
          <div><span>כמות</span><strong>${num(tracking.qty)} יח'</strong></div>
          <div><span>אופן קבלה</span><strong>${esc(tracking.delivery_method_label || "לא זמין")}</strong></div>
          <div><span>סכום לתפיסת מסגרת</span><strong>${currency(tracking.estimated_total)}</strong></div>
          <div><span>מצב כספי</span><strong>${esc(money[0])}</strong></div>
        </div>
        <div class="cton-trust-box ${isCompleted ? "success" : isFailed ? "danger" : ""}">
          <span class="badge ${isCompleted ? "success" : isFailed ? "danger" : "pending"}">${moneyBadge}</span>
          <p>${moneyText}</p>
        </div>
      </section>
      <section class="cton-card cton-next-actions">
        <h2>מה אפשר לעשות עכשיו</h2>
        ${tracking.deal_state === "Charging" ? `<p>אין צורך לעשות דבר. המערכת מבצעת את התהליך.</p>` : isCompleted ? `<p>פרטי אספקה וקבלה יופיעו כאן.</p>` : isFailed ? `<p>אין המשך פעולה. לא חויבת.</p>` : `<p>שתפו כדי לעזור לעסקה לצאת לפועל.</p>${renderShareActions(`/app/deal/${tracking.deal_id}`, tracking.deal_title)}`}
      </section>
    </section>
  `;
}

function renderCtonSellerPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) return renderSellerAuthGate();
  const payload = state.sellerPayload?.seller_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("ניהול העסקאות שלי לא זמין", "לא הצלחנו לטעון עכשיו את ניהול העסקאות.");
  const profile = payload.seller_profile || currentSellerContext();
  const deals = Array.isArray(payload.deals) ? payload.deals : [];
  const activeDeals = deals.filter((d) => ["PendingTarget", "TargetReached", "Charging", "CompletionWindow"].includes(d.state));
  const riskDeals = deals.filter((d) => ["CompletionWindow", "Charging"].includes(d.state));
  const regularDeals = deals.filter((d) => !["CompletionWindow", "Charging"].includes(d.state));
  const totalUnits = deals.reduce((sum, d) => sum + Number(d.metrics?.joined_units || 0), 0);
  const potentialGross = deals.reduce((sum, d) => sum + Number(d.price_per_unit || 0) * Number(d.metrics?.joined_units || 0), 0);
  return `
    <section class="cton-seller-dashboard">
      <header class="cton-seller-header">
        <div>
          <span class="eyebrow">Command Center</span>
          <h1>${esc(normalizeSellerDisplayName(profile.seller_id, profile.display_name))}</h1>
          <p class="muted">תמונת מצב עסקית חמה וברורה, בלי טבלאות יבשות.</p>
        </div>
        <a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">צור עסקה חדשה</a>
      </header>
      <section class="cton-kpi-grid">
        <article class="cton-kpi">${icon("package")}<span>עסקאות פעילות</span><strong>${num(activeDeals.length)}</strong></article>
        <article class="cton-kpi">${icon("users")}<span>יחידות בהצטרפות</span><strong>${num(totalUnits)}</strong></article>
        <article class="cton-kpi">${icon("trend")}<span>ברוטו פוטנציאלי</span><strong>${currency(potentialGross)}</strong></article>
        <article class="cton-kpi warning">${icon("alert")}<span>עסקאות בסיכון</span><strong>${num(riskDeals.length)}</strong></article>
      </section>
      ${riskDeals.length ? `<section class="cton-card cton-attention" aria-labelledby="sellerUrgentDeals"><h2 id="sellerUrgentDeals">דורש תשומת לב עכשיו</h2><p class="muted">עסקאות בחיוב או בחלון השלמה מוצגות ראשונות.</p>${riskDeals.map(renderCtonSellerDealCard).join("")}</section>` : ""}
      <section class="cton-card cton-all-deals">
        <h2>${riskDeals.length ? "שאר העסקאות" : "כל העסקאות"}</h2>
        <div class="cton-deal-list">${regularDeals.length ? regularDeals.map(renderCtonSellerDealCard).join("") : `<div class="empty-surface">אין עסקאות נוספות להצגה.</div>`}</div>
      </section>
    </section>
  `;
}

function renderCtonSellerDealCard(item) {
  const progressPct = sellerDealProgressPct(item.metrics, item.threshold_units);
  const chargedUnits = Number(item.metrics?.charged_units ?? item.charged_units ?? 0);
  const pendingUnits = Number(item.metrics?.pending_units ?? item.pending_units ?? Math.max(0, Number(item.metrics?.joined_units || 0) - chargedUnits));
  const notChargedUnits = Number(item.metrics?.not_charged_units ?? item.not_charged_units ?? 0);
  const volume = Number(item.price_per_unit || 0) * Number(item.metrics?.joined_units || 0);
  const image = getPrimaryDealImage(item);
  const isDraft = item.state === "Draft";
  const urgency = sellerDeadlineSignal(item.deadline, item.state);
  const ctaLabel = isDraft ? "בדיקה ופרסום" : ["Charging", "CompletionWindow"].includes(item.state) ? "פתיחת תמונת מצב" : ["Completed", "Failed", "Cancelled"].includes(item.state) ? "צפייה בסיכום" : "ניהול העסקה";
  return `
    <article class="cton-seller-deal-card ${item.state === "CompletionWindow" ? "warning" : ""} ${item.state === "Failed" ? "failed" : ""}">
      ${image?.url ? `<img src="${esc(image.url)}" alt="${esc(item.title)}" />` : `<div class="cton-thumb">${icon("package")}</div>`}
      <div class="cton-seller-deal-main">
        <h3>${esc(item.title)}</h3>
        <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(getDealCopy(item.state).label)}</span>
        ${renderProgressBlock({ stateName: item.state, currentUnits: item.metrics?.joined_units || 0, targetUnits: item.threshold_units, percentValue: progressPct, atRiskUnits: pendingUnits })}
      </div>
      <div class="cton-seller-money">
        <strong>${currency(volume)}</strong>
        ${item.state === "Failed" ? `<p>זה הכסף שלא נכנס</p>` : ""}
        <div class="cton-unit-states">
          <span class="text-success">מחויב: ${num(chargedUnits)}</span>
          <span class="text-warning">בהמתנה: ${num(pendingUnits)}</span>
          <span class="text-muted">לא חויב: ${num(notChargedUnits)}</span>
        </div>
        <span class="countdown-chip"><span>זמן שנותר</span><strong>${esc(urgency.title)}</strong></span>
        <div class="cton-actions compact">
          <a class="button primary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">${ctaLabel}</a>
          ${isDraft ? `<span class="status-note">אין לינק בטיוטה</span>` : `<button class="secondary" type="button" data-inline-action="copy-link" data-share-url="/app/deal/${encodeURIComponent(item.deal_id)}">העתק לינק</button>`}
        </div>
      </div>
    </article>
  `;
}

function renderCtonSellerDealPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) return renderSellerAuthGate();
  const payload = state.sellerDealPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("ניהול העסקה לא זמין", "לא הצלחנו לטעון עכשיו את מסך ניהול העסקה.");
  const deal = payload.deal;
  const copy = getDealCopy(deal.state);
  const snapshot = summarizeSellerParticipants(payload.participants);
  const volume = Number(deal.price_per_unit || 0) * Number(deal.metrics?.joined_units || 0);
  const progressPct = sellerDealProgressPct(deal.metrics, deal.threshold_units);
  const willSucceed = Number(deal.metrics?.joined_units || 0) >= Number(deal.threshold_units || 0);
  const outcomeTone = willSucceed ? "success" : "danger";
  const image = getPrimaryDealImage(deal);
  const isDraft = deal.state === "Draft";
  const isShareable = !isDraft && ["PendingTarget", "TargetReached"].includes(deal.state);
  const publishBlockedByStatus = ["Restricted", "Suspended", "Banned"].includes(payload.seller_profile?.seller_status || state.sellerAuth?.seller_context?.seller_status || "Active");
  const publicDealPath = `/app/deal/${encodeURIComponent(deal.deal_id)}`;
  return `
    <section class="cton-seller-live">
      <header class="cton-card cton-live-header">
        ${image?.url ? `<img src="${esc(image.url)}" alt="${esc(deal.title)}" />` : `<div class="cton-thumb">${icon("package")}</div>`}
        <div><h1>${esc(deal.title)}</h1><span class="badge ${copy.badgeTone}">${esc(copy.label)}</span><p class="muted">${isDraft ? "טיוטה פנימית - עדיין לא פתוחה לקונים" : "מעודכן לפני רגע"}</p></div>
      </header>
      ${renderDealImageGallery(deal)}
      ${isDraft ? `<section class="cton-card cton-actions-panel draft-private-notice"><h2>העסקה נשמרה כטיוטה</h2><p>היא עדיין לא פורסמה. כדי שאנשים יוכלו להצטרף, יש לפרסם אותה.</p>${payload.seller_actions.can_publish && !publishBlockedByStatus ? `<form data-action="seller-publish" data-deal-id="${esc(deal.deal_id)}" class="stack">${renderSellerPublishLegalAcceptance()}<button class="primary" type="submit">פרסם עסקה</button></form>` : `<button class="primary" type="button" disabled>פרסום חסום זמנית</button>`}<div class="cton-actions compact"><a class="button secondary" href="/app/seller/new" data-nav="/app/seller/new">המשך עריכה</a><a class="button secondary" href="/app/seller" data-nav="/app/seller">חזרה לדשבורד</a></div></section>` : `<section class="cton-card cton-actions-panel tone-success"><h2>העסקה פורסמה והיא פתוחה להצטרפות</h2><p class="mono">${esc(absoluteUrl(publicDealPath))}</p>${renderShareActions(publicDealPath, deal.title)}<a class="button primary" href="${publicDealPath}" data-nav="${publicDealPath}">פתיחת הדף הציבורי</a><a class="button secondary" href="/app/seller/deals/${encodeURIComponent(deal.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(deal.deal_id)}">ניהול עסקה</a></section>`}
      <section class="cton-kpi-grid six">
        <article class="cton-kpi"><span>כמות נוכחית</span><strong>${num(deal.metrics?.joined_units || 0)}</strong></article>
        <article class="cton-kpi"><span>מינימום</span><strong>${num(deal.threshold_units)}</strong></article>
        <article class="cton-kpi success"><span>מחויב סופית</span><strong>${num(snapshot.charged)}</strong></article>
        <article class="cton-kpi warning"><span>בהמתנה</span><strong>${num(snapshot.pending)}</strong></article>
        <article class="cton-kpi"><span>לא חויב</span><strong>${num(snapshot.unresolved)}</strong></article>
        <article class="cton-kpi"><span>נפח עסקה</span><strong>${currency(volume)}</strong></article>
      </section>
      ${renderCtonProgressCard({ title: "התקדמות העסקה", stateName: deal.state, currentUnits: deal.metrics?.joined_units || 0, targetUnits: deal.threshold_units, maxUnits: deal.max_units, deadline: deal.deadline, percentValue: progressPct, atRiskUnits: snapshot.pending })}
      <section class="cton-card cton-outcome ${outcomeTone}">
        <h2>אם זה יסתיים עכשיו</h2>
        <strong>${willSucceed ? "העסקה תיסגר בהצלחה" : "העסקה תיכשל"}</strong>
      </section>
      <section class="cton-card cton-actions-panel">
        ${["Charging", "CompletionWindow"].includes(deal.state)
          ? `<p>העסקה נעולה לצפייה בלבד. כל הפעולות מתבצעות אוטומטית.</p>`
          : isDraft
            ? `<p>העסקה עדיין בטיוטה. פרסמו אותה כדי לקבל לינק לשיתוף.</p>`
            : isShareable ? `<button class="secondary" type="button" data-inline-action="copy-link" data-share-url="/app/deal/${encodeURIComponent(deal.deal_id)}">העתק לינק</button>` : `<p>השיתוף אינו זמין במצב הנוכחי.</p>`}
      </section>
      <section class="cton-card cton-timeline"><h2>Timeline</h2><div><span>פורסמה</span><span>יעד הושג</span><span>נסגרה להצטרפות</span><span>חיובים</span><span>השלמה</span><span>סיום</span></div></section>
    </section>
  `;
}

function adjustJoinQty(delta) {
  const current = Number(state.form.qty || 1);
  const next = Math.max(1, current + Number(delta || 0));
  state.form.qty = String(next);
  const input = document.querySelector('input[name="qty"]');
  if (input) input.value = state.form.qty;
  render();
}

function renderHomeLegacy() {
  const payload = state.homePayload?.site;
  const preview = state.previewMeta?.preview;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">האתר הראשי של C-ton</span>
        <h1>פותחים עסקה, מעלים דף אישי, ומפיצים לינק ישיר לקונים</h1>
        <p class="muted">
          C-ton היא פלטפורמה לעסקאות קבוצתיות מבוססות לינק. האתר הראשי הוא שער העבודה למוכר: מכאן פותחים עסקה, מפרסמים דף ציבורי אישי, ומפיצים לינק ישיר שדרכו הקונים מצטרפים.
        </p>
        <div class="actions">
          <a class="button primary" href="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}" data-nav="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}">פתיחת עסקה חדשה</a>
          <a class="button secondary" href="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}" data-nav="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}">ניהול העסקאות שלי</a>
        </div>
        <div class="summary-item">
          <span class="muted">נקודת הכניסה של הקונה</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
          <p class="small muted">${esc(payload?.buyer_entry_note || "הקונה נכנס ישירות לדף העסקה דרך לינק אישי שנשלח אליו.")}</p>
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
      <h2>מה קורה בפועל</h2>
      <div class="card-list">${(payload?.core_surfaces || []).map((item) => `<article class="summary-item"><strong>${esc(item)}</strong></article>`).join("")}</div>
    </section>
  `;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">מסלול הקונה של C-ton</span>
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
  const remainingToTarget = Math.max(0, Number(deal.threshold_units || 0) - Number(metrics.joined_units || 0));
  if (availability.canJoin && remainingToTarget > 0) {
    nextAction.cta = `הצטרפו עכשיו – עוד ${num(remainingToTarget)} יחידות ליעד`;
  } else if (availability.canJoin && deal.state === "TargetReached") {
    nextAction.cta = "הצטרפו עכשיו – העסקה יוצאת לפועל";
  }
  const flow = getFlow(deal.deal_id);
  const affiliateRef = currentAffiliateRef() || flow?.affiliateRef || "";
  const deliveryOptions = getDeliveryOptions(state.dealPayload);
  const selectedDelivery = getSelectedDeliveryOption(state.dealPayload, state.form.deliveryOptionId);
  const deliveryIssue = validateDeliveryChoice(state.dealPayload, state.form.deliveryOptionId);
  const holdTotal = calcHoldTotal(state.dealPayload, qty, selectedDelivery);
  const availabilityBanner = renderDealAvailabilityBanner(availability, metrics, nextAction);

  return `
    <section class="hero product-hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">עסקה ציבורית</span>
        <span class="badge ${dealCopy.badgeTone}">${dealCopy.label}</span>
        <div class="deal-hero-layout">
          ${renderDealVisual(deal.title, deliveryOptions, selectedDelivery, getPrimaryDealImage(deal))}
          <div class="stack deal-hero-copy">
            <h1>${esc(deal.title)}</h1>
            <p class="muted">${availability.message || dealCopy.description}</p>
            ${availabilityBanner}
            <div class="summary-grid deal-story-grid">
              <div class="summary-item summary-spotlight">
                <span class="muted">מה מקבלים בעסקה</span>
                <strong>${currency(deal.price_per_unit)} ליחידה</strong>
                <p class="small muted">דף העסקה מרכז את הפרטים, הקצב ואופן ההצטרפות בלי עומס טכני.</p>
              </div>
              <div class="summary-item">
                <span class="muted">אופני קבלה</span>
                <strong>${num(deliveryOptions.length)}</strong>
                <p class="small muted">${selectedDelivery ? esc(selectedDelivery.label) : "ניתן לבחור אופן קבלה בשלב ההצטרפות."}</p>
              </div>
            </div>
          </div>
        </div>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">כניסה לעסקה</span><strong>רק דרך לינק ישיר</strong></div>
          <div class="trust-point"><span class="muted">בשלב הזה</span><strong>תפיסת מסגרת בלבד</strong></div>
          <div class="trust-point"><span class="muted">חיוב בפועל</span><strong>רק אם העסקה תושלם</strong></div>
        </div>
        <div class="info-strip trust-box">
          <strong>בהצטרפות תתבצע תפיסת מסגרת בלבד</strong>
          <p class="small">חיוב בפועל יתבצע רק אם העסקה תיסגר בהצלחה לפי תנאי העסקה.</p>
        </div>
        ${(() => {
          const s = deal.seller;
          if (!s || !s.business_name) return '';
          const waNum = s.support_phone ? String(s.support_phone).replace(/\D/g, '') : null;
          const waUrl = waNum ? 'https://wa.me/' + waNum : null;
          const contactLinks = [
            waUrl ? `<a href="${esc(waUrl)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : '',
            s.support_email ? `<a href="mailto:${esc(s.support_email)}">${esc(s.support_email)}</a>` : ''
          ].filter(Boolean).join(' | ');
          return `
            <div class="info-strip seller-info-card">
              <strong>נמכר על ידי: ${esc(s.business_name)}</strong>
              ${s.business_description ? `<p class="small muted">${esc(s.business_description)}</p>` : ''}
              ${contactLinks ? `<p class="small">שאלות? צרו קשר עם המוכר: ${contactLinks}</p>` : ''}
            </div>
          `;
        })()}
        ${renderShareActions(`/app/deal/${deal.deal_id}`, deal.title)}
        <div class="metric-grid">
          <div class="metric"><span class="muted">מחיר ליחידה</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="metric"><span class="muted">כמות שכבר נרשמה</span><strong>${num(metrics.joined_units)} יח'</strong></div>
          <div class="metric"><span class="muted">קיבולת שנותרה</span><strong>${num(metrics.remaining_units)} יח'</strong></div>
        </div>
        ${renderProgressBlock({
          stateName: deal.state,
          currentUnits: metrics.joined_units,
          targetUnits: deal.threshold_units,
          percentValue: metrics.progress_to_minimum_pct ?? ((Number(metrics.joined_units || 0) / Math.max(1, Number(deal.threshold_units || 1))) * 100)
        })}
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">יעד בסיס לעסקה</span><strong>${num(deal.threshold_units)} יח'</strong><p class="small muted">העסקה תיחשב מוצלחת אם יחויבו בפועל לפחות 90% מכמות המינימום. אם פחות מכך יחויב בפועל, העסקה תיכשל והכספים יטופלו לפי מדיניות ההחזרים.</p></div>
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
        <div class="summary-grid">
          <div class="summary-item">
            <span class="muted">מצב העסקה</span>
            <strong>${dealCopy.label}</strong>
            <p class="small muted">${availability.message || dealCopy.description}</p>
          </div>
          <div class="summary-item">
            <span class="muted">השלב הבא</span>
            <strong>${nextAction.cta}</strong>
            <p class="small muted">${nextAction.description}</p>
          </div>
        </div>
        <div class="cta-panel">
          <strong>הצטרפות מהירה וברורה</strong>
          <p class="small muted">בחר כמות ואופן קבלה, המשך לאימות טלפון, ואז אשר תפיסת מסגרת בלבד.</p>
        </div>
        ${deliveryOptions.length ? `
          <div class="delivery-choice-preview stack compact-section" data-testid="buyer-delivery-options-preview">
            <strong>איפה מקבלים את המוצר?</strong>
            ${deliveryOptions.map((option) => `
              <div class="summary-item">
                <span class="muted">${esc(formatDeliveryTypeLabel(option.option_type))} · ${currency(option.cost || 0)}</span>
                <strong>${esc(option.label)}</strong>
                ${renderDeliveryOptionDetails(option)}
              </div>
            `).join("")}
          </div>
        ` : ""}
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
                ${renderDeliveryOptionDetails(selectedDelivery)}
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
              ${renderDeliveryOptionDetails(selectedDelivery)}
            </div>
          ` : ""}
          <div class="summary-item summary-spotlight">
            <span class="muted">עלות משוערת</span>
            <strong>${currency(holdTotal)}</strong>
            <p class="small muted">${REQUIRED_PAYMENT_NOTICE}</p>
          </div>
          ${selectedDelivery ? `
            <div class="summary-item">
              <span class="muted">פירוט תפיסת המסגרת</span>
              <strong>${currency(holdTotal)}</strong>
              <p class="small muted">${num(Math.max(0, qty))} יח' x ${currency(deal.price_per_unit)} + ${currency(selectedDelivery.cost || 0)} ${esc(selectedDelivery.label)}</p>
              ${renderDeliveryOptionDetails(selectedDelivery)}
            </div>
          ` : ""}
            <div class="info-strip tone-warning trust-box">
              <strong>מה נשמר עכשיו</strong>
              <p class="small">${REQUIRED_PAYMENT_NOTICE}</p>
            </div>
            <div class="mini-legal-note">
              <span class="muted">המידע המחייב זמין תמיד:</span>
              ${renderLegalLinkRow()}
            </div>
            <button class="primary" type="submit" ${availability.canJoin ? "" : "disabled"}>${nextAction.cta}</button>
          </form>
      </aside>
    </section>
    ${renderDealChatSection(deal)}
  `;
}

function progressToneClass(stateName, currentUnits, targetUnits) {
  if (stateName === "CompletionWindow") return "completion-window";
  if (["TargetReached", "Completed"].includes(stateName) || Number(currentUnits || 0) >= Number(targetUnits || 0)) return "target-reached";
  return "pending-target";
}

function buildProgressStatus({ stateName, currentUnits, targetUnits, atRiskUnits }) {
  const current = Math.max(0, Number(currentUnits || 0));
  const target = Math.max(1, Number(targetUnits || 1));
  const remaining = Math.max(0, target - current);
  if (stateName === "CompletionWindow") {
    return `חלון השלמה פתוח, ${num(atRiskUnits || remaining)} יחידות עדיין בסיכון`;
  }
  if (remaining <= 0 || ["TargetReached", "Completed"].includes(stateName)) {
    return "היעד הושג, העסקה יוצאת לפועל";
  }
  return `עוד ${num(remaining)} יחידות והעסקה יוצאת לפועל`;
}

function renderProgressBlock({ stateName, currentUnits, targetUnits, percentValue, atRiskUnits, label = "התקדמות העסקה" }) {
  const current = Math.max(0, Number(currentUnits || 0));
  const target = Math.max(1, Number(targetUnits || 1));
  const pct = Math.max(0, Math.min(100, Number(percentValue ?? ((current / target) * 100))));
  const tone = progressToneClass(stateName, current, target);
  return `
    <div class="progress-block">
      <div class="progress-headline">
        <strong>${num(current)} / ${num(target)} יחידות</strong>
        <strong>${percent(pct)}</strong>
      </div>
      <div class="meter ${tone}" aria-label="${esc(label)}">
        <span style="width:${Math.max(2, pct)}%"></span>
      </div>
      <p class="progress-status">${buildProgressStatus({ stateName, currentUnits: current, targetUnits: target, atRiskUnits })}</p>
    </div>
  `;
}

function renderDealChatSection(deal) {
  const messages = Array.isArray(state.dealChatPayload?.messages) ? state.dealChatPayload.messages : [];
  const dealState = String(deal?.state || "");
  const isClosed = state.dealChatStatus === "closed" || !["PendingTarget", "TargetReached", "ClosedForJoining"].includes(dealState);
  const closedMessage = getDealChatClosedMessage(dealState);
  return `
    <section class="card section stack deal-chat" aria-labelledby="deal-chat-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">שיח על העסקה</span>
          <h2 id="deal-chat-title">שאלות ועדכונים מהמשתתפים</h2>
        </div>
        <span class="badge ${isClosed ? "tone-warning" : "tone-success"}">${isClosed ? "סגור לכתיבה" : "פתוח"}</span>
      </div>
      <div class="deal-chat-list" aria-live="polite">
        ${messages.length ? messages.map(renderDealChatMessage).join("") : `<div class="empty-surface"><p class="muted">עדיין אין הודעות בעסקה הזאת</p></div>`}
      </div>
      ${isClosed ? `
        <div class="info-strip tone-warning"><strong>${closedMessage}</strong></div>
      ` : `
        <form data-action="deal-chat-send" class="deal-chat-form">
          <div class="field">
            <label for="chatDisplayName">שם לתצוגה</label>
            <input id="chatDisplayName" name="chatDisplayName" type="text" maxlength="80" value="${esc(state.form.chatDisplayName || "")}" placeholder="משתתף" autocomplete="name" />
          </div>
          <div class="field deal-chat-body-field">
            <label for="chatBody">כתבו שאלה או עדכון קצר</label>
            <textarea id="chatBody" name="chatBody" maxlength="500" rows="3" placeholder="יש אפשרות לאיסוף עצמי?">${esc(state.form.chatBody || "")}</textarea>
          </div>
          <button class="primary" type="submit">שלח הודעה</button>
        </form>
      `}
    </section>
  `;
}

function getDealChatClosedMessage(dealState) {
  if (dealState === "Draft") return "הצ׳אט ייפתח אחרי פרסום העסקה";
  if (["ReadyForCharging", "Charging", "CompletionWindow"].includes(dealState)) return "הצ׳אט נסגר כי העסקה עברה למסלול חיוב";
  return "הצ׳אט נסגר כי העסקה הסתיימה";
}

function renderDealChatMessage(message) {
  return `
    <article class="deal-chat-message">
      <div class="deal-chat-message-head">
        <strong>${esc(message.display_name || "משתתף")}</strong>
        <span class="small muted">${dt(message.created_at)}</span>
      </div>
      <p>${esc(message.body || "")}</p>
    </article>
  `;
}

function renderExistingFlow(flow, dealId) {
  const continueHref = flow.participantId
    ? (flow.trackingUrl || `/app/track/${encodeURIComponent(flow.participantId)}`)
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
  return `
    <section class="payment-screen">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">שלב 2 מתוך 3</span>
        <h1>אישור הצטרפות לעסקה</h1>
        <div class="actions">
          <strong class="big-money">${currency(holdTotal)}</strong>
          <span class="badge pending">תפיסת מסגרת בלבד</span>
        </div>
        <p class="muted">לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה. אם העסקה לא תיסגר, מסגרת האשראי משתחררת אוטומטית ללא חיוב.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">מה קורה עכשיו</span><strong>אישור מסגרת בלבד</strong></div>
          <div class="trust-point"><span class="muted">מה לא קורה עכשיו</span><strong>אין חיוב בפועל</strong></div>
          <div class="trust-point"><span class="muted">מתי כן יחויב</span><strong>רק אם העסקה תושלם</strong></div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(deal?.title || flow.dealTitle || "")}</strong></div>
          <div class="summary-item"><span class="muted">קונה מאומת</span><strong>${esc(flow.buyerId || "")}</strong></div>
          <div class="summary-item"><span class="muted">מחיר ליחידה</span><strong>${currency(Number(deal?.price_per_unit ?? flow.unitPrice ?? 0))}</strong></div>
          <div class="summary-item"><span class="muted">כמות</span><strong>${num(flow.qty || 0)} יח'</strong></div>
          <div class="summary-item"><span class="muted">משלוח</span><strong>${currency(deliveryCost)}</strong><p class="small muted">${esc(deliveryLabel)}</p></div>
          <div class="summary-item"><span class="muted">סך הכול לתפיסת מסגרת</span><strong>${currency(holdTotal)}</strong></div>
        </div>
          <div class="summary-item">
            <span class="muted">עדכון אחרון למסלול</span>
            <strong>${relativeTime(flow.updatedAt)}</strong>
            <p class="small muted">כך אפשר להבין אם אתה ממשיך מסלול טרי או חוזר אליו אחרי הפסקה.</p>
          </div>
          ${renderLegalReferenceStrip("payment")}
          <div class="info-strip trust-box">
            <strong>אישור תפיסת מסגרת</strong>
            <p class="small">${PAYMENT_READINESS.settlementModel}. ${PAYMENT_READINESS.integrationNote}</p>
        </div>
        <div class="summary-item summary-spotlight">
          <span class="muted">סך הכול לתפיסת מסגרת</span>
          <strong>${currency(holdTotal)}</strong>
          <p class="small muted">זה הסכום שיישמר כתפיסת מסגרת בשלב הזה. לא מתבצע חיוב כעת; חיוב בפועל יתבצע רק אם העסקה תיסגר בהצלחה.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="info-strip tone-warning">
          <strong>תפיסת מסגרת בלבד</strong>
          <p class="small">לא מתבצע חיוב בפועל עכשיו. הסכום יתפוס מסגרת אשראי בלבד, והחיוב יתבצע רק אם העסקה תיסגר בהצלחה.</p>
        </div>
        <div class="cta-panel">
          <strong>שקט ובהיר לפני אישור</strong>
          <p class="small muted">זה המסך האחרון לפני שמירת ההצטרפות. אחרי האישור תעבור מיד למסך הצלחה ומעקב.</p>
        </div>
        <form data-action="pay" class="credit-card-box">
          ${flow.deliveryMethodType === "shipping" ? `
            <div class="info-strip"><strong>פרטי משלוח</strong><p class="small">הפרטים ישמרו ויועברו למוכר לאחר השלמת העסקה. האספקה באחריות המוכר.</p></div>
            <div class="field"><label for="buyerName">שם מקבל</label><input id="buyerName" name="buyerName" type="text" data-dir="rtl" autocomplete="name" /></div>
            <div class="inline-fields">
              <div class="field"><label for="deliveryAddress">רחוב ומספר *</label><input id="deliveryAddress" name="deliveryAddress" type="text" data-dir="rtl" required autocomplete="street-address" /></div>
              <div class="field"><label for="deliveryCity">עיר *</label><input id="deliveryCity" name="deliveryCity" type="text" data-dir="rtl" required autocomplete="address-level2" /></div>
            </div>
            <div class="field"><label for="deliveryNote">הערה למשלוח (אופציונלי, עד 200 תווים)</label><textarea id="deliveryNote" name="deliveryNote" data-dir="rtl" maxlength="200" rows="2"></textarea></div>
          ` : flow.deliveryMethodType === "pickup" ? `
            <div class="info-strip tone-success"><strong>איסוף עצמי</strong><p class="small">פרטי האיסוף יועברו ישירות מהמוכר לאחר השלמת העסקה.</p></div>
          ` : ""}
          <div class="info-strip trust-box" aria-live="polite">
            <strong>פרטי האשראי מוזנים אצל ספק הסליקה</strong>
            <p class="small">C-ton אינה מציגה ואינה שומרת פרטי כרטיס גולמיים. בלחיצה על האישור יופעל רכיב ספק מאובטח או הפניה מאובטחת, והמערכת תשמור רק מזהה תפעולי של תפיסת המסגרת.</p>
          </div>
          <div class="field"><label for="payerName">שם למשלם/ת</label><input id="payerName" name="payerName" type="text" data-dir="rtl" value="${esc(state.form.payerName)}" autocomplete="name" /></div>
          <input type="hidden" id="providerPaymentMethodId" name="providerPaymentMethodId" value="" />
          ${renderBuyerPaymentLegalAcceptance()}
          <button class="primary" type="submit">אשרו תפיסת מסגרת</button>
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

  const trackingHref = flow.trackingUrl || `/app/track/${encodeURIComponent(flow.participantId)}`;
  return `
    <section class="success-screen">
      <article class="card hero-main stack hero-emphasis success-surface">
        <span class="eyebrow">שלב 3 מתוך 3</span>
        <span class="success-icon" aria-hidden="true">✓</span>
        <span class="badge success">${REQUIRED_SUCCESS_HEADLINE}</span>
        <h1>${REQUIRED_SUCCESS_HEADLINE}</h1>
        <p class="muted">המסגרת נתפסה. לא בוצע חיוב בפועל. החיוב יתבצע רק אם העסקה תיסגר בהצלחה.</p>
        <div class="tracking-next-panel">
          <span class="muted">מה קרה עד עכשיו</span>
          <strong>הצטרפות נשמרה ונתפסה מסגרת</strong>
          <p class="small muted">הצטרפת לעסקה. המסגרת נתפסה, אך לא בוצע חיוב בפועל. ${REQUIRED_CHARGE_CONDITION}. ${REQUIRED_RELEASE_NOTICE}.</p>
        </div>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">הצטרפות</span><strong>נשמרה בהצלחה</strong></div>
          <div class="trust-point"><span class="muted">תפיסת מסגרת</span><strong>אושרה ונשמרה</strong></div>
          <div class="trust-point"><span class="muted">השלב הבא</span><strong>מעקב עד סגירת העסקה</strong></div>
        </div>
          <div class="summary-grid">
            <div class="summary-item"><span class="muted">סטטוס ההצטרפות</span><strong>שמורה במערכת</strong></div>
            <div class="summary-item"><span class="muted">סטטוס המסגרת</span><strong>תפיסת מסגרת בלבד</strong></div>
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
        <div class="summary-grid">
          <div class="summary-item">
            <span class="muted">עדיין אין חיוב בפועל</span>
            <strong>רק אישור מסגרת</strong>
            <p class="small muted">הפרש החשוב הוא בין תפיסת מסגרת לבין חיוב אמיתי.</p>
          </div>
          <div class="summary-item">
            <span class="muted">מה כדאי לעשות עכשיו</span>
            <strong>לשמור את מסך המעקב</strong>
            <p class="small muted">אם יש ערך לשיתוף, כדאי לשלוח את קישור המעקב לעצמך.</p>
          </div>
        </div>
        <div class="cta-panel success-panel">
          <strong>העסקה שלך כבר בתוך המערכת</strong>
          <p class="small muted">שמור את מסך המעקב, ושלח אותו לעצמך או למי שצריך לעקוב אחרי הסטטוס.</p>
        </div>
        ${flow.authorizationId && flow.authorizationMessage ? `
          <div class="summary-item">
            <span class="muted">הודעת אישור המסגרת</span>
            <p class="small">${esc(flow.authorizationMessage)}</p>
          </div>
        ` : ""}
        <div class="info-strip trust-box stack">
          <strong>עזרת לעסקה להתקדם</strong>
          <p class="small muted">שתפו עם חברים כדי שנגיע ליעד ביחד.</p>
          ${renderShareActions(trackingHref, flow.dealTitle || "מעקב השתתפות ב-C-ton")}
        </div>
        <div class="summary-item">
          <span class="muted">המסלול עודכן</span>
          <strong>${relativeTime(flow.updatedAt)}</strong>
        </div>
        <div class="actions">
          <a class="button primary" href="${trackingHref}" data-nav="${trackingHref}">למסך המעקב</a>
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
  const focusCards = buildTrackingFocusCards(tracking);
  const timeline = buildTrackingTimeline(tracking);
  const tone = trackingStatusTone(tracking);
  const supportNote = buildTrackingSupportNote(tracking);
  const documentVisibility = buildTrackingDocumentVisibility(tracking);
  const progress = tracking.progress || {};
  const dealStatus = tracking.deal_status || { title: dealState.label, detail: dealState.description, live: false };
  const personalStatus = tracking.personal_status || buildTrackingPersonalCardFallback(tracking);
  const activityFeed = Array.isArray(tracking.activity_feed) ? tracking.activity_feed : [];
  const chartPoints = Array.isArray(tracking.chart_points) ? tracking.chart_points : [];
  const progressPct = Math.max(0, Math.min(100, Number(progress.progress_to_minimum_pct || 0)));
  const capacityPct = Math.max(0, Math.min(100, Number(progress.progress_to_capacity_pct || 0)));
  const image = tracking.image;
  const liveCopy = tracking.live?.mechanism === "polling"
    ? `מתעדכן חי כל ${num(Math.round(Number(tracking.live.interval_ms || TRACKING_POLL_INTERVAL_MS) / 1000))} שניות`
    : "מתעדכן חי";
  const ctaHref = personalStatus.cta?.href === "deal"
    ? `/app/deal/${encodeURIComponent(tracking.deal_id)}`
    : personalStatus.cta?.href;
  const ctaLabel = personalStatus.cta?.label || "צפייה בפרטי העסקה";

  return `
    <section class="hero tracking-command-center">
      <article class="card hero-main stack hero-emphasis tracking-command-hero">
        <div class="tracking-hero-top">
          <div class="stack compact compact-section">
            <span class="eyebrow">מרכז מעקב קונה חי</span>
            <span class="badge ${dealState.badgeTone}">${dealState.label}</span>
            <h1>${esc(tracking.deal_title)}</h1>
            <p class="muted">${esc(dealStatus.detail || next.summary)}</p>
          </div>
          ${image?.url ? `<img class="tracking-hero-image" src="${esc(image.url)}" alt="תמונת מוצר עבור ${esc(tracking.deal_title || "העסקה")}" />` : ""}
        </div>
        <div class="tracking-live-strip" aria-live="polite">
          <span class="live-dot" aria-hidden="true"></span>
          <strong>${esc(dealStatus.title || dealState.label)}</strong>
          <span class="muted">${esc(liveCopy)} · עודכן ${relativeTime(tracking.live?.generated_at || state.trackingPayload.generated_at)}</span>
        </div>
        <div class="tracking-progress-panel">
          ${renderProgressBlock({
            stateName: tracking.deal_state,
            currentUnits: progress.current_units || 0,
            targetUnits: progress.target_units || tracking.threshold_units || 1,
            percentValue: progressPct,
            atRiskUnits: progress.remaining_to_minimum || 0,
            label: "התקדמות העסקה למינימום"
          })}
          <div class="tracking-counter-grid">
            <div class="summary-item summary-spotlight"><span class="muted">יחידות כרגע</span><strong>${num(progress.current_units || 0)}</strong><p class="small muted">מתוך יעד בסיס של ${num(progress.target_units || tracking.threshold_units || 0)}</p></div>
            <div class="summary-item"><span class="muted">משתתפים</span><strong>${num(progress.participants_count || 0)}</strong><p class="small muted">אנונימי, ללא שמות או פרטים אישיים</p></div>
            <div class="summary-item"><span class="muted">נשאר עד מקסימום</span><strong>${num(progress.remaining_to_capacity || 0)}</strong><p class="small muted">${percent(capacityPct)} מתוך קיבולת כוללת</p></div>
            <div class="summary-item"><span class="muted">חלון הצטרפות</span><strong>${dt(tracking.deadline)}</strong><p class="small muted">${tracking.completion_window_until ? `חלון השלמה עד ${dt(tracking.completion_window_until)}` : "הדדליין נשמר לפי העסקה"}</p></div>
          </div>
        </div>
        <div class="tracking-live-layout">
          <section class="tracking-chart-card stack" aria-label="גרף התקדמות מצטברת">
            <div class="section-header">
              <div class="stack compact compact-section">
                <h2>גרף התקדמות חי</h2>
                <p class="muted section-intro">יחידות מצטברות לאורך זמן, לפי הצטרפויות אמיתיות בלבד.</p>
              </div>
              <span class="stat-pill"><span>יעד</span><strong>${num(progress.target_units || tracking.threshold_units || 0)}</strong></span>
            </div>
            ${renderTrackingProgressChart(chartPoints, progress)}
          </section>
          <section class="tracking-activity-card stack" aria-label="פעילות אנונימית בעסקה">
            <div class="section-header">
              <div class="stack compact compact-section">
                <h2>פעילות חיה בעסקה</h2>
                <p class="muted section-intro">עדכונים אמיתיים, בלי שמות קונים ובלי מידע אישי.</p>
              </div>
            </div>
            ${renderTrackingActivityFeed(activityFeed)}
          </section>
        </div>
        <section class="tracking-personal-card ${personalStatus.action_required ? "tone-warning" : tone} stack" aria-label="סטטוס אישי">
          <div class="section-header">
            <div class="stack compact compact-section">
              <span class="eyebrow">הסטטוס שלך</span>
              <h2>${esc(personalStatus.title || buyerState[0])}</h2>
              <p class="muted section-intro">${esc(personalStatus.detail || buyerState[1])}</p>
            </div>
            <span class="badge ${personalStatus.action_required ? "warning" : "success"}">${personalStatus.action_required ? "נדרשת פעולה" : "אין פעולה נדרשת"}</span>
          </div>
          <div class="tracking-counter-grid compact-counters">
            <div class="summary-item"><span class="muted">הכמות שלך</span><strong>${num(tracking.qty)} יח'</strong></div>
            <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${esc(tracking.delivery_method_label || "לא זמין")}</strong><p class="small muted">${esc(formatDeliveryTypeLabel(tracking.delivery_method_type || ""))}</p></div>
            <div class="summary-item"><span class="muted">מצב השתתפות</span><strong>${esc(buyerState[0])}</strong><p class="small muted">${esc(buyerState[1])}</p></div>
            <div class="summary-item"><span class="muted">מצב כספי</span><strong>${esc(moneyState[0])}</strong><p class="small muted">${esc(moneyState[1])}</p></div>
          </div>
          <div class="actions">
            ${personalStatus.action_required && ctaHref ? `<a class="button primary" href="${esc(ctaHref)}" data-nav="${esc(ctaHref)}">${esc(ctaLabel)}</a>` : `<span class="status-note">כרגע לא נדרשת ממך פעולה</span>`}
            <a class="button secondary" href="/app/deal/${encodeURIComponent(tracking.deal_id)}" data-nav="/app/deal/${encodeURIComponent(tracking.deal_id)}">צפייה בפרטי העסקה</a>
          </div>
        </section>
        <div class="tracking-next-panel ${tone}">
          <span class="muted">מה חשוב עכשיו</span>
          <strong>${next.title}</strong>
          <p class="small muted">${next.detail}</p>
        </div>
        <div class="tracking-focus-grid">
          ${focusCards.map((card) => `
            <div class="summary-item ${card === focusCards[0] ? "summary-spotlight" : ""}">
              <span class="muted">${esc(card.title)}</span>
              <strong>${esc(card.value)}</strong>
              <p class="small muted">${esc(card.detail)}</p>
            </div>
          `).join("")}
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
            <div class="table-panel">
              <div class="table-toolbar">
                <div>
                  <strong>מה קרה עבורך עד עכשיו</strong>
                  <p class="small muted">ציר זמן קצר וברור שמסביר את המצב ללא זרגון.</p>
                </div>
              </div>
              <div class="table-like">
                ${timeline.map((row) => `
                  <div class="table-row">
                    <div class="table-cell"><span class="table-cell-label">${esc(row.label)}</span><span class="table-cell-value">${esc(row.value)}</span></div>
                    <div class="table-cell"><span class="table-cell-label">פירוט</span><span class="table-cell-value">${esc(row.detail)}</span></div>
                  </div>
                `).join("")}
              </div>
            </div>
            <div class="surface-note">
              <strong>${esc(documentVisibility.title)}</strong>
              <p class="small muted">${esc(documentVisibility.detail)}</p>
              ${documentVisibility.documentId ? `<div class="summary-grid">
                <div class="summary-item">
                  <span class="muted">${esc("\u05de\u05d6\u05d4\u05d4 \u05de\u05e1\u05de\u05da")}</span>
                  <strong class="mono">${esc(documentVisibility.documentId)}</strong>
                </div>
                ${documentVisibility.issuedAt ? `<div class="summary-item">
                  <span class="muted">${esc("\u05de\u05d5\u05e2\u05d3 \u05d4\u05e0\u05e4\u05e7\u05d4")}</span>
                  <strong>${dt(documentVisibility.issuedAt)}</strong>
                </div>` : ""}
              </div>` : ""}
            </div>
            ${renderLegalReferenceStrip("tracking")}
          </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight">
          <span class="muted">תמונה חיה</span>
          <strong>${num(progress.current_units || 0)} / ${num(progress.max_units || tracking.max_units || 0)} יח'</strong>
          <p class="small muted">${progress.remaining_to_minimum > 0 ? `${num(progress.remaining_to_minimum)} יחידות למינימום` : "המינימום הושג"}</p>
        </div>
        <div class="summary-item summary-spotlight">
          <span class="muted">תמונת מצב עדכנית</span>
          <strong>${buyerState[0]}</strong>
          <p class="small muted">${moneyState[0]} · ${dealState.label}</p>
        </div>
        <div class="summary-item"><span class="muted">קישור המעקב</span><strong>פרטי וזמין מהדף הזה</strong></div>
        <div class="summary-item"><span class="muted">זיהוי קונה</span><strong>מאומת ומוסתר לצורך פרטיות</strong></div>
        <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${esc(tracking.delivery_method_label || "לא זמין")}</strong></div>
        ${linkedFlow?.lastTrackingViewedAt ? `<div class="summary-item"><span class="muted">צפייה אחרונה במסלול</span><strong>${dt(linkedFlow.lastTrackingViewedAt)}</strong></div>` : ""}
        ${linkedFlow?.updatedAt ? `<div class="summary-item"><span class="muted">סשן ה-flow עודכן</span><strong>${relativeTime(linkedFlow.updatedAt)}</strong></div>` : ""}
        <div class="summary-item"><span class="muted">חלון ההצטרפות</span><strong>${dt(tracking.deadline)}</strong></div>
        ${tracking.completion_window_until ? `<div class="summary-item"><span class="muted">סיום חלון השלמה</span><strong>${dt(tracking.completion_window_until)}</strong></div>` : ""}
        <div class="summary-item">
          <span class="muted">${esc("\u05de\u05e1\u05de\u05da \u05dc\u05e7\u05d5\u05e0\u05d4")}</span>
          <strong>${esc(documentVisibility.shortLabel)}</strong>
          <p class="small muted">${esc(documentVisibility.shortDetail)}</p>
        </div>
        <div class="info-strip ${tone}">
          <strong>האם נדרש ממך משהו?</strong>
          <p class="small">${tracking.buyer_state === "ChargeFailedCompletion" ? "אם יתוסף צעד נדרש, המסך הזה יציג אותו בבהירות." : "כרגע אין צורך בפעולה יזומה מצדך."}</p>
        </div>
        <div class="surface-note">
          <strong>המעקב הזה הוא המקור הקובע</strong>
          <p class="small muted">${esc(supportNote)}</p>
        </div>
        ${renderShareActions(`/app/track/${encodeURIComponent(tracking.participant_id)}`, tracking.deal_title || "מעקב השתתפות ב-C-ton")}
        <div class="actions"><a class="button secondary" href="/app/deal/${encodeURIComponent(tracking.deal_id)}" data-nav="/app/deal/${encodeURIComponent(tracking.deal_id)}">חזרה לעסקה</a></div>
      </aside>
    </section>
  `;
}

function renderRecoveryPage() {
  const route = state.route;
  const participantId = route?.participantId || "";
  const trackingHref = participantId ? `/app/track/${encodeURIComponent(participantId)}` : "/app";
  if (!state.recoveryPayload && state.loading) return "";
  if (!state.recoveryPayload) {
    return renderEmptyState(
      "לא מצאנו את ההשתתפות",
      "ייתכן שהקישור פג או שהמערכת לא הצליחה לטעון את הפרטים. אפשר לחזור למסך המעקב ולנסות שוב."
    );
  }
  const tracking = state.recoveryPayload.tracking;
  const buyerState = tracking?.buyer_state;
  const moneyState = tracking?.money_state;
  const dealState = tracking?.deal_state;
  const completionUntil = tracking?.completion_window_until || "";
  const completionEpoch = completionUntil ? Date.parse(completionUntil) : NaN;
  const windowOpen = dealState === "CompletionWindow" && Number.isFinite(completionEpoch) && completionEpoch > Date.now();
  const isRecoveryState =
    buyerState === "ChargeFailedCompletion" && moneyState === "ChargeFailedRecovery";
  const alreadyRecovered =
    moneyState === "RecoveredCharge" || moneyState === "ChargedSuccess" ||
    buyerState === "Recovered" || buyerState === "ChargedSuccess" || buyerState === "DealCompleted";
  const actionState = state.recoveryActionState || "idle";
  const actionMessage = state.recoveryActionMessage || "";
  const actionTone = state.recoveryActionTone || "";
  const qty = Number(tracking?.qty || 0);
  const completionAmount = Number(tracking?.estimated_total || 0);

  let banner = "";
  if (alreadyRecovered) {
    banner = `<div class="info-strip tone-success"><strong>התשלום כבר הושלם</strong><p class="small">חזרת למסלול העסקה. אין צורך לבצע פעולה נוספת.</p></div>`;
  } else if (!isRecoveryState) {
    banner = `<div class="info-strip"><strong>אין כרגע צורך בהשלמת תשלום</strong><p class="small">הסטטוס שלך לא דורש פעולה במסך הזה. מסך המעקב יציג את התמונה העדכנית.</p></div>`;
  } else if (!windowOpen) {
    banner = `<div class="info-strip tone-warning"><strong>חלון השלמת התשלום נסגר</strong><p class="small">לא ניתן יותר לבצע השלמה. המערכת תסיים את התהליך לפי חוקי העסקה.</p></div>`;
  }

  const canSubmit = isRecoveryState && windowOpen && actionState !== "submitting";
  const submitLabel = actionState === "submitting" ? "שולח בקשה..." : "השלמת תשלום";

  return `
    <section class="hero buyer-recovery-flow">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">השלמת תשלום</span>
        <span class="badge warning">נדרשת פעולה</span>
        <h1>נדרש עדכון אמצעי תשלום</h1>
        <p class="muted">החיוב שלך לא עבר. המקום שלך בעסקה נשמר זמנית, אבל צריך להשלים את התשלום בתוך חלון ההשלמה. בשלב הזה לא ניתן לשנות כמות או לבטל, כדי לשמור על יציבות העסקה לכל המשתתפים.</p>
        ${banner}
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(tracking?.deal_title || "")}</strong></div>
          <div class="summary-item"><span class="muted">כמות שהתחייבת</span><strong>${num(qty)} יח'</strong><p class="small muted">לא ניתן לשנות בשלב הזה</p></div>
          <div class="summary-item summary-spotlight"><span class="muted">סכום ההשלמה</span><strong>${currency(completionAmount)}</strong><p class="small muted">סכום זהה לחיוב המקורי, ללא תוספות</p></div>
          <div class="summary-item"><span class="muted">חלון השלמה עד</span><strong>${completionUntil ? dt(completionUntil) : "לא זמין"}</strong><p class="small muted">${windowOpen ? "ניתן לנסות עוד פעם כל עוד החלון פתוח" : "החלון נסגר"}</p></div>
        </div>
        ${actionMessage ? `<div class="info-strip ${esc(actionTone)}"><strong>${esc(actionState === "succeeded" ? "ניסיון ההשלמה נשלח" : "סטטוס ההשלמה")}</strong><p class="small">${esc(actionMessage)}</p></div>` : ""}
        <form data-action="recovery-submit" data-participant-id="${esc(participantId)}" class="stack recovery-action-form">
          <div class="info-strip">
            <strong>הבהרה חשובה</strong>
            <p class="small">הפעולה הזו מבצעת ניסיון השלמת תשלום בלבד עבור ההתחייבות הקיימת. לא נפתחת עסקה חדשה, ואין שינוי בכמות. אנחנו לא קולטים פרטי כרטיס אשראי במסך הזה — המערכת משתמשת באישור המסגרת השמור.</p>
          </div>
          <div class="actions">
            <button class="primary" type="submit" ${canSubmit ? "" : "disabled"}>${submitLabel}</button>
            <a class="button secondary" href="${esc(trackingHref)}" data-nav="${esc(trackingHref)}">חזרה למסך המעקב</a>
          </div>
        </form>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight">
          <span class="muted">מצב נוכחי</span>
          <strong>${esc(getLabel(BUYER_COPY, buyerState)[0] || "לא זמין")}</strong>
          <p class="small muted">${esc(getLabel(MONEY_COPY, moneyState)[0] || "")}</p>
        </div>
        <div class="summary-item"><span class="muted">מה לא יקרה כאן</span><strong>שינוי כמות, ביטול, החלפת עסקה</strong><p class="small muted">פעולות אלה אינן זמינות בשלב השלמת התשלום.</p></div>
        <div class="summary-item"><span class="muted">מה כן יקרה</span><strong>ניסיון השלמת חיוב לעסקה הקיימת</strong><p class="small muted">המערכת משתמשת בנתוני האישור השמורים ומבצעת ניסיון מסודר דרך מסלול ההשלמה הקיים.</p></div>
        <div class="surface-note">
          <strong>אם הניסיון נכשל</strong>
          <p class="small muted">לא הצלחנו להשלים את התשלום. אפשר לנסות שוב כל עוד חלון ההשלמה פתוח.</p>
        </div>
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
        <span class="eyebrow">האתר הראשי של C-ton</span>
        <h1>פותחים עסקה, מעלים דף אישי, ומפיצים לינק ישיר לקונים</h1>
        <p class="muted">
          C-ton היא פלטפורמה לעסקאות קבוצתיות מבוססות לינק. האתר הראשי הוא שער העבודה למוכר: מכאן פותחים עסקה, מפרסמים דף ציבורי אישי, ומפיצים לינק ישיר שדרכו הקונים מצטרפים.
        </p>
        <div class="actions">
          <a class="button primary" href="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}" data-nav="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}">פתיחת עסקה חדשה</a>
          <a class="button secondary" href="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}" data-nav="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}">ניהול העסקאות שלי</a>
        </div>
        <div class="summary-item">
          <span class="muted">נקודת הכניסה של הקונה</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
          <p class="small muted">${esc(payload?.buyer_entry_note || "הקונה נכנס ישירות לדף העסקה דרך לינק אישי שנשלח אליו.")}</p>
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
      <h2>מה קורה בפועל</h2>
      <div class="card-list">${(payload?.core_surfaces || []).map((item) => `<article class="summary-item"><strong>${esc(item)}</strong></article>`).join("")}</div>
    </section>
  `;
}

function renderSellerProfileSection() {
  const prof = state.sellerProfile;
  const bizName = String(state.form.sellerBizName || prof?.business_name || "").trim();
  const contactName = String(state.form.sellerContactName || prof?.contact_name || "").trim();
  const phone = String(state.form.sellerSupportPhone || prof?.support_phone || "").trim();
  const email = String(state.form.sellerSupportEmail || prof?.support_email || "").trim();
  const desc = String(state.form.sellerBizDesc || prof?.business_description || "").trim();
  const bizId = String(state.form.sellerBizId || prof?.business_identifier || "").trim();
  const isReady = prof?.is_publish_ready;
  return `
    <section class="card section stack" id="seller-profile-section">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>פרטי המוכר</h2>
          <p class="muted section-intro">פרטים אלה יוצגו לקונים בדף העסקה. יש להשלים לפחות שם עסק ואמצעי קשר אחד לפני פרסום עסקה.</p>
        </div>
        ${isReady === false ? `<span class="badge warning">חסרים פרטים לפרסום</span>` : isReady ? `<span class="badge success">מוכן לפרסום</span>` : ""}
      </div>
      ${isReady === false ? `
        <div class="info-strip tone-warning">
          <strong>פרופיל לא מושלם</strong>
          <p class="small">כדי לפרסם עסקה, יש להשלים שם עסק ולפחות אמצעי קשר אחד (טלפון או אימייל).</p>
        </div>
      ` : ""}
      <form data-action="seller-profile-save" class="form-shell">
        <div class="form-section-card stack">
          <div class="inline-fields">
            <div class="field">
              <label for="sellerBizName">שם העסק <span class="required">*</span></label>
              <input id="sellerBizName" name="sellerBizName" type="text" value="${esc(bizName)}" placeholder="שם העסק שיוצג לקונים" />
            </div>
            <div class="field">
              <label for="sellerContactName">שם איש קשר</label>
              <input id="sellerContactName" name="sellerContactName" type="text" value="${esc(contactName)}" placeholder="שם מלא לפניות" />
            </div>
          </div>
          <div class="inline-fields">
            <div class="field">
              <label for="sellerSupportPhone">טלפון לשאלות</label>
              <input id="sellerSupportPhone" name="sellerSupportPhone" type="tel" value="${esc(phone)}" placeholder="05x-xxxxxxx" />
            </div>
            <div class="field">
              <label for="sellerSupportEmail">אימייל לשאלות</label>
              <input id="sellerSupportEmail" name="sellerSupportEmail" type="email" value="${esc(email)}" placeholder="support@example.com" />
            </div>
          </div>
          <div class="field">
            <label for="sellerBizDesc">תיאור קצר על העסק</label>
            <textarea id="sellerBizDesc" name="sellerBizDesc" rows="3" maxlength="420" placeholder="מי אנחנו ומה אנחנו מוכרים">${esc(desc)}</textarea>
          </div>
          <div class="field">
            <label for="sellerBizId">מזהה עסק (ח.פ / עוסק מורשה)</label>
            <input id="sellerBizId" name="sellerBizId" type="text" value="${esc(bizId)}" placeholder="אופציונלי" />
          </div>
        </div>
        <div class="actions">
          <button class="primary" type="submit">שמירת פרטי מוכר</button>
        </div>
      </form>
    </section>
  `;
}

function renderSellerPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) {
    return renderSellerAuthGate();
  }
  const payload = state.sellerPayload?.seller_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("ניהול העסקאות שלי לא זמין", "לא הצלחנו לטעון עכשיו את ניהול העסקאות.");
  const sellerProfile = payload.seller_profile || currentSellerContext();
  const sellerDisplayName = normalizeSellerDisplayName(sellerProfile.seller_id, sellerProfile.display_name);
  const sellerStatus = sellerProfile.seller_status || state.sellerAuth?.seller_context?.seller_status || "Active";
  const sellerNotice = sellerEnforcementNotice(sellerStatus);
  const canOpenNewDeal = sellerStatus !== "Suspended" && sellerStatus !== "Banned";
  const focus = sellerNextFocus(null, payload.totals);
  const draftDeals = Math.max(
    0,
    Number(payload.totals.total_deals || 0) -
      Number(payload.totals.live_deals || 0) -
      Number(payload.totals.completed_deals || 0) -
      Number(payload.totals.failed_or_cancelled || 0)
  );
  const sellerBoard = classifySellerDeals(payload.deals);
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">ניהול העסקאות שלי</span>
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
        ${sellerNotice ? `<div class="info-strip tone-warning"><strong>${esc(sellerNotice)}</strong></div>` : ""}
        <div class="actions">
          ${canOpenNewDeal ? `<a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">פתיחת עסקה חדשה</a>` : `<button class="primary" type="button" disabled>פתיחת עסקה חדשה חסומה</button>`}
        </div>
        <div class="kpi-strip">
          <div class="kpi-card strong"><span class="muted">עסקאות פעילות עכשיו</span><strong>${num(payload.totals.live_deals)}</strong><p class="small muted">המסכים שדורשים עכשיו הפצה, מעקב או בקרה.</p></div>
          <div class="kpi-card warning"><span class="muted">טיוטות שמחכות לפרסום</span><strong>${num(draftDeals)}</strong><p class="small muted">טיוטות שעדיין אפשר לדייק לפני יציאה ללינק חי.</p></div>
          <div class="kpi-card success"><span class="muted">עסקאות שהושלמו</span><strong>${num(payload.totals.completed_deals)}</strong><p class="small muted">עסקאות שכבר עברו את המסלול המלא בהצלחה.</p></div>
          <div class="kpi-card danger"><span class="muted">נסגרו ללא השלמה</span><strong>${num(payload.totals.failed_or_cancelled)}</strong><p class="small muted">מקום טוב לזהות מהר איפה צריך למנוע חזרה על אותו דפוס.</p></div>
        </div>
        <div class="workspace-focus-grid">
          <div class="summary-item summary-spotlight">
            <span class="muted">מה דורש קשב עכשיו</span>
            <strong>${num(sellerBoard.attention.length)} עסקאות</strong>
            <p class="small muted">עסקאות חיות, חלונות רגישים, ומצבים שצריכים עין מוכר עכשיו.</p>
          </div>
          <div class="summary-item">
            <span class="muted">הכנסה לניהול</span>
            <strong>הרשימה מתחלקת לדחיף, טיוטות וסגור</strong>
            <p class="small muted">כך אפשר להבין מיד איפה לקדם, מה לפרסם, ואיפה לבקר תוצאות.</p>
          </div>
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
    ${renderSellerAnalyticsSection()}
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>פונל העסקאות</h2>
          <p class="muted section-intro">הרשימה מאורגנת לפי דחיפות, טיוטות ועסקאות שכבר נסגרו.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>חיות</span><strong>${num(payload.totals.live_deals)}</strong></span>
          <span class="stat-pill"><span>טיוטות</span><strong>${num(draftDeals)}</strong></span>
          <span class="stat-pill"><span>סה"כ</span><strong>${num(payload.totals.total_deals)}</strong></span>
        </div>
      </div>
      ${payload.deals.length ? `
        ${renderSellerBoardSection("דורשות קשב אישי", "כאן נכנסות עסקאות חיות או מסלולים רגישים.", sellerBoard.attention, "אין כרגע עסקאות דחופות", "זה זמן טוב לפתוח עסקה חדשה או לבדוק טיוטות.")}
        ${renderSellerBoardSection("טיוטות לפרסום", "טיוטות שעדיין ניתן לדייק ולקדם ללינק חי.", sellerBoard.draft, "אין טיוטות לפרסום", "כל העסקאות שלך כבר מצויות במצב חי או סגור.")}
        ${renderSellerBoardSection("עסקאות שנסגרו", "כאן רואים תוצאות, סיכומים והמשך תפעול אם נדרש.", sellerBoard.closed, "אין עסקאות סגורות", "כשעסקה תסתיים, היא תעבור לכאן עם תמונת מצב מלאה.")}
      ` : `
        <div class="empty-surface stack">
          <strong>עדיין לא נפתחה אף עסקה תחת הזהות הזו</strong>
          <p class="small muted">כדאי להתחיל מטיוטה אחת חדה, לפרסם אותה, ולהפיץ לינק אישי ראשון לקונים.</p>
          <div class="actions">${canOpenNewDeal ? `<a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">פתיחת עסקה ראשונה</a>` : `<button class="primary" type="button" disabled>פתיחת עסקה חדשה חסומה</button>`}</div>
        </div>
      `}
    </section>
    ${renderSellerProfileSection()}
  `;
}
function renderSellerAnalyticsSection() {
  const analytics = state.sellerAnalyticsPayload;
  const period = state.sellerAnalyticsPeriod || analytics?.period || "all";
  const periods = [
    ["all", "הכל"],
    ["30d", "30 ימים"],
    ["90d", "90 ימים"],
    ["year", "שנה"]
  ];
  if (state.sellerAnalyticsLoading && !analytics) {
    return `
      <section class="card section stack seller-analytics-section" aria-live="polite">
        <div class="section-header">
          <div class="stack compact compact-section">
            <h2>ביצועי המוכר</h2>
            <p class="muted section-intro">טוען את ביצועי המוכר...</p>
          </div>
        </div>
      </section>
    `;
  }
  if (state.sellerAnalyticsError && !analytics) {
    return `
      <section class="card section stack seller-analytics-section" aria-live="polite">
        <div class="section-header">
          <div class="stack compact compact-section">
            <h2>ביצועי המוכר</h2>
            <p class="muted section-intro">לא הצלחנו לטעון את ביצועי המוכר כרגע.</p>
          </div>
          ${renderSellerAnalyticsPeriodSelector(period, periods)}
        </div>
      </section>
    `;
  }
  if (!analytics) {
    return `
      <section class="card section stack seller-analytics-section">
        <div class="section-header">
          <div class="stack compact compact-section">
            <h2>ביצועי המוכר</h2>
            <p class="muted section-intro">עדיין אין נתוני ביצועים. לאחר פתיחת עסקאות והצטרפות קונים, הנתונים יופיעו כאן.</p>
          </div>
          ${renderSellerAnalyticsPeriodSelector(period, periods)}
        </div>
      </section>
    `;
  }
  const overview = analytics.overview || {};
  const deals = Array.isArray(analytics.deals) ? analytics.deals : [];
  const hasPerformanceData = deals.length > 0 || Number(overview.total_joined_units || 0) > 0;
  return `
    <section class="card section stack seller-analytics-section" aria-live="polite">
      <div class="section-header">
        <div class="stack compact compact-section">
          <span class="eyebrow">מרכז ניתוח מוכר</span>
          <h2>מרכז ניתוח מוכר</h2>
          <p class="muted section-intro">עודכן לאחרונה: ${dt(analytics.generated_at)}</p>
            <p class="small muted">נתוני ייחוס בלבד — אינם מהווים אסמכתא פיננסית או קביעת זכאות לתשלום.</p>
        </div>
        <div class="toolbar-actions">
          ${renderSellerAnalyticsPeriodSelector(period, periods)}
          <button class="secondary" type="button" data-inline-action="seller-analytics-refresh">רענון ידני</button>
        </div>
      </div>
      ${state.sellerAnalyticsError ? `<div class="error-card"><strong>לא הצלחנו לטעון את ביצועי המוכר כרגע.</strong><p class="small muted">הנתונים האחרונים שמורים כאן עד לרענון הבא.</p></div>` : ""}
      ${!hasPerformanceData ? `<div class="empty-surface stack"><strong>עדיין אין נתוני ביצועים.</strong><p class="small muted">לאחר פתיחת עסקאות והצטרפות קונים, הנתונים יופיעו כאן.</p></div>` : ""}
      <div class="seller-analytics-kpis">
        <div class="kpi-card strong"><span class="muted">עסקאות פעילות</span><strong>${analyticsValue(overview.active_deals_count, num)}</strong></div>
        <div class="kpi-card warning"><span class="muted">עסקאות בסיכון</span><strong>${analyticsValue(overview.risk_deals_count, num)}</strong></div>
        <div class="kpi-card"><span class="muted">יחידות שהצטרפו</span><strong>${analyticsValue(overview.total_joined_units, num)}</strong></div>
        <div class="kpi-card"><span class="muted">יחידות שחויבו</span><strong>${analyticsValue(overview.total_charged_units, num)}</strong></div>
        <div class="kpi-card"><span class="muted">ברוטו שנגבה</span><strong>${analyticsValue(overview.gross_collected_amount, currency)}</strong></div>
        <div class="kpi-card success"><span class="muted">נטו למוכר</span><strong>${analyticsValue(overview.seller_net_amount, currency)}</strong></div>
      </div>
      <article class="summary-item seller-analytics-money">
        <h3>תמונת כסף</h3>
        <div class="table-like">
          <div class="table-row"><div class="table-cell"><span class="muted">ברוטו צפוי</span><strong>${analyticsValue(overview.gross_expected_amount, currency)}</strong></div><div class="table-cell"><span class="muted">ברוטו שנגבה</span><strong>${analyticsValue(overview.gross_collected_amount, currency)}</strong></div></div>
          <div class="table-row"><div class="table-cell"><span class="muted">עמלת C-ton</span><strong>${analyticsValue(overview.platform_fee_total_amount, currency)}</strong></div><div class="table-cell"><span class="muted">נטו למוכר</span><strong>${analyticsValue(overview.seller_net_amount, currency)}</strong></div></div>
        </div>
      </article>
      <article class="summary-item">
        <h3>עסקאות</h3>
        ${deals.length ? `<div class="table-like seller-analytics-deals">${deals.map(renderSellerAnalyticsDeal).join("")}</div>` : `<div class="empty-surface stack"><strong>אין עדיין עסקאות להצגה.</strong><p class="small muted">לאחר יצירת עסקה ראשונה, היא תופיע כאן עם מצב, יחידות וסיכון.</p></div>`}
      </article>
    </section>
  `;
}

function analyticsValue(value, formatter = num) {
  if (value === null || value === undefined || value === "") return "לא נאסף עדיין";
  return formatter(value);
}

function renderSellerAnalyticsDeal(deal) {
  const risk = sellerAnalyticsRiskCopy(deal.risk_level);
  return `
    <div class="table-row seller-analytics-deal-row">
      <div class="table-cell"><span class="muted">עסקה</span><strong>${esc(deal.title || "עסקה ללא שם")}</strong><span class="small muted">${esc(deal.status_label || getDealCopy(deal.state).label)}</span></div>
      <div class="table-cell"><span class="muted">סיכון</span><strong class="badge ${risk.tone}">${esc(risk.label)}</strong>${Array.isArray(deal.risk_reasons) && deal.risk_reasons.length ? `<span class="small muted">${esc(deal.risk_reasons.join(" · "))}</span>` : ""}</div>
      <div class="table-cell"><span class="muted">התקדמות למינימום</span><strong>${percent(deal.progress_to_minimum_percent)}</strong><span class="small muted">${analyticsValue(deal.current_units, num)} מתוך ${analyticsValue(deal.min_units, num)}</span></div>
      <div class="table-cell"><span class="muted">יחידות</span><strong>${analyticsValue(deal.current_units, num)} הצטרפו</strong><span class="small muted">${analyticsValue(deal.charged_units, num)} חויבו · ${analyticsValue(deal.pending_units, num)} בהמתנה</span></div>
      <div class="table-cell"><span class="muted">ברוטו</span><strong>${analyticsValue(deal.gross_collected_amount, currency)}</strong><span class="small muted">צפוי ${analyticsValue(deal.gross_expected_amount, currency)}</span></div>
      <div class="table-cell"><span class="muted">דדליין</span><strong>${dt(deal.deadline)}</strong></div>
    </div>
  `;
}

function sellerAnalyticsRiskCopy(level) {
  const map = {
    low: { label: "נמוך", tone: "success" },
    medium: { label: "בינוני", tone: "warning" },
    high: { label: "גבוה", tone: "danger" },
    completed: { label: "הושלמה", tone: "success" },
    failed: { label: "נכשלה", tone: "danger" }
  };
  return map[level] || map.low;
}

function sellerEnforcementNotice(status) {
  if (status === "Restricted") return "חשבונך מוגבל זמנית מפרסום עסקאות חדשות. עסקאות קיימות אינן משתנות אוטומטית.";
  if (status === "Suspended") return "חשבונך הושעה זמנית מפעולות מוכר.";
  if (status === "Banned") return "חשבונך חסום מפעולות מוכר.";
  return "";
}

function renderSellerAnalyticsPeriodSelector(currentPeriod, periods) {
  return `
    <div class="segmented-control" role="group" aria-label="בחירת תקופה לביצועי המוכר">
      ${periods.map(([value, label]) => `<button class="${currentPeriod === value ? "active" : ""}" type="button" data-inline-action="seller-analytics-period" data-period="${esc(value)}">${esc(label)}</button>`).join("")}
    </div>
  `;
}

function renderSellerAnalyticsTopDeal(deal) {
  return `
    <div class="table-row">
      <div class="table-cell"><span class="muted">שם עסקה</span><strong>${esc(deal.title || "עסקה ללא שם")}</strong></div>
      <div class="table-cell"><span class="muted">ברוטו</span><strong>${currency(deal.gross_amount)}</strong></div>
      <div class="table-cell"><span class="muted">נטו למוכר</span><strong>${currency(deal.seller_net_amount)}</strong></div>
      <div class="table-cell"><span class="muted">יחידות שחויבו</span><strong>${num(deal.charged_units)}</strong></div>
      <div class="table-cell"><span class="muted">קונים</span><strong>${num(deal.buyers_count)}</strong></div>
      <div class="table-cell"><span class="muted">הושלמה</span><strong>${dt(deal.completed_at)}</strong></div>
    </div>
  `;
}

function renderSellerAnalyticsWeakDeal(deal) {
  const issueParts = [];
  if (deal.missing_units_to_target !== null && deal.missing_units_to_target !== undefined) {
    issueParts.push(`${num(deal.missing_units_to_target)} יחידות חסרות`);
  }
  if (deal.has_image === false) issueParts.push("חסרה תמונה");
  if (deal.has_seller_profile === false) issueParts.push("חסר פרופיל מוכר");
  if (deal.readiness_issue) issueParts.push(analyticsReadinessLabel(deal.readiness_issue));
  return `
    <div class="table-row">
      <div class="table-cell"><span class="muted">שם עסקה</span><strong>${esc(deal.title || "עסקה ללא שם")}</strong></div>
      <div class="table-cell"><span class="muted">סטטוס</span><strong>${esc(getDealCopy(deal.state).label)}</strong></div>
      <div class="table-cell"><span class="muted">סיבה</span><strong>${esc(analyticsWeakReasonLabel(deal.reason))}</strong></div>
      <div class="table-cell"><span class="muted">מה חסר</span><strong>${esc(issueParts.length ? issueParts.join(" · ") : "לא זמין")}</strong></div>
    </div>
  `;
}

function renderSellerAnalyticsAttributionLink(link) {
  return `
    <div class="table-row">
      <div class="table-cell"><span class="muted">לינק</span><strong>${esc(link.label || link.link_id || "לינק ייחוס")}</strong></div>
      <div class="table-cell"><span class="muted">הצטרפויות</span><strong>${num(link.joins_count)}</strong></div>
      <div class="table-cell"><span class="muted">יחידות</span><strong>${num(link.attributed_units)}</strong></div>
      <div class="table-cell"><span class="muted">ברוטו</span><strong>${currency(link.attributed_gross)}</strong></div>
    </div>
  `;
}

function renderSellerAnalyticsInsight(insight) {
  const tone = insight.severity === "warning" ? "warning" : "success";
  return `
    <div class="status-item ${tone}">
      <strong>${esc(insight.message_he || "אין פעולה נדרשת כרגע.")}</strong>
    </div>
  `;
}

function analyticsWeakReasonLabel(reason) {
  const labels = {
    failed_below_target: "העסקה לא הושלמה",
    active_missing_units: "חסרות יחידות כדי להתקדם",
    draft_missing_image: "טיוטה בלי תמונת מוצר",
    seller_profile_not_ready: "פרופיל המוכר לא מלא"
  };
  return labels[reason] || "דורשת בדיקה";
}

function analyticsReadinessLabel(issue) {
  const labels = {
    missing_image: "חסרה תמונה",
    seller_profile_not_ready: "פרופיל מוכר לא מלא"
  };
  return labels[issue] || "דורש השלמה";
}

function renderSellerDealCard(item) {
  const progressPct = sellerDealProgressPct(item.metrics, item.threshold_units);
  const urgency = sellerDeadlineSignal(item.deadline, item.state);
  const primaryImage = getPrimaryDealImage(item);
  const chargedUnits = Number(item.metrics?.charged_units ?? item.charged_units ?? 0);
  const pendingUnits = Number(item.metrics?.pending_units ?? item.pending_units ?? Math.max(0, Number(item.metrics?.joined_units || 0) - chargedUnits));
  const notChargedUnits = Number(item.metrics?.not_charged_units ?? item.not_charged_units ?? 0);
  const dealVolume = Number(item.metrics?.gross_potential ?? item.gross_potential ?? Number(item.metrics?.joined_units || 0) * Number(item.price_per_unit || 0));
  const isDraft = item.state === "Draft";
  return `
    <article class="summary-item seller-card ${item.state === "CompletionWindow" ? "completion-window" : ""} ${item.state === "Failed" ? "failed" : ""}">
      <div class="seller-card-head">
        ${primaryImage?.url ? `<img class="seller-card-thumb" src="${esc(primaryImage.url)}" alt="תמונת מוצר עבור ${esc(item.title)}" />` : `<div class="seller-card-thumb placeholder" aria-hidden="true">${esc(([...String(item.title || "")][0] || "ס"))}</div>`}
        <div class="seller-card-meta">
          <h3>${esc(item.title)}</h3>
          <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(getDealCopy(item.state).label)}</span>
          <strong class="deal-volume">${currency(dealVolume)}</strong>
          ${item.state === "Failed" ? `<p class="small muted">זה הכסף שלא נכנס</p>` : ""}
          <div class="pill-row">
            <span class="stat-pill text-success"><span>מחויב</span><strong>${num(chargedUnits)}</strong></span>
            <span class="stat-pill text-warning"><span>בהמתנה</span><strong>${num(pendingUnits)}</strong></span>
            <span class="stat-pill text-muted"><span>לא חויב</span><strong>${num(notChargedUnits)}</strong></span>
          </div>
        </div>
      </div>
      ${renderProgressBlock({
        stateName: item.state,
        currentUnits: item.metrics.joined_units,
        targetUnits: item.threshold_units,
        percentValue: progressPct,
        atRiskUnits: pendingUnits
      })}
      ${item.state === "CompletionWindow" ? `<strong class="text-warning">${num(pendingUnits)} יחידות בסיכון</strong>` : ""}
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">יחידות</span><strong>${num(item.metrics.joined_units)} / ${num(item.threshold_units)}</strong></div>
        <div class="summary-item"><span class="muted">זמן</span><strong>${esc(urgency.title)}</strong></div>
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
        <div class="actions seller-card-actions">
          <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">כניסה לעסקה</a>
          ${isDraft ? `<span class="status-note">טיוטה פנימית - אין לינק לשיתוף</span>` : `<button class="secondary" type="button" data-inline-action="copy-link" data-share-url="/app/deal/${encodeURIComponent(item.deal_id)}">העתקת לינק</button>`}
          ${["Completed", "Failed", "Cancelled"].includes(item.state) ? `<button class="secondary" type="button" data-inline-action="seller-clone" data-deal-id="${esc(item.deal_id)}">צור עסקה דומה</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function buildSellerPreviewPayload() {
  const fulfillmentType = state.form.sellerFulfillmentType || "delivery";
  const slots = fulfillmentType === "delivery" ? [1] : activeSellerPickupSlots();
  const deliveryOptions = slots.map((slot, index) => {
    if (fulfillmentType === "delivery") {
      return { option_id: "preview-delivery", option_type: "delivery", label: "משלוח", cost: 0, sort_order: 0 };
    }
    const type = fulfillmentType === "distribution_point" ? "distribution_point" : "pickup";
    return {
      option_id: `preview-${slot}`,
      option_type: type,
      label: buildDistributionPointLabel({
        label: state.form[`sellerDeliveryLabel${slot}`] || formatDeliveryTypeLabel(type),
        pointName: state.form[`sellerDeliveryPointName${slot}`],
        address: state.form[`sellerDeliveryAddress${slot}`],
        city: state.form[`sellerDeliveryCity${slot}`],
        instructions: state.form[`sellerDeliveryInstructions${slot}`],
        locationUrl: state.form[`sellerDeliveryLocationUrl${slot}`]
      }),
      cost: Number(state.form[`sellerDeliveryCost${slot}`] || 0),
      sort_order: index
    };
  });
  const images = readSellerImages().map((image, index) => ({
    image_id: `preview-image-${index}`,
    url: image.dataUrl,
    is_primary: Boolean(image.isPrimary),
    sort_order: index
  }));
  const threshold = Math.max(1, Number(state.form.sellerMinUnits || 1));
  const maxUnits = Math.max(threshold, Number(state.form.sellerMaxUnits || threshold));
  return {
    deal: {
      deal_id: "preview-only",
      title: state.form.sellerTitle || "שם העסקה יופיע כאן",
      description: state.form.sellerDescription || "תיאור העסקה יופיע כאן כפי שהקונה יקרא אותו.",
      state: "Draft",
      price_per_unit: Math.max(0, Number(state.form.sellerPrice || 0)),
      threshold_units: threshold,
      max_units: maxUnits,
      deadline: state.form.sellerDeadline || null,
      delivery_options: deliveryOptions,
      images,
      seller: { business_name: currentSellerContext().display_name || "מוכר C-ton" }
    },
    metrics: {
      joined_units: 0,
      remaining_units: maxUnits,
      progress_to_minimum_pct: 0
    },
    seller: { business_name: currentSellerContext().display_name || "מוכר C-ton" },
    availability: {
      canJoin: false,
      message: "כך העסקה תיראה לקונים אחרי פרסום. כרגע זו תצוגה מקדימה בטוחה בלבד."
    }
  };
}

function renderSellerPreviewModal() {
  if (!state.sellerPreviewOpen) return "";
  return `
    <section class="modal-backdrop seller-preview-backdrop" role="presentation">
      <div class="modal-panel seller-preview-dialog stack" role="dialog" aria-modal="true" aria-labelledby="sellerPreviewTitle" tabindex="-1" data-seller-preview-dialog>
        <div class="section-header seller-preview-toolbar">
          <div><span class="eyebrow">Preview לפני פרסום</span><h2 id="sellerPreviewTitle">כך הקונה יראה את העסקה</h2><p class="small muted">אותו renderer ציבורי, ללא יצירה, פרסום, הצטרפות או אישור מסגרת.</p></div>
          <button class="secondary" type="button" data-inline-action="seller-preview-close" aria-label="סגירת התצוגה המקדימה">סגירה</button>
        </div>
        ${renderCtonDealPageView(buildSellerPreviewPayload(), { preview: true })}
      </div>
    </section>
  `;
}

function renderSellerNewPage() {
  const auth = currentSellerAuth();
  if (!usesDemoSellerContext() && !auth.authenticated) {
    return renderSellerAuthGate();
  }
  const sellerContext = currentSellerContext();
  const sellerStatus = sellerContext.seller_status || state.sellerAuth?.seller_context?.seller_status || "Active";
  const sellerNotice = sellerEnforcementNotice(sellerStatus);
  if (sellerStatus === "Suspended" || sellerStatus === "Banned") {
    return `
      <section class="hero">
        <article class="card hero-main stack hero-emphasis">
          <span class="eyebrow">פתיחת עסקה</span>
          <h1>פתיחת עסקה חדשה אינה זמינה כרגע</h1>
          <div class="info-strip tone-warning"><strong>${esc(sellerNotice)}</strong></div>
          <div class="actions"><a class="button secondary" href="/app/seller" data-nav="/app/seller">חזרה לניהול העסקאות שלי</a></div>
        </article>
      </section>
    `;
  }
  const price = Math.max(0, Number(state.form.sellerPrice || 0));
  const minUnits = Math.max(0, Number(state.form.sellerMinUnits || 0));
  const maxUnits = Math.max(0, Number(state.form.sellerMaxUnits || 0));
  const sellerImages = readSellerImages();
  const primarySellerImage = getSellerPrimaryImage(sellerImages);
  const fulfillmentType = state.form.sellerFulfillmentType || "delivery";
  const pickupSlots = activeSellerPickupSlots();
  const deliveryOptionsCount = fulfillmentType === "delivery" ? 1 : pickupSlots.length;
  const fieldErrors = state.createDealFieldErrors || {};
  const fieldClass = (name) => fieldErrors[name] ? "field has-error" : "field";
  const fieldError = (name) => fieldErrors[name] ? `<small class="field-error">${esc(fieldErrors[name])}</small>` : "";
  const previewTarget = minUnits || 8;
  return `
    <section class="hero seller-create-hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">C-ton למוכרים</span>
        <h1>יצירת עסקה חדשה</h1>
        <p class="muted">בנו עסקה קבוצתית, שתפו לינק, ותנו לקונים להצטרף רק אם הקבוצה מצליחה.</p>
        ${state.error ? `<section class="error-card validation-summary create-deal-alert" role="alert" tabindex="-1" data-create-deal-alert>
          <strong>${esc(state.error.title || "לא ניתן ליצור את העסקה עדיין.")}</strong>
          <p>${esc(state.error.message || "חסרים פרטים בטופס.")}</p>
          ${Array.isArray(state.error.items) && state.error.items.length ? `<ul>${state.error.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
        </section>` : ""}
        <div class="trust-band">
          <div class="trust-point"><span class="muted">טיוטה</span><strong>מסגרת אמון קשיחה</strong></div>
          <div class="trust-point"><span class="muted">פרסום</span><strong>דף ציבורי חי</strong></div>
          <div class="trust-point"><span class="muted">הפצה</span><strong>לינק ישיר לקונים</strong></div>
        </div>
        <div class="wizard-steps" aria-label="שלבי יצירת עסקה">
          <span>1. מוצר</span>
          <span>2. כמויות</span>
          <span>3. אספקה</span>
          <span>4. תנאים</span>
          <span>5. סיכום ופרסום</span>
        </div>
        <form data-action="seller-create" class="form-shell seller-create-form">
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>מוצר</h3>
              <p class="small muted">מכאן נקבע איך העסקה תיתפס בעיני הקונה: מה נמכר, בכמה, ומה המרווח של הפלטפורמה.</p>
            </div>
            <div class="${fieldClass("sellerTitle")}"><label for="sellerTitle">שם העסקה</label><input id="sellerTitle" name="sellerTitle" type="text" value="${esc(state.form.sellerTitle)}" aria-invalid="${fieldErrors.sellerTitle ? "true" : "false"}" />${fieldError("sellerTitle")}</div>
            <div class="field"><label for="sellerDescription">תיאור קצר לקונה</label><textarea id="sellerDescription" name="sellerDescription" rows="4" maxlength="420" placeholder="מה מקבלים, למי זה מתאים, ומה חשוב לדעת לפני הצטרפות">${esc(state.form.sellerDescription)}</textarea></div>
            <div class="deal-image-field">
              <div>
                <h3>תמונת העסקה</h3>
                <p class="small muted">העלו תמונה ברורה של המוצר. מומלץ יחס 16:9.</p>
              </div>
              <input class="visually-hidden-file" id="sellerImage" name="sellerImage" type="file" accept="image/png,image/jpeg,image/webp" multiple />
              <div class="product-image-upload-card ${primarySellerImage?.dataUrl ? "has-image" : ""}">
                ${primarySellerImage?.dataUrl ? `<img src="${esc(primarySellerImage.dataUrl)}" alt="תמונה ראשית לתצוגה מקדימה של העסקה" />` : `
                  <div class="product-image-placeholder">
                    <span class="package-icon" aria-hidden="true">□</span>
                    <strong>תמונת העסקה תופיע כאן</strong>
                    <span class="small muted">אפשר להעלות עד 5 תמונות. תמונה אחת תסומן כראשית.</span>
                    <label class="button primary image-upload-button" for="sellerImage">בחרו תמונות</label>
                  </div>
                `}
                ${primarySellerImage?.dataUrl && sellerImages.length < 5 ? `<label class="button secondary image-replace-button" for="sellerImage">הוספת תמונות</label>` : ""}
                ${state.sellerImageUploadStatus === "loading" ? `<div class="image-upload-overlay">מעלה תמונה...</div>` : ""}
              </div>
              ${sellerImages.length ? `
                <div class="seller-image-gallery" aria-label="תמונות העסקה">
                  ${sellerImages.map((image, index) => `
                    <article class="seller-image-thumb ${image.isPrimary ? "is-primary" : ""}">
                      <img src="${esc(image.dataUrl)}" alt="תמונה ${index + 1} לעסקה" />
                      <div class="seller-image-thumb-actions">
                        <span class="badge ${image.isPrimary ? "pending" : ""}">${image.isPrimary ? "תמונה ראשית" : `תמונה ${index + 1}`}</span>
                        ${image.isPrimary ? "" : `<button class="secondary tiny-button" type="button" data-inline-action="make-product-image-primary" data-image-index="${index}">הגדר כראשית</button>`}
                        <button class="secondary tiny-button" type="button" data-inline-action="remove-product-image" data-image-index="${index}">מחיקה</button>
                      </div>
                    </article>
                  `).join("")}
                </div>
              ` : ""}
              ${state.sellerImageUploadStatus === "error" ? `<div class="image-upload-error" role="alert">${esc(state.sellerImageUploadError || "לא הצלחנו להעלות את התמונה. נסו קובץ JPG, PNG או WebP עד 2MB.")}</div>` : ""}
            </div>
            <div class="inline-fields">
              <div class="${fieldClass("sellerPrice")}"><label for="sellerPrice">מחיר ליחידה</label><input id="sellerPrice" name="sellerPrice" type="number" step="0.01" value="${esc(state.form.sellerPrice)}" aria-invalid="${fieldErrors.sellerPrice ? "true" : "false"}" />${fieldError("sellerPrice")}</div>
              <div class="summary-item"><span class="muted">עמלת C-ton הקבועה</span><strong>8% מהגבייה בפועל לא כולל מע"מ</strong><p class="small muted">העמלה כוללת משלוח, סליקה ותפעול. אין עמלה נוספת מעבר לכך.</p></div>
            </div>
            <div class="form-preview-grid">
              <div class="summary-item"><span class="muted">מחזור מינימלי משוער</span><strong data-create-summary-min-volume>${currency(price * minUnits)}</strong><p class="small muted">${num(minUnits)} יח' לפי המחיר הנוכחי.</p></div>
              <div class="summary-item"><span class="muted">מחזור מקסימלי משוער</span><strong data-create-summary-max-volume>${currency(price * maxUnits)}</strong><p class="small muted">${num(maxUnits)} יח' אם כל הקיבולת נסגרת.</p></div>
            </div>
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>יעד, קיבולת וסגירה</h3>
              <p class="small muted">החלק הזה קובע את תחושת הדחיפות והמסגרת העסקית שהקונה יראה על הדף.</p>
            </div>
            <div class="inline-fields">
              <div class="${fieldClass("sellerMinUnits")} unit-field"><label for="sellerMinUnits">כמות מינימום</label><input id="sellerMinUnits" name="sellerMinUnits" type="number" min="1" step="1" value="${esc(state.form.sellerMinUnits)}" aria-invalid="${fieldErrors.sellerMinUnits ? "true" : "false"}" />${fieldError("sellerMinUnits")}</div>
              <div class="${fieldClass("sellerMaxUnits")} unit-field"><label for="sellerMaxUnits">כמות מקסימום</label><input id="sellerMaxUnits" name="sellerMaxUnits" type="number" min="1" step="1" value="${esc(state.form.sellerMaxUnits)}" aria-invalid="${fieldErrors.sellerMaxUnits ? "true" : "false"}" />${fieldError("sellerMaxUnits")}</div>
            </div>
            <div class="${fieldClass("sellerDeadline")}"><label for="sellerDeadline">מועד סגירת חלון ההצטרפות</label><input id="sellerDeadline" name="sellerDeadline" type="datetime-local" value="${esc(state.form.sellerDeadline)}" aria-invalid="${fieldErrors.sellerDeadline ? "true" : "false"}" />${fieldError("sellerDeadline")}</div>
            <div class="surface-note">
              <strong>בדיקת שפיות מהירה</strong>
              <p class="small muted">כדאי שהמינימום יהיה יעד שאפשר להגיע אליו, שהמקסימום לא ירגיש מנותק מההפצה, ושהדדליין ייצור דחיפות בלי לבלבל את הקונה.</p>
            </div>
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>אפשרויות קבלה</h3>
              <p class="small muted">בחרו איך הקונים יקבלו את המוצר. מיקומי איסוף ונקודות חלוקה נוצרים רק בלחיצה מפורשת.</p>
            </div>
            <div class="${fieldClass("sellerFulfillmentType")} fulfillment-choice-grid" role="radiogroup" aria-label="אופן קבלה">
              ${["delivery", "pickup", "distribution_point"].map((option) => `
                <label class="choice fulfillment-choice ${fulfillmentType === option ? "selected" : ""}">
                  <input type="radio" name="sellerFulfillmentType" value="${option}" ${fulfillmentType === option ? "checked" : ""} />
                  <span class="badge ${fulfillmentType === option ? "pending" : "closed"}">${esc(formatDeliveryTypeLabel(option))}</span>
                  <strong>${esc(option === "delivery" ? "משלוח" : option === "pickup" ? "איסוף עצמי" : "נקודת חלוקה")}</strong>
                  <small>${esc(option === "delivery" ? "אפשרות משלוח אחת תוצג לקונה בלי לפתוח שדות מיקום." : "מיקום יתווסף רק אחרי לחיצה על הוספת מיקום איסוף.")}</small>
                </label>
              `).join("")}
              ${fieldError("sellerFulfillmentType")}
            </div>
            ${fulfillmentType === "delivery" ? `
              <div class="info-strip tone-success"><strong>משלוח נבחר</strong><p class="small">לא נפתחו נקודות חלוקה אוטומטיות. הקונה יראה אפשרות משלוח ברורה בדף העסקה.</p></div>
            ` : `
              <div class="actions spread">
                <div>
                  <strong>${fulfillmentType === "distribution_point" ? "נקודות חלוקה" : "מיקומי איסוף עצמי"}</strong>
                  <p class="small muted">אין מיקום ברירת מחדל. מוסיפים רק את מה שהמוכר בוחר לפרסם.</p>
                </div>
                <button class="primary" type="button" data-inline-action="add-pickup-location">הוסף מיקום איסוף</button>
              </div>
              ${pickupSlots.length ? pickupSlots.map((slot) => `
                <div class="form-option-card pickup-location-card stack">
                  <div class="actions spread">
                    <span class="badge">${fulfillmentType === "distribution_point" ? "נקודת חלוקה" : "איסוף עצמי"} ${slot}</span>
                    <button class="secondary tiny-button" type="button" data-inline-action="remove-pickup-location" data-slot="${slot}">הסר מיקום</button>
                  </div>
                  <input type="hidden" name="sellerDeliveryType${slot}" value="${fulfillmentType === "distribution_point" ? "distribution_point" : "pickup"}" />
                  <div class="${fieldClass(`sellerDeliveryPointName${slot}`)}"><label for="sellerDeliveryPointName${slot}">שם המקום</label><input id="sellerDeliveryPointName${slot}" name="sellerDeliveryPointName${slot}" type="text" value="${esc(state.form[`sellerDeliveryPointName${slot}`])}" placeholder="למשל: מחסן צפוני / קניון העיר" />${fieldError(`sellerDeliveryPointName${slot}`)}</div>
                  <div class="inline-fields">
                    <div class="${fieldClass(`sellerDeliveryAddress${slot}`)}"><label for="sellerDeliveryAddress${slot}">כתובת</label><input id="sellerDeliveryAddress${slot}" name="sellerDeliveryAddress${slot}" type="text" value="${esc(state.form[`sellerDeliveryAddress${slot}`])}" placeholder="רחוב ומספר" />${fieldError(`sellerDeliveryAddress${slot}`)}</div>
                    <div class="${fieldClass(`sellerDeliveryCity${slot}`)}"><label for="sellerDeliveryCity${slot}">עיר</label><input id="sellerDeliveryCity${slot}" name="sellerDeliveryCity${slot}" type="text" value="${esc(state.form[`sellerDeliveryCity${slot}`])}" placeholder="עיר" />${fieldError(`sellerDeliveryCity${slot}`)}</div>
                  </div>
                  <div class="inline-fields">
                    <div class="field"><label for="sellerDeliveryInstructions${slot}">הוראות הגעה, אופציונלי</label><input id="sellerDeliveryInstructions${slot}" name="sellerDeliveryInstructions${slot}" type="text" value="${esc(state.form[`sellerDeliveryInstructions${slot}`])}" placeholder="כניסה מהחניון, קומה 1, ליד שער B" /></div>
                    <div class="${fieldClass(`sellerDeliveryLocationUrl${slot}`)}"><label for="sellerDeliveryLocationUrl${slot}">קישור מיקום, אופציונלי</label><input id="sellerDeliveryLocationUrl${slot}" name="sellerDeliveryLocationUrl${slot}" type="url" data-dir="ltr" value="${esc(state.form[`sellerDeliveryLocationUrl${slot}`])}" placeholder="https://maps.google.com/..." />${fieldError(`sellerDeliveryLocationUrl${slot}`)}</div>
                  </div>
                  <input type="hidden" name="sellerDeliveryLabel${slot}" value="${esc(state.form[`sellerDeliveryLabel${slot}`] || (fulfillmentType === "distribution_point" ? `נקודת חלוקה ${slot}` : `איסוף עצמי ${slot}`))}" />
                  <input type="hidden" name="sellerDeliveryCost${slot}" value="${esc(state.form[`sellerDeliveryCost${slot}`] || "0")}" />
                </div>
              `).join("") : `<div class="empty-surface"><strong>עדיין אין מיקומי איסוף</strong><p class="small muted">לחיצה על "הוסף מיקום איסוף" תפתח כרטיס מיקום אחד בלבד.</p></div>`}
            `}
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>סיכום ואישור סופי</h3>
              <p class="small muted">לפני יצירת הטיוטה מאשרים שהפרטים הקריטיים נבדקו. אחרי פרסום אין עריכה שקטה של מחיר, כמויות, דדליין או תנאי אספקה.</p>
            </div>
            <div class="form-preview-grid">
              <div class="summary-item"><span class="muted">כותרת</span><strong data-create-summary-title>${esc(state.form.sellerTitle || "עדיין חסרה")}</strong></div>
              <div class="summary-item"><span class="muted">מחיר</span><strong data-create-summary-price>${currency(price)}</strong></div>
              <div class="summary-item"><span class="muted">מינימום / מקסימום</span><strong data-create-summary-units>${num(minUnits)} / ${num(maxUnits)}</strong></div>
              <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${num(deliveryOptionsCount || 1)} אפשרויות</strong></div>
            </div>
            <label class="check-row"><input type="checkbox" name="sellerFinalTerms" ${state.form.sellerFinalTerms === "on" ? "checked" : ""} /> <span>קראתי ואישרתי את <a href="/app/seller-terms" data-nav="/app/seller-terms">תקנון השימוש למוכרים</a> ואת <a href="/app/refunds" data-nav="/app/refunds">מדיניות הביטולים וההחזרים</a>, כולל אחריותי לתיאור המוצר, אספקתו ושירות לאחר השלמת העסקה.</span></label>
            <label class="check-row"><input type="checkbox" name="sellerFinalConfirm" ${state.form.sellerFinalConfirm === "on" ? "checked" : ""} /> <span>אני מאשר שהתנאים סופיים.</span></label>
          </section>
          <div class="actions">
            <button class="secondary" type="button" data-inline-action="seller-preview-open">תצוגה מקדימה מלאה לקונה</button>
            <button class="primary" type="submit">יצירת טיוטה</button>
            <a class="button secondary" href="/app/seller" data-nav="/app/seller">חזרה לניהול העסקאות שלי</a>
          </div>
        </form>
      </article>
      <aside class="card hero-side stack">
        ${(() => {
          const prof = state.sellerProfile;
          if (!prof || prof.is_publish_ready !== false) return '';
          return '<div class="info-strip tone-warning"><strong>' +
            'פרטי מוכר חסרים' +
            '</strong><p class="small">' +
            'כדי לפרסם עסקה, יש להשלים קודם את פרטי המוכר שיוצגו לקונים. ' +
            '<a href="/app/seller#seller-profile-section" data-nav="/app/seller">' +
            'השלמת פרטי מוכר &rarr;' +
            '</a></p></div>';
        })()}
        
        <div class="seller-live-preview">
          <span class="badge warning">טיוטת עסקה</span>
          <div class="product-image-preview compact-preview ${sellerImages.length ? "has-image" : ""}">
            ${primarySellerImage?.dataUrl ? `<img src="${esc(primarySellerImage.dataUrl)}" alt="תצוגה מקדימה של תמונת העסקה" />` : `<div class="product-image-placeholder"><strong>תמונת העסקה תופיע כאן</strong><span class="package-icon" aria-hidden="true">□</span></div>`}
          </div>
          <h2 data-create-preview-title>${esc(state.form.sellerTitle || "שם העסקה יופיע כאן")}</h2>
          <div class="preview-price" data-create-preview-price>${currency(price)}</div>
          <div class="progress-block">
            <div class="progress-caption"><strong data-create-preview-progress>0 / ${num(previewTarget)} יחידות</strong><span>0%</span></div>
            <div class="meter"><span style="width:0%"></span></div>
            <p class="progress-status" data-create-preview-status>עוד ${num(previewTarget)} יחידות והעסקה יוצאת לפועל</p>
          </div>
          <div class="summary-grid">
            <div class="summary-item"><span class="muted">יעד</span><strong data-create-preview-goal>${num(minUnits)} יח'</strong></div>
            <div class="summary-item"><span class="muted">סכום יעד</span><strong data-create-preview-goal-sum>${currency(price * minUnits)}</strong></div>
          </div>
          <button class="primary" type="button" disabled>תצוגה מקדימה בלבד</button>
        </div>
        <div class="summary-item summary-spotlight"><span class="muted">זהות המוכר הפעילה</span><strong>${esc(sellerContext.display_name)}</strong><p class="small muted">מזהה מוכר: <span class="mono">${esc(sellerContext.seller_id)}</span></p></div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">מחיר נוכחי</span><strong>${currency(price)}</strong></div>
          <div class="summary-item"><span class="muted">עמלת C-ton</span><strong>8%</strong><p class="small muted">קבועה לפי המודל הקנוני, כולל משלוח וללא מע"מ.</p></div>
          <div class="summary-item"><span class="muted">יעד פתיחה</span><strong>${num(minUnits)} יח'</strong></div>
          <div class="summary-item"><span class="muted">קיבולת</span><strong>${num(maxUnits)} יח'</strong></div>
        </div>
        <div class="cta-panel">
          <strong>מה יקרה אחרי שמירת הטיוטה</strong>
          <p class="small muted">הטיוטה תיכנס ישר לניהול העסקאות, ומשם אפשר לפרסם דף ציבורי חי, לפתוח לינק ישיר ולהתחיל לעקוב אחרי הצטרפויות.</p>
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
          <strong>בדיקה לפני פרסום</strong>
          <p class="small muted">לפני פרסום תתבקשו לאשר את תנאי המוכרים, התקנון ומדיניות C-ton. טיוטה נשמרת בלי אישור פרסום.</p>
        </div>
      </aside>
    </section>
    ${renderSellerPreviewModal()}
  `;
}

function renderDeliveryHandoffSection(dealId) {
  const handoff = state.sellerDeliveryHandoff;
  if (!handoff) return "";
  const buyers = handoff.buyers || [];
  const sellerContext = currentSellerContext();
  function fullAddress(b) {
    const parts = [b.delivery_address, b.delivery_city].filter(Boolean);
    return parts.join(", ");
  }
  function whatsappHref(phone) {
    const clean = String(phone || "").replace(/\D/g, "");
    if (!clean) return null;
    const intl = clean.startsWith("0") ? "972" + clean.slice(1) : clean;
    return `https://wa.me/${intl}`;
  }
  return `
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>נתוני אספקה לקונים</h2>
          <p class="muted section-intro">C-ton מציגה כאן את פרטי הקונים שחויבו וזכאים למוצר. <strong>האספקה עצמה מתבצעת באחריות המוכר ומחוץ למערכת.</strong></p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>זכאים</span><strong>${num(buyers.length)}</strong></span>
          ${buyers.length ? `<button class="secondary" type="button" data-inline-action="download-delivery-handoff-excel" data-deal-id="${esc(dealId)}">הורד Excel אספקה</button>` : ""}
        </div>
      </div>
      ${buyers.length ? `
        <div class="card-list">
          ${buyers.map((b) => `
            <article class="summary-item stack">
              <div class="actions spread">
                <div>
                  <strong>${esc(b.buyer_name || b.buyer_id || "—")}</strong>
                  <p class="small muted">${esc(b.delivery_method_label || b.delivery_method_type || "—")} · ${num(b.qty)} יח'</p>
                </div>
                <div class="actions">
                  ${whatsappHref(b.buyer_phone) ? `<a class="button secondary" href="${esc(whatsappHref(b.buyer_phone))}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
                  ${b.buyer_email ? `<a class="button secondary" href="mailto:${esc(b.buyer_email)}">מייל</a>` : ""}
                </div>
              </div>
              ${b.delivery_method_type === "shipping" && (b.delivery_address || b.delivery_city) ? `
                <div class="actions spread">
                  <p class="small">${esc(fullAddress(b))}${b.delivery_notes ? ` — ${esc(b.delivery_notes)}` : ""}</p>
                  <button class="secondary" type="button" data-inline-action="copy-delivery-address" data-address="${esc(fullAddress(b))}">העתק כתובת</button>
                </div>
              ` : b.delivery_method_type === "pickup" ? `
                <p class="small muted">איסוף עצמי — פרטים מועברים ישירות על ידי המוכר.</p>
              ` : `<p class="small muted">${esc(b.delivery_method_label || "אופן קבלה לא צוין")}</p>`}
              ${b.buyer_phone ? `<p class="small muted mono">${esc(b.buyer_phone)}</p>` : ""}
              ${b.buyer_email ? `<p class="small muted">${esc(b.buyer_email)}</p>` : ""}
            </article>
          `).join("")}
        </div>
      ` : `<div class="empty-surface"><p class="muted">אין קונים זכאים למוצר בעסקה זו.</p></div>`}
      <div class="info-strip">
        <strong>מדיניות מסירת נתונים</strong>
        <p class="small">${esc(handoff.disclaimer || "האספקה מתבצעת באחריות המוכר ומחוץ למערכת C-ton.")}</p>
      </div>
    </section>
  `;
}

async function downloadDeliveryHandoffExcel(dealId) {
  if (!dealId) return;
  const sellerContext = currentSellerContext();
  const url = `/api/seller/deals/${encodeURIComponent(dealId)}/delivery-handoff/export.xlsx`;
  await busy("מכין Excel נתוני אספקה...", async () => {
    const response = await fetch(url, {
      headers: usesDemoSellerContext() ? { "x-seller-id": sellerContext.seller_id } : {}
    });
    if (!response.ok) {
      const error = new Error(await response.text());
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `siton-delivery-handoff-${dealId}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }, "לא הצלחנו להוריד את קובץ נתוני האספקה.");
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
  const progressPct = sellerDealProgressPct(deal.metrics, deal.threshold_units);
  const urgency = sellerDeadlineSignal(deal.deadline, deal.state);
  const focus = sellerNextFocus(deal, null);
  const receiptsNote = normalizeSurfaceNote(receipts.note, "receipts");
  const participantSnapshot = summarizeSellerParticipants(payload.participants);
  const primaryImage = getPrimaryDealImage(deal);
  const activeSellerId = payload.seller_profile?.seller_id || currentSellerContext().seller_id;
  const activeSellerDisplayName = normalizeSellerDisplayName(
    activeSellerId,
    payload.seller_profile?.display_name || currentSellerContext().display_name
  );
  const sellerStatus = payload.seller_profile?.seller_status || state.sellerAuth?.seller_context?.seller_status || "Active";
  const sellerNotice = sellerEnforcementNotice(sellerStatus);
  const publishBlockedByStatus = ["Restricted", "Suspended", "Banned"].includes(sellerStatus);
  const cloneBlockedByStatus = ["Suspended", "Banned"].includes(sellerStatus);
  const isDraft = deal.state === "Draft";
  const isShareable = !isDraft && ["PendingTarget", "TargetReached"].includes(deal.state);
  const publicDealPath = `/app/deal/${encodeURIComponent(deal.deal_id)}`;
  const publicDealUrl = absoluteUrl(publicDealPath);
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">ניהול עסקה</span>
        <span class="badge ${DEAL_TONE[deal.state] || "warning"}">${esc(getDealCopy(deal.state).label)}</span>
        ${primaryImage?.url ? `<img class="seller-deal-hero-image" src="${esc(primaryImage.url)}" alt="תמונת מוצר עבור ${esc(deal.title)}" />` : `<div class="product-image-preview compact-preview"><div class="product-image-placeholder"><strong>אין תמונה לעסקה</strong><span class="package-icon" aria-hidden="true">□</span></div></div>`}
        ${renderDealImageGallery(deal)}
        <h1>${esc(deal.title)}</h1>
        <p class="muted">${isDraft ? "העסקה נשמרה כטיוטה פנימית. היא עדיין לא פורסמה, אין לה לינק לשיתוף, וקונים לא יכולים להצטרף עד הפרסום." : "זהו חדר הבקרה של המוכר לדף הציבורי, ללינק הישיר לקונים, לרשימת המשתתפים ולעדכוני הקבלה והמסירה."}</p>
        ${sellerNotice ? `<div class="info-strip tone-warning"><strong>${esc(sellerNotice)}</strong></div>` : ""}
        ${isDraft ? `<div class="info-strip tone-warning draft-private-notice"><strong>העסקה נשמרה כטיוטה</strong><p class="small">היא עדיין לא פורסמה. כדי שאנשים יוכלו להצטרף, יש לפרסם אותה.</p></div>` : `<div class="info-strip tone-success"><strong>העסקה פורסמה והיא פתוחה להצטרפות</strong><p class="small">אפשר לשתף את הלינק הציבורי ולעקוב מכאן אחרי ההצטרפויות.</p></div>`}
        <div class="trust-band">
          <div class="trust-point"><span class="muted">מצב עריכה</span><strong>${payload.seller_actions.edit_locked ? "נעול אחרי פרסום" : "עדיין בטיוטה"}</strong></div>
          <div class="trust-point"><span class="muted">דף ציבורי</span><strong>${payload.seller_actions.can_publish ? "מוכן לפרסום" : "כבר פורסם או נסגר"}</strong></div>
          <div class="trust-point"><span class="muted">קישור קונה</span><strong>${isDraft ? "יופיע רק אחרי פרסום" : "לינק ישיר אחד לעסקה"}</strong></div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">מחיר ליחידה</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="summary-item"><span class="muted">יחידות שנרשמו</span><strong>${num(deal.metrics.joined_units)}</strong></div>
          <div class="summary-item"><span class="muted">משתתפים</span><strong>${num(deal.metrics.participants_count)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת C-ton</span><strong>8%</strong></div>
        </div>
        <div class="live-summary-grid">
          <div class="summary-item summary-spotlight"><span class="muted">נותר למלא</span><strong>${num(Math.max(0, deal.max_units - deal.metrics.joined_units))} יח'</strong><p class="small muted">מתוך קיבולת כוללת של ${num(deal.max_units)} יח'.</p></div>
          <div class="summary-item"><span class="muted">סף פתיחה</span><strong>${num(deal.threshold_units)} יח'</strong><p class="small muted">יעד הבסיס לפני סגירת חלון ההצטרפות.</p></div>
          <div class="summary-item"><span class="muted">${isDraft ? "סטטוס הפצה" : "הקישור הפעיל"}</span><strong class="${isDraft ? "" : "mono"}">${isDraft ? "אין לינק ציבורי בטיוטה" : esc(payload.seller_profile?.direct_link || `/app/deal/${deal.deal_id}`)}</strong><p class="small muted">${isDraft ? "העסקה עדיין בטיוטה. פרסמו אותה כדי לקבל לינק לשיתוף." : "זהו הלינק שהקונים צריכים לראות ולהבין במהירות."}</p></div>
        </div>
        <div class="seller-deal-control-grid">
          <div class="summary-item summary-spotlight">
            <span class="muted">חויבו בהצלחה</span>
            <strong>${num(participantSnapshot.charged)}</strong>
            <p class="small muted">משתתפים שהמערכת כבר סימנה כמושלמי חיוב.</p>
          </div>
          <div class="summary-item">
            <span class="muted">בהמתנה להשלמה</span>
            <strong>${num(participantSnapshot.pending)}</strong>
            <p class="small muted">הצטרפויות שעוד ניתן לעקוב אחריהן במסלול המערכת.</p>
          </div>
          <div class="summary-item">
            <span class="muted">דורש בקרה</span>
            <strong>${num(participantSnapshot.unresolved)}</strong>
            <p class="small muted">מספר משתתפים שנשארו במצב לא סגור וייש לברר עבורם.</p>
          </div>
        </div>
        ${renderProgressBlock({
          stateName: deal.state,
          currentUnits: deal.metrics.joined_units,
          targetUnits: deal.threshold_units,
          percentValue: progressPct,
          atRiskUnits: participantSnapshot.pending
        })}
        <div class="surface-note">
          <strong>אם זה יסתיים עכשיו</strong>
          <p class="small muted">${Number(deal.metrics.joined_units || 0) >= Number(deal.threshold_units || 0) ? "העסקה תיסגר בהצלחה" : "העסקה תיכשל"}</p>
        </div>
        <div class="actions">
          ${["Charging", "CompletionWindow"].includes(deal.state) ? `<div class="info-strip tone-warning"><strong>העסקה נעולה לצפייה בלבד.</strong><p class="small">כל הפעולות מתבצעות אוטומטית.</p></div>` : payload.seller_actions.can_publish && !publishBlockedByStatus ? `
            <form data-action="seller-publish" data-deal-id="${esc(deal.deal_id)}" class="stack draft-publish-panel">
              <strong>מוכן לצאת ללינק חי?</strong>
              <p class="small muted">בלחיצה על פרסום העסקה תעבור ממצב טיוטה ל-PendingTarget ותיפתח להצטרפות קונים.</p>
              ${renderSellerPublishLegalAcceptance()}
              <button class="primary" type="submit">פרסם עסקה</button>
            </form>
          ` : payload.seller_actions.can_publish && publishBlockedByStatus ? `<button class="primary" type="button" disabled>פרסום חסום זמנית</button>` : ""}
          ${isDraft ? `<a class="button secondary" href="/app/seller/new" data-nav="/app/seller/new">המשך עריכה</a><a class="button secondary" href="/app/seller" data-nav="/app/seller">חזרה לדשבורד</a>` : ""}
          ${isShareable ? `<a class="button primary" href="${publicDealPath}" data-nav="${publicDealPath}">פתיחת הדף הציבורי</a><a class="button secondary" href="/app/seller/deals/${encodeURIComponent(deal.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(deal.deal_id)}">ניהול עסקה</a>` : ""}
          <button class="secondary" type="button" ${cloneBlockedByStatus ? "disabled" : `data-inline-action="seller-clone" data-deal-id="${esc(deal.deal_id)}"`}>צור עסקה דומה</button>
        </div>
        ${isShareable ? `<div class="info-strip tone-success"><strong>לינק ציבורי</strong><p class="small mono">${esc(publicDealUrl)}</p>${renderShareActions(publicDealPath, deal.title)}</div>` : `<div class="info-strip tone-warning"><strong>העסקה עדיין בטיוטה</strong><p class="small">פרסמו אותה כדי לקבל לינק לשיתוף. עד אז אין שיתוף ואין כניסת קונים.</p></div>`}
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
        <div class="summary-item"><span class="muted">הלינק הישיר</span><strong class="${isDraft ? "" : "mono"}">${isDraft ? "זמין רק אחרי פרסום" : esc(payload.seller_profile?.direct_link || `/app/deal/${deal.deal_id}`)}</strong></div>
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
        <div class="summary-item"><span class="muted">עמלת C-ton</span><strong>${currency(receipts.summary.siton_fee_amount)}</strong></div>
        <div class="summary-item summary-spotlight"><span class="muted">נטו למוכר</span><strong>${currency(receipts.summary.seller_net_amount)}</strong></div>
        <div class="summary-item"><span class="muted">מסמכים</span><strong>${num(receipts.summary.receipt_document_count)}</strong></div>
      </div>
      ${deal.state === "Completed" ? `
        <div class="summary-item stack">
          <div class="actions spread">
            <div>
              <strong>ייצוא עסקה</strong>
              <p class="small muted">כולל קונים זכאים, פרטי אספקה, כמויות, גבייה, עמלת C-ton ונטו למוכר.</p>
            </div>
            <button class="primary" type="button" data-inline-action="seller-excel-export" data-deal-id="${esc(deal.deal_id)}">הורד Excel עסקה</button>
          </div>
        </div>
      ` : ""}
      ${receipts.documents.length ? renderTablePanel("מסמכי עסקה לפי רישום אמיתי", "הטבלה נשענת רק על רשומות invoice_documents אמיתיות. אם עדיין לא נוצרה רשומה, יוצג במפורש שאין מסמך מונפק.", receipts.documents, ["document_id", "document_status", "issued_at", "participant_id", "buyer_id", "qty", "gross_amount", "share_code", "affiliate_name"]) : `<div class="empty-surface"><p class="muted">עדיין אין רשומות מסמך אמיתיות לעסקה הזאת.</p></div>`}
      <p class="small muted">זהו משטח פנימי למוכנות חשבונאית, לא מסמך חיצוני שהופק בפועל.</p>
    </section>
    ${deal.state === "Completed" ? renderDeliveryHandoffSection(deal.deal_id) : ""}
  `;
}

function renderAffiliatePage() {
  const payload = state.affiliatePayload?.affiliate_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("מרכז ההפצה לא זמין", "לא הצלחנו לטעון עכשיו את מרכז ההפצה.");
  const campaigns = Array.isArray(payload.campaigns) ? payload.campaigns : [];
  const links = Array.isArray(payload.links) ? payload.links : [];
  const shareableCampaigns = campaigns.filter((campaign) => ["PendingTarget", "TargetReached"].includes(campaign.state));
  const canCreateNamedLinks = Boolean(payload.capabilities?.named_link_creation);
  const totals = payload.totals || {};
  return `
    <section class="affiliate-workspace stack" id="affiliate-dashboard">
      <header class="card section affiliate-header stack">
        <div class="section-header">
          <div><span class="eyebrow">הפצה וייחוס</span><h1>מרכז ההפצה של ${esc(payload.display_name || "המפיץ")}</h1><p class="muted">לינקים, ביצועים ונכסי שיווק במקום אחד — בלי מידע אישי של קונים ובלי מסלול כסף.</p></div>
          <span class="badge ${payload.verification_status === "verified" ? "success" : "warning"}">${esc(payload.verification_status || "ממתין לאימות")}</span>
        </div>
        <nav class="affiliate-subnav" aria-label="ניווט מרכז הפצה">
          <a href="#affiliate-dashboard">דשבורד</a>
          <a href="#affiliate-links">לינקים להפצה</a>
          <a href="#affiliate-performance">ביצועי לינקים</a>
          <a href="#affiliate-assets">נכסי שיווק</a>
        </nav>
        <div class="info-strip tone-info affiliate-boundary-note">
          <strong>מדידה וייחוס בלבד</strong>
          <p>הנתונים אינם יוצרים זכאות כספית דרך Siton. עמלת מפיץ היא 0; אין יתרה, ארנק, משיכה, payout, חשבונית או זכות פיננסית.</p>
        </div>
      </header>

      <section class="cton-kpi-grid affiliate-kpi-grid" aria-label="מדדי הפצה מרכזיים">
        <article class="cton-kpi"><span>קליקים</span><strong>${num(totals.clicks || 0)}</strong></article>
        <article class="cton-kpi"><span>כניסות ייחודיות</span><strong>${num(totals.entries || 0)}</strong></article>
        <article class="cton-kpi"><span>הצטרפויות</span><strong>${num(totals.total_attributions || 0)}</strong></article>
        <article class="cton-kpi"><span>יחידות שיוחסו</span><strong>${num(totals.total_units || 0)}</strong></article>
        <article class="cton-kpi success"><span>ברוטו מיוחס</span><strong>${currency(totals.attributed_gross || 0)}</strong><small>מדד ייחוס, לא יתרה</small></article>
      </section>

      <section class="card section stack" id="affiliate-links">
        <div class="section-header"><div><h2>לינקים להפצה</h2><p class="muted">בחרו עסקה מורשית ותנו ללינק שם פנימי. כל לינק מקבל מקור ייחודי למדידה.</p></div><span class="stat-pill"><span>לינקים פעילים</span><strong>${num(links.length)}</strong></span></div>
        ${canCreateNamedLinks ? "" : `<div class="info-strip tone-warning"><strong>יצירת לינק חדש אינה זמינה בסביבה הזו</strong><p class="small">נדרש חיבור זהות מפיץ מאומתת לפני הפעלת פעולת כתיבה ב-production. לינקים ונתוני מדידה קיימים נשארים לקריאה בלבד.</p></div>`}
        <form class="affiliate-link-form" data-action="affiliate-link-create">
          <div class="field"><label for="affiliateDealId">עסקה להפצה</label><select id="affiliateDealId" name="affiliateDealId" required><option value="">בחירת עסקה</option>${shareableCampaigns.map((campaign) => `<option value="${esc(campaign.deal_id)}" ${state.form.affiliateDealId === campaign.deal_id ? "selected" : ""}>${esc(campaign.title)}</option>`).join("")}</select></div>
          <div class="field"><label for="affiliateLinkName">שם פנימי ללינק</label><input id="affiliateLinkName" name="affiliateLinkName" type="text" maxlength="80" value="${esc(state.form.affiliateLinkName)}" placeholder="למשל: קבוצת וואטסאפ שכונתית" required /></div>
          <button class="primary" type="submit" ${shareableCampaigns.length && canCreateNamedLinks ? "" : "disabled"}>יצירת לינק ייחודי</button>
        </form>
        ${links.length ? `<div class="card-list affiliate-link-list">${links.map((link) => `
          <article class="summary-item stack">
            <div class="actions spread"><div><span class="muted">${esc(link.title)}</span><h3>${esc(link.internal_name)}</h3></div><span class="badge ${DEAL_TONE[link.state] || "warning"}">${esc(getDealCopy(link.state).label)}</span></div>
            <p class="mono small">${esc(absoluteUrl(link.share_link))}</p>
            <div class="actions"><button class="primary" type="button" data-inline-action="copy-link" data-share-url="${esc(link.share_link)}">העתקה</button><button class="secondary" type="button" data-inline-action="share-link" data-share-url="${esc(link.share_link)}" data-share-title="${esc(link.title)}">שיתוף</button><a class="button secondary" href="#affiliate-performance">פתיחת ביצועים</a></div>
          </article>
        `).join("")}</div>` : `<div class="empty-surface"><strong>עדיין לא נוצרו לינקים בשם פנימי</strong><p class="small muted">בחרו עסקה פתוחה וצרו את הלינק הראשון. הלינק הקנוני של המפיץ נשאר זמין ברשימת העסקאות.</p></div>`}
      </section>

      <section class="card section stack" id="affiliate-performance">
        <div class="section-header"><div><h2>ביצועי לינקים</h2><p class="muted">הנתונים מצטברים ואינם כוללים שם, טלפון, אימייל או פרטי תשלום של קונים.</p></div></div>
        ${links.length ? `<div class="table-wrap"><table class="data-table affiliate-performance-table"><thead><tr><th>לינק</th><th>עסקה</th><th>קליקים</th><th>כניסות</th><th>הצטרפויות</th><th>המרה</th><th>יחידות</th><th>ברוטו מיוחס</th><th>מצב וזמן</th><th>כמות מול יעד</th></tr></thead><tbody>${links.map((link) => {
          const campaign = campaigns.find((item) => item.deal_id === link.deal_id) || {};
          const urgency = sellerDeadlineSignal(link.deadline, link.state);
          return `<tr><td>${esc(link.internal_name)}</td><td>${esc(link.title)}</td><td>${num(link.clicks)}</td><td>${num(link.entries)}</td><td>${num(link.attributed_buyers)}</td><td>${num(link.conversion_rate)}%</td><td>${num(link.attributed_units)}</td><td>${currency(campaign.attributed_gross || 0)}<small class="muted"> מדד בלבד</small></td><td>${esc(getDealCopy(link.state).label)}<br/><small>${esc(urgency.title)}</small></td><td>${num(link.joined_units)} / ${num(link.threshold_units)}</td></tr>`;
        }).join("")}</tbody></table></div>` : `<div class="empty-surface"><strong>אין עדיין ביצועים לפי לינק</strong><p class="small muted">אחרי יצירת לינק ופתיחתו יופיעו כאן קליקים, כניסות, המרות וייחוסים.</p></div>`}
      </section>

      <section class="card section stack" id="affiliate-assets">
        <div class="section-header"><div><h2>נכסי שיווק</h2><p class="muted">נכסים שהמוכר כבר סיפק. אפשר להעתיק, להוריד ולשתף — אי אפשר לערוך את תוכן העסקה מכאן.</p></div></div>
        ${campaigns.length ? `<div class="marketing-assets-grid">${campaigns.map((campaign) => `
          <article class="marketing-asset-card stack">
            ${campaign.image?.url ? `<img src="${esc(campaign.image.url)}" alt="${esc(campaign.title)}" />` : `<div class="marketing-asset-placeholder">${icon("package")}<span>אין תמונה שסופקה</span></div>`}
            <div><span class="badge ${DEAL_TONE[campaign.state] || "warning"}">${esc(getDealCopy(campaign.state).label)}</span><h3>${esc(campaign.title)}</h3><p>${esc(campaign.description || "המוכר לא סיפק תיאור שיווקי נוסף.")}</p></div>
            <p class="small muted"><strong>מידע אספקה:</strong> ${esc((campaign.delivery_labels || []).join(" · ") || "לא סופק מידע נוסף")}</p>
            <div class="actions"><button class="secondary" type="button" data-inline-action="copy-text" data-copy-text="${esc(`${campaign.title}\n${campaign.description || ""}`)}">העתקת טקסט</button>${campaign.image?.url ? `<a class="button secondary" href="${esc(campaign.image.url)}" download>הורדת תמונה</a>` : ""}<button class="primary" type="button" data-inline-action="copy-link" data-share-url="${esc(campaign.share_link)}">העתקת לינק</button></div>
          </article>
        `).join("")}</div>` : `<div class="empty-surface"><strong>אין נכסים זמינים</strong><p class="small muted">נכסי שיווק יופיעו רק מעסקאות שהמוכר כבר יצר.</p></div>`}
      </section>
    </section>
  `;
}
function buildAdminUrgencySummary(payload, systemStatus, notificationStatus, invoiceStatus) {
  const criticalCount =
    Number(systemStatus?.operational_counts?.failed_webhooks || 0) +
    Number(payload?.forensics?.dlq_count || 0);
  const attentionCount =
    Number(payload?.totals?.exceptional || 0) +
    Number(notificationStatus?.failed || 0) +
    Number(invoiceStatus?.failed || 0);
  const steadyCount =
    Number(payload?.totals?.live || 0) +
    Number(systemStatus?.operational_counts?.active_outbox || 0);
  return [
    {
      tone: criticalCount > 0 ? "danger" : "success",
      label: "חריגים קריטיים",
      value: num(criticalCount),
      detail: criticalCount > 0 ? "יש כשלים פעילים שדורשים צלילה מיידית." : "לא זוהו כשלים קריטיים פתוחים כרגע."
    },
    {
      tone: attentionCount > 0 ? "warning" : "success",
      label: "דורש תשומת לב",
      value: num(attentionCount),
      detail: attentionCount > 0 ? "יש עסקאות, מסמכים או התראות שעדיין דורשים בקרה." : "אין עומס חריג שממתין כרגע לבדיקה."
    },
    {
      tone: "info",
      label: "פעילות שוטפת",
      value: num(steadyCount),
      detail: "משקף עסקאות חיות ותורים פעילים שנמצאים במעקב שוטף."
    }
  ];
}

function renderAdminUrgencyCards(cards) {
  return `
    <div class="admin-urgency-grid">
      ${cards.map((card) => `
        <article class="kpi-card ${card.tone}">
          <span class="muted">${esc(card.label)}</span>
          <strong>${esc(card.value)}</strong>
          <p class="small muted">${esc(card.detail)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAdminSearchResults(results) {
  if (!results.length) {
    return `<div class="empty-surface"><p class="muted">עדיין אין תוצאות. אפשר לחפש עסקאות, משתתפים או מזהי קונה.</p></div>`;
  }
  return `
    <div class="card-list admin-search-grid">
      ${results.map((item) => {
        const entityType = String(item.entity_type || "");
        const href =
          entityType === "deal"
            ? `/app/admin/deals/${encodeURIComponent(item.entity_id)}`
            : entityType === "participant"
              ? `/app/admin/participants/${encodeURIComponent(item.entity_id)}`
              : `/app/admin/users/${encodeURIComponent(item.headline)}`;
        const cta =
          entityType === "deal"
            ? "פתיחת פרופיל העסקה"
            : entityType === "participant"
              ? "פתיחת פרופיל המשתתף"
              : "פתיחת פרופיל משתמש";
        return `
          <article class="summary-item stack">
            <div class="actions spread">
              <div>
                <span class="muted">${esc(formatSupportScopeType(entityType === "participant" ? "participant" : entityType === "deal" ? "deal" : "system"))}</span>
                <h3>${esc(item.headline || item.entity_id)}</h3>
              </div>
              <strong>${esc(formatOperatorState(item.state, entityType === "deal" ? "deal_state" : "status"))}</strong>
            </div>
            <p class="small muted">מזהה: <span class="mono">${esc(item.entity_id)}</span></p>
            <p class="small muted">${esc(item.detail || "ללא פירוט נוסף כרגע.")}</p>
            <div class="actions">
              <a class="button secondary" href="${href}" data-nav="${href}">${cta}</a>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderSupportTicketCards(tickets) {
  if (!tickets.length) {
    return `<div class="empty-surface"><p class="muted">עדיין אין פניות פתוחות.</p></div>`;
  }
  return `
    <div class="card-list">
      ${tickets.map((ticket) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(formatSupportScopeType(ticket.scope_type))} · ${esc(ticket.scope_key)}</span>
              <h3>${esc(ticket.title)}</h3>
            </div>
            <strong>${esc(formatSupportTicketStatus(ticket.status))}</strong>
          </div>
          <div class="pill-row">
            <span class="stat-pill"><span>עדיפות</span><strong>${esc(formatSupportPriority(ticket.priority))}</strong></span>
            <span class="stat-pill"><span>עודכן</span><strong>${dt(ticket.updated_at || ticket.created_at)}</strong></span>
          </div>
          <p class="small muted">${esc(ticket.summary || "ללא סיכום")}</p>
          <form data-action="admin-support-update" data-ticket-id="${esc(ticket.ticket_id)}" class="inline-fields">
            <div class="field">
              <label>סטטוס</label>
              <select name="supportTicketStatus">
                ${["open","investigating","resolved"].map((option) => `<option value="${option}" ${ticket.status === option ? "selected" : ""}>${formatSupportTicketStatus(option)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>סיכום למפעיל</label>
              <input name="supportTicketSummary" type="text" value="${esc(ticket.summary || "")}" />
            </div>
            <button class="secondary" type="submit">שמירת עדכון</button>
          </form>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAdminPage() {
  const payload = state.adminPayload?.admin_surface;
  const mission = state.adminMissionPayload;
  const launch = state.adminLaunchPayload;
  const systemStatus = state.adminSystemStatusPayload?.system_status;
  const notificationStatus = state.adminNotificationsStatusPayload?.notifications;
  const invoiceStatus = state.adminInvoiceStatusPayload?.invoice_documents;
  const sellerRisk = state.adminSellerRiskPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("מרכז התפעול לא זמין", "לא הצלחנו לטעון עכשיו את מרכז התפעול.");
  const urgencyCards = buildAdminUrgencySummary(payload, systemStatus, notificationStatus, invoiceStatus);
  return `
    ${renderAdminMissionControl(mission)}
    <nav class="card admin-section-nav" aria-label="ניווט מרכז תפעול">
      <a href="#admin-urgent">דחוף עכשיו</a><a href="#admin-search">חיפוש ופרופילים</a><a href="#admin-kyc">KYC</a><a href="#admin-support">תמיכה</a><a href="#admin-system">מצב מערכת</a>
    </nav>
    <section class="hero" id="admin-urgent">
      <article class="card hero-main stack">
        <span class="badge warning">גישה תפעולית</span>
        <span class="eyebrow">ניהול, תמיכה ובקרה</span>
        <h1>C-ton Admin</h1>
        <p class="muted">כאן רואים תוך שניות מה תקין, מה דורש טיפול, ואיפה צריך לצלול לפרופיל עסקה, משתתף או משתמש. כל המשטח נשען על truth קנוני, בלי להבטיח פעולות חיצוניות שלא הופעלו.</p>
        <form class="stack" data-action="admin-search">
          <div class="field">
            <label for="adminQuery">חיפוש תפעולי</label>
            <input id="adminQuery" name="adminQuery" type="search" data-dir="ltr" value="${esc(state.form.adminQuery)}" placeholder="מזהה עסקה, מזהה משתתף, מזהה קונה או כותרת עסקה" />
          </div>
          <button class="primary" type="submit">חיפוש</button>
        </form>
        ${renderAdminUrgencyCards(urgencyCards)}
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight"><span class="muted">מצב מערכת</span><strong>${systemStatus?.app_health?.ok ? "תקין" : "דורש טיפול"}</strong><p class="small muted">${systemStatus?.app_health?.ok ? "בריאות השירות תקינה כרגע." : "יש סימן תפעולי שמצריך בדיקה."}</p></div>
        <div class="summary-item"><span class="muted">מצב סביבה</span><strong>${esc(formatEnvironmentLabel(systemStatus?.deployment?.mode || state.previewMeta?.preview?.deployment_mode || "preview"))}</strong></div>
        <div class="summary-item"><span class="muted">עסקאות חיות</span><strong>${num(payload.totals.live)}</strong></div>
        <div class="summary-item"><span class="muted">טיוטות פתוחות</span><strong>${num(payload.totals.draft)}</strong></div>
        <div class="summary-item"><span class="muted">פניות תמיכה פתוחות</span><strong>${num(systemStatus?.operational_counts?.open_support_tickets || payload.support_tickets.filter((ticket) => ticket.status !== "resolved").length)}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      ${renderAdminLaunchConsole(launch)}
    </section>
    <section class="card section stack">
      <h2>מה בוער עכשיו</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">עסקאות חריגות</span><strong>${num(payload.totals.exceptional)}</strong><p class="small muted">כולל עסקאות שנכשלו, בוטלו או תקועות בחלון טעון יותר.</p></div>
        <div class="summary-item"><span class="muted">התראות שנכשלו</span><strong>${num(notificationStatus?.failed || 0)}</strong><p class="small muted">מבט על ערוצי הודעות שלא הושלמו בהצלחה.</p></div>
        <div class="summary-item"><span class="muted">מסמכים שנכשלו</span><strong>${num(invoiceStatus?.failed || 0)}</strong><p class="small muted">רשומות מסמך שלא הגיעו ל־issued אמיתי.</p></div>
        <div class="summary-item"><span class="muted">רשומות DLQ</span><strong>${num(payload.forensics.dlq_count)}</strong><p class="small muted">אירועים שיצאו מתור העבודה התקין ודורשים בקרה.</p></div>
      </div>
    </section>
    <section class="card section stack" id="admin-support">
      <div class="section-header">
        <div>
          <h2>Support Cases</h2>
          <p class="small muted">תיקי קצה תפעוליים בלבד. המשטח לא משנה סטייטים ולא מפעיל כסף.</p>
        </div>
        <a class="button primary" href="/app/admin/support" data-nav="/app/admin/support">פתיחת Support Hub</a>
      </div>
      ${renderSupportCasesSummary(state.adminSupportCasesPayload)}
    </section>
    <section class="card section stack">
      <h2>עסקאות חריגות</h2>
      ${payload.exceptional_deals.length ? `<div class="card-list">${payload.exceptional_deals.map(renderAdminDealCard).join("")}</div>` : `<div class="empty-surface"><p class="muted">לא חזרו עסקאות חריגות כרגע.</p></div>`}
    </section>
    ${renderSellerEnforcementAdminSection(sellerRisk)}
    ${renderDemoReadinessSection(state.adminDemoReadinessPayload)}
    <section class="card section stack" id="admin-search">
      <h2>תוצאות חיפוש תפעולי</h2>
      <p class="small muted">החיפוש מפנה ישירות לפרופיל העסקה, המשתתף או המשתמש. אין כאן dump טכני של מזהים בלי מסלול המשך.</p>
      ${renderAdminSearchResults(payload.search_results)}
    </section>
    <section class="card section stack" id="admin-kyc">
      <h2>תור אימות ובקרה</h2>
      ${payload.kyc_queue.length ? `<div class="card-list">${payload.kyc_queue.map((item) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(item.subject_type)}</span>
              <h3>${esc(item.display_name)}</h3>
            </div>
            <strong>${esc(formatVerificationStatus(item.status))}</strong>
          </div>
          <p class="small muted">תחום התחשבנות: ${esc(item.detail || "לא זמין")} · עודכן ב-${dt(item.updated_at)}</p>
          <div class="actions">
            <form data-action="admin-kyc-decision" data-subject-type="${esc(item.subject_type)}" data-subject-id="${esc(item.subject_id)}" data-decision="approve" class="stack">
              <input type="hidden" name="adminNote" value="Approved during admin support refinement pass" />
              <button class="secondary" type="submit">אישור</button>
            </form>
            <form data-action="admin-kyc-decision" data-subject-type="${esc(item.subject_type)}" data-subject-id="${esc(item.subject_id)}" data-decision="reject" class="stack">
              <input type="hidden" name="adminNote" value="Rejected during admin support refinement pass" />
              <button class="secondary" type="submit">דחייה</button>
            </form>
          </div>
        </article>
      `).join("")}</div>` : `<div class="empty-surface"><p class="muted">אין כרגע פריטי אימות שממתינים לטיפול.</p></div>`}
    </section>
    <section class="card section stack">
      <h2>מרכז תמיכה פנימי</h2>
      <p class="small muted">הפניות נשענות על רשומות אמיתיות בלבד. אם אין פנייה פתוחה, לא ניצור תחושה שיש טיפול שכבר קיים.</p>
      <form class="stack" data-action="admin-support-create">
        <div class="inline-fields">
          <div class="field">
            <label>תחום פנייה</label>
            <select name="supportScopeType">
              ${["deal","participant","affiliate","seller","system"].map((option) => `<option value="${option}">${formatSupportScopeType(option)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>מזהה תחום</label>
            <input name="supportScopeKey" type="text" placeholder="מזהה עסקה, משתתף, מפיץ, מוכר או system" />
          </div>
        </div>
        <div class="field"><label>כותרת פנייה</label><input name="supportTitle" type="text" placeholder="סיכום קצר לפנייה" /></div>
        <div class="inline-fields">
          <div class="field">
            <label>עדיפות</label>
            <select name="supportPriority">
              <option value="normal">רגילה</option>
              <option value="high">גבוהה</option>
            </select>
          </div>
          <div class="field"><label>מה נדרש לבדיקה</label><input name="supportSummary" type="text" placeholder="מה דורש בדיקה או בירור?" /></div>
        </div>
        <button class="primary" type="submit">פתיחת פנייה</button>
      </form>
      ${renderSupportTicketCards(payload.support_tickets)}
    </section>
    <section class="card section stack">
      <h2>התחשבנות ותשלומים</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">עסקאות מוכר שהושלמו</span><strong>${num(payload.settlements.seller_workspace.completed_deals)}</strong></div>
        <div class="summary-item"><span class="muted">ברוטו למוכר</span><strong>${currency(payload.settlements.seller_workspace.gross_amount)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת פלטפורמה</span><strong>${currency(payload.settlements.seller_workspace.platform_fee_amount)}</strong></div>
      </div>
      <p class="small muted">המשטח הזה נשאר read-only ומתייחס רק למסלול הכספי של מוכרים ושל הפלטפורמה. הוא לא מציג payout rails חיצוניים כאילו הופעלו.</p>
    </section>
    <section class="card section stack" id="admin-system">
      <h2>מצב מערכת ותורים</h2>
      ${systemStatus ? `
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">בריאות אפליקטיבית</span><strong>${systemStatus.app_health.ok ? "תקין" : "דורש טיפול"}</strong></div>
          <div class="summary-item"><span class="muted">מצב תשלומים</span><strong>${esc(formatRuntimeModeLabel(systemStatus.integrations.payment.mode))}</strong></div>
          <div class="summary-item"><span class="muted">מצב התראות</span><strong>${esc(formatRuntimeModeLabel(systemStatus.integrations.notifications.mode))}</strong></div>
          <div class="summary-item"><span class="muted">התראות בהמתנה</span><strong>${num(notificationStatus?.pending || 0)}</strong></div>
          <div class="summary-item"><span class="muted">התראות שנכשלו</span><strong>${num(notificationStatus?.failed || 0)}</strong></div>
          <div class="summary-item"><span class="muted">מסמכים שהונפקו</span><strong>${num(invoiceStatus?.issued || 0)}</strong></div>
          <div class="summary-item"><span class="muted">מסמכים שנכשלו</span><strong>${num(invoiceStatus?.failed || 0)}</strong></div>
          <div class="summary-item"><span class="muted">תור שליחה פעיל</span><strong>${num(systemStatus.operational_counts.active_outbox)}</strong></div>
          <div class="summary-item"><span class="muted">Webhookים שנכשלו</span><strong>${num(systemStatus.operational_counts.failed_webhooks)}</strong></div>
          <div class="summary-item"><span class="muted">פניות תמיכה פתוחות</span><strong>${num(systemStatus.operational_counts.open_support_tickets)}</strong></div>
        </div>
        <div class="info-strip tone-info">
          <strong>גבול ההפעלה החיצונית</strong>
          <p>${esc(systemStatus.notes.join(" "))}</p>
        </div>
      ` : `<div class="empty-surface"><p class="muted">לא הצלחנו לטעון כרגע את מצב המערכת.</p></div>`}
    </section>
  `;
}

function renderDemoReadinessSection(dr) {
  if (!dr) {
    return `<section class="card section stack">
      <div class="section-header">
        <div><h2>מוכנות דמו</h2><p class="small muted">בדיקת מוכנות סביבת הדמו להצגה.</p></div>
        <button class="secondary" data-action="refresh-demo-readiness">בדוק שוב</button>
      </div>
      <div class="empty-surface"><p class="muted">לא ניתן לבדוק מוכנות דמו כרגע. נסה שוב.</p></div>
    </section>`;
  }
  const verdictLabel = dr.verdict === "ready" ? "מוכן" : dr.verdict === "warning" ? "אזהרה" : "חסום";
  const verdictTone  = dr.verdict === "ready" ? "success" : dr.verdict === "warning" ? "warning" : "danger";
  const blockers = dr.blockers || [];
  const warnings = dr.warnings || [];
  const env  = dr.environment || {};
  const dep  = dr.deploy_freshness || {};
  const db   = dr.database || {};
  const prov = dr.providers || {};
  const q    = dr.queues || {};
  const demo = dr.demo_data || {};
  const pc   = dr.product_contract || {};

  function card(title, ok, evidenceLine, issues) {
    const tone = ok ? "success" : "warning";
    const issueHtml = issues && issues.length
      ? `<ul class="small muted" style="margin:0;padding-right:1rem">${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
      : "";
    return `<article class="summary-item stack">
      <div class="actions spread">
        <strong>${esc(title)}</strong>
        <span class="badge ${tone}">${ok ? "תקין" : "דורש בדיקה"}</span>
      </div>
      <p class="small muted">${esc(evidenceLine)}</p>
      ${issueHtml}
    </article>`;
  }

  const deployOk = !dep.is_stale;
  const deployEvidence = dep.evidence || (dep.runtime_commit_sha ? `commit: ${dep.runtime_commit_sha}` : "לא ידוע");
  const deployIssues = blockers.filter((b) => b.includes("commit")).concat(warnings.filter((w) => w.includes("commit")));

  const providerIssues = warnings.filter((w) => w.includes("provider") || w.includes("mock"));
  const outboxOk = q.dlq_count === 0 && q.outbox_failed === 0;
  const outboxEvidence = `ממתין: ${q.outbox_pending || 0} · נכשל: ${q.outbox_failed || 0} · DLQ: ${q.dlq_count || 0}`;
  const outboxIssues = blockers.concat(warnings).filter((x) => x.includes("outbox") || x.includes("DLQ"));

  const demoDataOk = demo.has_demo_seller && demo.has_public_deal;
  const demoDataEvidence = [
    demo.has_demo_seller ? "מוכר קיים" : "אין מוכר",
    demo.has_public_deal ? "עסקה פומבית" : "אין עסקה פומבית",
    demo.has_joinable_deal ? "עסקה פתוחה להצטרפות" : "אין עסקה לצירוף",
    demo.has_completed_deal ? "עסקה הושלמה" : "אין עסקה שהושלמה"
  ].join(" · ");
  const demoDataIssues = warnings.filter((w) => w.includes("deal") || w.includes("seller"));

  const contractOk = pc.platform_fee_8_percent && pc.link_only_no_marketplace;
  const contractEvidence = `עמלה: ${pc.platform_fee_rate !== undefined ? (pc.platform_fee_rate * 100).toFixed(0) + "%" : "לא ידוע"} · קישור בלבד: כן · attribution בלבד: כן`;

  return `<section class="card section stack">
    <div class="section-header">
      <div>
        <h2>מוכנות דמו</h2>
        <p class="small muted">בדיקת מוכנות כוללת לסביבת הדמו. לקריאה בלבד — לא מפעיל ספקים ולא משנה סטייטים.</p>
      </div>
      <button class="secondary" data-action="refresh-demo-readiness">בדוק שוב</button>
    </div>
    <div class="info-strip tone-${verdictTone}">
      <strong>פסיקה: ${esc(verdictLabel)}</strong>
      <p class="small">${blockers.length ? `${blockers.length} חסם/חסמים פעיל/ים.` : warnings.length ? `${warnings.length} אזהרה/ות.` : "הסביבה מוכנה להצגה."}</p>
    </div>
    <div class="summary-grid">
      ${card("Deploy", deployOk, deployEvidence, deployIssues)}
      ${card("מסד נתונים", db.ok, db.ok ? `טבלאות קריטיות נוכחות (${(dr.database.required_tables_present ? "כן" : "לא")})` : `בעיה: ${db.missing_tables?.join(", ") || "שגיאה"}`, blockers.filter((b) => b.includes("table") || b.includes("database")))}
      ${card("תשלום", !prov.payment?.is_mock || env.demo_preview, `${esc(prov.payment?.provider || "לא ידוע")} · ${esc(prov.payment?.mode || "לא ידוע")}`, providerIssues.filter((w) => w.includes("payment")))}
      ${card("חשבוניות", true, `${esc(prov.invoice?.provider || "לא ידוע")} · ${esc(prov.invoice?.mode || "לא ידוע")}`, [])}
      ${card("Outbox", outboxOk, outboxEvidence, outboxIssues)}
      ${card("נתוני דמו", demoDataOk, demoDataEvidence, demoDataIssues)}
      ${card("חוזה מוצר", contractOk, contractEvidence, blockers.filter((b) => b.includes("fee")))}
    </div>
    ${blockers.length ? `<div class="card-list">${blockers.map((b) => `<div class="info-strip tone-danger"><strong>חסם:</strong> <span>${esc(b)}</span></div>`).join("")}</div>` : ""}
    ${warnings.length ? `<div class="card-list">${warnings.map((w) => `<div class="info-strip tone-warning"><strong>אזהרה:</strong> <span>${esc(w)}</span></div>`).join("")}</div>` : ""}
    <p class="small muted" style="text-align:left;direction:ltr">${esc(dr.checked_at || "")}</p>
  </section>`;
}


function renderAdminLaunchConsole(launch) {
  if (!launch) {
    return `<h2>קונסולת השקה</h2><div class="empty-surface"><p class="muted">קונסולת ההשקה לא זמינה כרגע.</p></div>`;
  }
  const statusLabels = { green: "ירוק", yellow: "כתום", red: "אדום" };
  const statusTone = launch.system?.status === "red" ? "danger" : launch.system?.status === "yellow" ? "warning" : "success";
  const warnings = launch.recent_warnings || launch.system?.warnings || [];
  const recentDeals = launch.recent_deals || [];
  return `
    <h2>קונסולת השקה</h2>
    <p class="small muted">תמונת מצב פנימית וריכוז מוכנות לשוק. המשטח לקריאה בלבד ואינו מפעיל חיוב, החזר, שינוי סטייט או ספק חיצוני.</p>
    <div class="info-strip tone-${statusTone}">
      <strong>סטטוס השקה: ${esc(statusLabels[launch.system?.status] || launch.system?.status || "לא ידוע")}</strong>
      <p class="small">${warnings.length ? "יש פריטים שדורשים בקרה לפני יציאה רחבה." : "לא נמצאו חריגות קריטיות בקונסולת ההשקה."}</p>
    </div>
    <div class="summary-grid">
      <div class="summary-item summary-spotlight"><span class="muted">מוכרים מוכנים</span><strong>${num(launch.sellers?.publish_ready || 0)} / ${num(launch.sellers?.total || 0)}</strong><p class="small muted">חסרי פרטים: ${num(launch.sellers?.incomplete_profile || 0)}</p></div>
      <div class="summary-item"><span class="muted">עסקאות</span><strong>${num(launch.deals?.total || 0)}</strong><p class="small muted">טיוטות ${num(launch.deals?.draft || 0)} · פעילות ${num((launch.deals?.pending_target || 0) + (launch.deals?.target_reached || 0))} · הושלמו ${num(launch.deals?.completed || 0)}</p></div>
      <div class="summary-item"><span class="muted">עסקאות חסרות תמונה</span><strong>${num(launch.launch_readiness?.deals_missing_images || 0)}</strong></div>
      <div class="summary-item"><span class="muted">הסכמות משפטיות</span><strong>${num((launch.legal?.seller_publish_acceptances || 0) + (launch.legal?.buyer_join_acceptances || 0) + (launch.legal?.buyer_payment_disclosures || 0))}</strong><p class="small muted">מוכר ${num(launch.legal?.seller_publish_acceptances || 0)} · קונה ${num(launch.legal?.buyer_join_acceptances || 0)} · מסגרת ${num(launch.legal?.buyer_payment_disclosures || 0)}</p></div>
      <div class="summary-item"><span class="muted">הודעות מערכת</span><strong>${num(launch.notifications?.pending || 0)} בהמתנה</strong><p class="small muted">נשלחו ${num(launch.notifications?.sent || 0)} · נכשלו ${num(launch.notifications?.failed || 0)}</p></div>
      <div class="summary-item"><span class="muted">מצב ספק הודעות</span><strong>${esc(launch.notifications?.mode || "פנימי")}</strong><p class="small muted">${launch.notifications?.external_delivery ? "שליחה חיצונית פעילה." : "ספק הודעות במצב פנימי בלבד."}</p></div>
      <div class="summary-item"><span class="muted">Excel לעסקאות שהושלמו</span><strong>${num(launch.launch_readiness?.completed_deals_with_excel_available || 0)}</strong></div>
      <div class="summary-item"><span class="muted">חסרות הסכמת מוכר</span><strong>${num(launch.launch_readiness?.deals_missing_legal_acceptance || 0)}</strong></div>
    </div>
    ${warnings.length ? `
      <div class="card-list">
        ${warnings.map((warning) => `
          <article class="summary-item stack">
            <div class="actions spread">
              <strong>${esc(warning.message || warning.code || "אזהרת השקה")}</strong>
              <span class="badge ${warning.severity === "red" ? "danger" : "warning"}">${esc(warning.severity === "red" ? "קריטי" : "לתשומת לב")}</span>
            </div>
            ${warning.count != null ? `<p class="small muted">כמות: ${num(warning.count)}</p>` : ""}
          </article>
        `).join("")}
      </div>
    ` : ""}
    <h3>עסקאות אחרונות</h3>
    ${recentDeals.length ? `<div class="card-list">${recentDeals.map((deal) => `
      <article class="summary-item stack">
        <div class="actions spread">
          <div>
            <span class="muted">${esc(getDealCopy(deal.state).label)}</span>
            <h3>${esc(deal.title || deal.deal_id)}</h3>
          </div>
          <strong>${deal.has_excel_export_available ? "Excel זמין" : "ללא Excel"}</strong>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>תמונה</span><strong>${deal.has_image ? "קיימת" : "חסרה"}</strong></span>
          <span class="stat-pill"><span>פרופיל מוכר</span><strong>${deal.has_seller_profile ? "תקין" : "חסר"}</strong></span>
          <span class="stat-pill"><span>הסכמת מוכר</span><strong>${deal.has_seller_terms_acceptance ? "שמורה" : "חסרה"}</strong></span>
        </div>
        <p class="small muted">מוכר: ${esc(deal.seller_business_name || deal.seller_id || "לא זמין")} · עודכן ב-${dt(deal.updated_at || deal.created_at)}</p>
      </article>
    `).join("")}</div>` : `<div class="empty-surface"><p class="muted">אין עסקאות להצגה בקונסולת ההשקה.</p></div>`}
  `;
}

function renderSellerEnforcementAdminSection(payload) {
  const sellers = Array.isArray(payload?.sellers) ? payload.sellers : [];
  return `
    <section class="card section stack seller-enforcement-section">
      <div class="section-header">
        <div class="stack compact compact-section">
          <span class="eyebrow">Seller Enforcement</span>
          <h2>Seller Enforcement</h2>
          <p class="muted section-intro">התערבות נקודתית בלבד: מוכרים מתחילים Active, ורק חריגים מופיעים כאן.</p>
        </div>
        <span class="stat-pill"><span>חריגים</span><strong>${num(sellers.length)}</strong></span>
      </div>
      ${sellers.length ? `<div class="card-list">${sellers.map(renderSellerEnforcementCard).join("")}</div>` : `<div class="empty-surface"><p class="muted">אין כרגע מוכרים בסטטוס אכיפה חריג.</p></div>`}
    </section>
  `;
}

function formatCaseStatus(value) {
  return ({
    Open: "פתוח",
    NeedsSeller: "ממתין למוכר",
    NeedsAdmin: "דורש אדמין",
    WaitingExternal: "ממתין לגורם חיצוני",
    Resolved: "נפתר",
    Closed: "נסגר"
  })[value] || value || "";
}

function formatCaseType(value) {
  return ({
    RefundRequest: "מחלוקת מסחרית",
    DeliveryIssue: "בעיית אספקה",
    SellerRisk: "סיכון מוכר",
    BuyerComplaint: "תלונת קונה",
    PaymentMismatch: "פער תשלום",
    InvoiceIssue: "בעיית חשבונית",
    ContentReport: "דיווח תוכן",
    SystemException: "חריגת מערכת",
    Other: "אחר"
  })[value] || value || "";
}

function casePriorityTone(priority) {
  if (priority === "Urgent") return "danger";
  if (priority === "High") return "warning";
  if (priority === "Low") return "info";
  return "success";
}

function caseAge(createdAt) {
  const ts = createdAt ? new Date(createdAt).getTime() : 0;
  if (!ts) return "";
  const hours = Math.max(0, Math.floor((Date.now() - ts) / 36e5));
  if (hours < 1) return "פחות משעה";
  if (hours < 24) return `${hours} שעות`;
  return `${Math.floor(hours / 24)} ימים`;
}

function renderSupportCasesSummary(payload) {
  const summary = payload?.summary || {};
  return `
    <div class="summary-grid">
      <a class="summary-item" href="/app/admin/support" data-nav="/app/admin/support"><span class="muted">Open cases</span><strong>${num(summary.open_count || 0)}</strong></a>
      <a class="summary-item" href="/app/admin/support" data-nav="/app/admin/support"><span class="muted">NeedsAdmin</span><strong>${num(summary.needs_admin_count || 0)}</strong></a>
      <a class="summary-item" href="/app/admin/support" data-nav="/app/admin/support"><span class="muted">Urgent</span><strong>${num(summary.urgent_count || 0)}</strong></a>
      <a class="summary-item" href="/app/admin/support" data-nav="/app/admin/support"><span class="muted">מעל 48 שעות</span><strong>${num(summary.older_than_48h_count || 0)}</strong></a>
    </div>
  `;
}

function renderSupportCasesTable(cases) {
  if (!cases.length) return `<div class="empty-surface"><p class="muted">אין תיקי תפעול פתוחים לפי הסינון הנוכחי.</p></div>`;
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Priority</th><th>Status</th><th>Type</th><th>Subject</th><th>Deal</th><th>Seller</th><th>Age</th><th>Assigned To</th><th>Last Updated</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${cases.map((item) => `
            <tr>
              <td><span class="badge ${casePriorityTone(item.priority)}">${esc(item.priority)}</span></td>
              <td>${esc(formatCaseStatus(item.status))}</td>
              <td>${esc(formatCaseType(item.case_type))}</td>
              <td>${esc(item.subject || "")}${item.case_type === "RefundRequest" ? `<p class="small muted">סוג legacy זה מתועד כמחלוקת מסחרית בלבד. אין החזר כספי ידני דרך Support או דרך מסך זה.</p>` : ""}</td>
              <td>${item.deal_id ? `<a href="/app/admin/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(item.deal_id)}">${esc(item.deal_title || item.deal_id)}</a>` : ""}</td>
              <td>${esc(item.seller_name || item.seller_id || "")}</td>
              <td>${esc(caseAge(item.created_at))}</td>
              <td>${esc(item.assigned_to || "")}</td>
              <td>${dt(item.updated_at || item.created_at)}</td>
              <td>
                <form class="inline-fields" data-action="admin-case-update" data-case-id="${esc(item.case_id)}">
                  <select name="caseStatus">${["Open","NeedsSeller","NeedsAdmin","WaitingExternal","Resolved","Closed"].map((status) => `<option value="${status}" ${item.status === status ? "selected" : ""}>${formatCaseStatus(status)}</option>`).join("")}</select>
                  <select name="casePriority">${["Low","Normal","High","Urgent"].map((priority) => `<option value="${priority}" ${item.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}</select>
                  <input name="caseAssignedTo" type="text" value="${esc(item.assigned_to || "")}" placeholder="Assign" />
                  <input name="caseReason" type="text" placeholder="Reason" />
                  <button class="secondary" type="submit">Save</button>
                </form>
                <div class="actions">
                  <button class="secondary" type="button" data-inline-action="admin-case-escalate" data-case-id="${esc(item.case_id)}">Escalate</button>
                  <button class="secondary" type="button" data-inline-action="admin-case-close-open" data-case-id="${esc(item.case_id)}" data-subject="${esc(item.subject || "")}">Close</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAdminSupportPage() {
  const payload = state.adminSupportCasesPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("Support Hub לא זמין", "לא הצלחנו לטעון את תיקי התפעול.");
  const allowed = payload.allowed || {};
  return `
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <span class="eyebrow">Admin Support Hub</span>
          <h1>Support Hub</h1>
          <p class="muted section-intro">תיקי קצה בלבד: פניות, חריגים, תלונות, מחלוקות מסחריות ובעיות אמון. אין כאן approval gate, capture, refund, void או payout.</p>
        </div>
        <a class="button secondary" href="/app/admin" data-nav="/app/admin">חזרה לדשבורד</a>
      </div>
      ${renderSupportCasesSummary(payload)}
    </section>
    <section class="card section stack">
      <h2>סינון</h2>
      <form class="inline-fields" data-action="admin-case-filter">
        <select name="adminCaseStatus"><option value="">סטטוסים פתוחים</option>${(allowed.statuses || []).map((status) => `<option value="${status}" ${state.form.adminCaseStatus === status ? "selected" : ""}>${formatCaseStatus(status)}</option>`).join("")}</select>
        <select name="adminCaseType"><option value="">כל הסוגים</option>${(allowed.case_types || []).map((type) => `<option value="${type}" ${state.form.adminCaseType === type ? "selected" : ""}>${formatCaseType(type)}</option>`).join("")}</select>
        <select name="adminCasePriority"><option value="">כל העדיפויות</option>${(allowed.priorities || []).map((priority) => `<option value="${priority}" ${state.form.adminCasePriority === priority ? "selected" : ""}>${priority}</option>`).join("")}</select>
        <button class="secondary" type="submit">סינון</button>
      </form>
    </section>
    <section class="card section stack">
      <h2>פתח Case</h2>
      <form class="stack" data-action="admin-case-create">
        <div class="inline-fields">
          <select name="caseType">${(allowed.case_types || []).map((type) => `<option value="${type}">${formatCaseType(type)}</option>`).join("")}</select>
          <select name="casePriority">${(allowed.priorities || []).map((priority) => `<option value="${priority}" ${priority === "Normal" ? "selected" : ""}>${priority}</option>`).join("")}</select>
        </div>
        <input name="caseSubject" type="text" placeholder="Subject" />
        <div class="inline-fields">
          <input name="caseDealId" type="text" placeholder="Deal ID" data-dir="ltr" />
          <input name="caseSellerId" type="text" placeholder="Seller ID" data-dir="ltr" />
          <input name="caseParticipantId" type="text" placeholder="Participant ID" data-dir="ltr" />
        </div>
        <textarea name="caseDescription" rows="3" placeholder="Description"></textarea>
        <button class="primary" type="submit">פתיחת Case</button>
      </form>
    </section>
    <section class="card section stack">
      <h2>Operational Cases</h2>
      ${renderSupportCasesTable(payload.cases || [])}
    </section>
  `;
}

function renderSellerEnforcementCard(seller) {
  const actions = [
    ["UnderReview", "סמן לבדיקה"],
    ["Restricted", "הגבל פרסום"],
    ["Suspended", "השעה"],
    ["Banned", "חסום"],
    ["Active", "החזר לפעיל"]
  ].filter(([status]) => status !== seller.seller_status);
  return `
    <article class="summary-item stack">
      <div class="actions spread">
        <div>
          <span class="muted">מוכר</span>
          <h3>${esc(seller.seller_name || seller.display_name || seller.seller_id)}</h3>
          <p class="small muted mono">${esc(seller.seller_id)}</p>
        </div>
        <span class="badge ${sellerStatusTone(seller.seller_status)}">${esc(seller.seller_status || "Active")}</span>
      </div>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">סיבה</span><strong>${esc(seller.seller_status_reason || "לא נרשמה")}</strong></div>
        <div class="summary-item"><span class="muted">עודכן לאחרונה</span><strong>${dt(seller.seller_status_updated_at || seller.updated_at)}</strong></div>
        <div class="summary-item"><span class="muted">עודכן על ידי</span><strong>${esc(seller.seller_status_updated_by || "admin")}</strong></div>
      </div>
      <div class="actions">
        ${actions.map(([status, label]) => `
          <button class="secondary" type="button"
            data-inline-action="admin-seller-status-open"
            data-seller-id="${esc(seller.seller_id)}"
            data-seller-name="${esc(seller.seller_name || seller.display_name || seller.seller_id)}"
            data-status="${esc(status)}"
            data-label="${esc(label)}">${esc(label)}</button>
        `).join("")}
      </div>
    </article>
  `;
}

function renderSellerStatusModal() {
  const modal = state.adminSellerStatusModal;
  if (!modal) return "";
  const reason = state.adminSellerStatusReason || "";
  return `
    <section class="modal-backdrop" role="presentation">
      <div class="modal-panel stack" role="dialog" aria-modal="true" aria-labelledby="sellerStatusModalTitle">
        <div class="section-header">
          <div class="stack compact compact-section">
            <span class="eyebrow">Seller Enforcement</span>
            <h2 id="sellerStatusModalTitle">${esc(modal.label || "שינוי סטטוס מוכר")}</h2>
            <p class="muted section-intro">${esc(modal.sellerName || modal.sellerId)} · ${esc(modal.status)}</p>
          </div>
          <button class="secondary" type="button" data-inline-action="admin-seller-status-close" aria-label="סגירת חלון שינוי סטטוס">סגירה</button>
        </div>
        <form class="stack" data-action="admin-seller-status" data-seller-id="${esc(modal.sellerId)}" data-status="${esc(modal.status)}">
          <div class="field">
            <label for="adminSellerStatusReason">סיבה חובה</label>
            <textarea id="adminSellerStatusReason" name="adminSellerStatusReason" rows="4" required>${esc(reason)}</textarea>
          </div>
          <div class="actions">
            <button class="primary" type="submit" data-admin-seller-status-submit ${reason.trim() ? "" : "disabled"}>שמירת שינוי סטטוס</button>
            <button class="secondary" type="button" data-inline-action="admin-seller-status-close">ביטול</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderCaseCloseModal() {
  const modal = state.adminCaseCloseModal;
  if (!modal) return "";
  return `
    <section class="modal-backdrop" role="presentation">
      <div class="modal-panel stack" role="dialog" aria-modal="true" aria-labelledby="caseCloseModalTitle">
        <div class="section-header">
          <div class="stack compact compact-section">
            <span class="eyebrow">Support Hub</span>
            <h2 id="caseCloseModalTitle">סגירת Case</h2>
            <p class="muted section-intro">${esc(modal.subject || modal.caseId)}</p>
          </div>
          <button class="secondary" type="button" data-inline-action="admin-case-close-close">סגירה</button>
        </div>
        <form class="stack" data-action="admin-case-close" data-case-id="${esc(modal.caseId)}">
          <div class="field">
            <label for="adminCaseCloseResolution">resolution_note חובה</label>
            <textarea id="adminCaseCloseResolution" name="adminCaseCloseResolution" rows="4" required></textarea>
          </div>
          <div class="actions">
            <button class="primary" type="submit" data-admin-case-close-submit disabled>סגירת Case</button>
            <button class="secondary" type="button" data-inline-action="admin-case-close-close">ביטול</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function sellerStatusTone(status) {
  if (status === "Active") return "success";
  if (status === "UnderReview") return "warning";
  return "danger";
}

function renderAdminDealCard(item) {
  const dealCopy = getDealCopy(item.state);
  const tone = item.state === "Charging" || item.state === "CompletionWindow" || item.state === "Failed" || item.state === "Cancelled" ? "warning" : "info";
  return `
    <article class="summary-item stack">
      <div class="actions spread">
        <div>
          <span class="muted">${esc(dealCopy.label)}</span>
          <h3>${esc(item.title)}</h3>
        </div>
        <strong>${num(item.metrics.joined_units)} / ${num(item.max_units)}</strong>
      </div>
      <div class="pill-row">
        <span class="stat-pill"><span>סטטוס</span><strong>${esc(dealCopy.label)}</strong></span>
        <span class="stat-pill"><span>משתתפים</span><strong>${num(item.metrics.participants_count)}</strong></span>
        <span class="stat-pill"><span>קיבולת נותרת</span><strong>${num(item.metrics.remaining_units)}</strong></span>
      </div>
      <div class="info-strip tone-${tone}">
        <strong>${item.state === "Charging" || item.state === "CompletionWindow" ? "נדרש מעקב הדוק" : item.state === "Failed" || item.state === "Cancelled" ? "עסקה חריגה לסקירה" : "עסקה שחזרה לבקרה"}</strong>
        <p class="small">${esc(dealCopy.description)}</p>
      </div>
      <div class="actions">
        <a class="button primary" href="/app/admin/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(item.deal_id)}">פתיחת פרופיל העסקה</a>
        <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">מעבר למסך המוכר</a>
      </div>
    </article>
  `;
}

function renderAdminMissionControl(mission) {
  if (!mission) {
    return `
      <section class="card section stack">
        <h2>מרכז שליטה תפעולי</h2>
        <div class="empty-surface"><p class="muted">מרכז השליטה התפעולי לא זמין כרגע.</p></div>
      </section>
    `;
  }
  const generatedAt = mission.generated_at ? new Date(mission.generated_at) : null;
  const isStale = generatedAt ? (Date.now() - generatedAt.getTime()) / 1000 > Number(mission.stale_after_seconds || 60) : false;
  const statusTone = mission.system?.status === "red" ? "danger" : mission.system?.status === "yellow" ? "warning" : "success";
  const statusLabel = mission.system?.status === "red" ? "אדום" : mission.system?.status === "yellow" ? "כתום" : "ירוק";
  const exceptions = mission.exception_cards || [];
  const deals = mission.exceptional_deals || [];
  const results = mission.omnisearch?.results || [];
  return `
    <section class="card section stack mission-control">
      <div class="section-header">
        <div>
          <span class="eyebrow">קונסולת אדמין</span>
          <h2>מרכז שליטה תפעולי</h2>
          <p class="small muted">חיפוש תפעולי פנימי, חריגים, זיהוי מוכרים, תמיכה, יומן ביקורת ופיקוח על העברות למוכרים. אין כאן שינוי סטייט ידני, חיוב, זיכוי, ביטול חיוב או העברה כספית מתוך הממשק.</p>
        </div>
        <div class="actions">
          <span class="badge ${statusTone}">סטטוס ${statusLabel}</span>
          ${isStale ? `<span class="badge warning">נתונים עלולים להיות לא עדכניים</span>` : ""}
          <button class="secondary" type="button" data-inline-action="admin-refresh">רענון ידני</button>
          <button class="secondary" type="button" data-inline-action="admin-polling-toggle">${state.adminPollingPaused ? "הפעלת polling" : "עצירת polling"}</button>
        </div>
      </div>
      <p class="small muted">עודכן לאחרונה: ${dt(mission.generated_at)} · רענון אוטומטי ${state.adminPollingPaused ? "מושהה" : `כל ${num(Math.round(POLL_INTERVAL_MS / 1000))} שניות`}.</p>
      <form class="stack" data-action="admin-search">
        <div class="field">
          <label for="adminMissionQuery">Omnisearch אדמין</label>
          <input id="adminMissionQuery" name="adminQuery" type="search" data-dir="ltr" value="${esc(state.form.adminQuery)}" placeholder="מזהה עסקה, טלפון, אימייל, מוכר, correlation id, מסמך או payout batch" />
        </div>
        <button class="primary" type="submit">חיפוש תפעולי</button>
      </form>
      <div class="admin-urgency-grid">
        ${(exceptions.length ? exceptions : [{ label_he: "אין חריגים פעילים", count: 0, severity: "success", code: "no_active_exceptions" }]).map((item) => `
          <article class="kpi-card ${item.severity === "danger" ? "danger" : item.severity === "warning" ? "warning" : "success"}">
            <span class="muted">${esc(item.label_he || item.code)}</span>
            <strong>${num(item.count || 0)}</strong>
            <p class="small muted">${esc(formatMissionReason(item.code))}</p>
          </article>
        `).join("")}
      </div>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">Outbox פעיל</span><strong>${num(mission.system_status?.outbox?.active || 0)}</strong><p class="small muted">DLQ: ${num(mission.system_status?.outbox?.dlq || 0)}</p></div>
        <div class="summary-item"><span class="muted">הודעות מערכת</span><strong>${num(mission.system_status?.notifications?.active || 0)}</strong><p class="small muted">נכשלו: ${num(mission.system_status?.notifications?.failed || 0)}</p></div>
        <div class="summary-item"><span class="muted">חשבוניות והתאמה</span><strong>${num(mission.system_status?.invoices?.active_reconcile || 0)}</strong><p class="small muted">כשלי מסמך: ${num(mission.system_status?.invoices?.failed || 0)}</p></div>
        <div class="summary-item"><span class="muted">פיקוח העברות</span><strong>${num(mission.payouts_settlements?.active_batches || 0)}</strong><p class="small muted">פעולות כסף ידניות: לא פעילות</p></div>
      </div>
      ${renderAdminMissionControlDeep(mission)}
      ${renderAdminSafeActionModal()}
      <section class="compact-section stack">
        <h3>Omnisearch אדמין</h3>
        <p class="small muted">חיפוש תפעולי פנימי בלבד. זה אינו marketplace, אינו קטלוג ציבורי ואינו חיפוש עסקאות לקונים.</p>
        ${results.length ? renderAdminMissionSearchResults(results) : `<div class="empty-surface"><p class="muted">אין תוצאות חיפוש תפעולי כרגע.</p></div>`}
      </section>
      <section class="compact-section stack">
        <h3>עסקאות בעייתיות</h3>
        ${deals.length ? `<div class="card-list admin-ops-grid">${deals.slice(0, 8).map((deal) => `
          <article class="summary-item stack">
            <div class="actions spread">
              <div>
                <span class="muted">${esc(getDealCopy(deal.state).label)}</span>
                <h3>${esc(deal.title || deal.deal_id)}</h3>
              </div>
              <strong>${currency(deal.gross_amount || 0)}</strong>
            </div>
            <div class="pill-row">
              <span class="stat-pill"><span>יעד</span><strong>${num(deal.min_units)} / ${num(deal.max_units)}</strong></span>
              <span class="stat-pill"><span>חויבו</span><strong>${num(deal.charged_units)}</strong></span>
              <span class="stat-pill"><span>בהמתנה</span><strong>${num(deal.pending_units)}</strong></span>
              <span class="stat-pill"><span>לא חויב</span><strong>${num(deal.not_charged_units)}</strong></span>
            </div>
            <p class="small muted">סיבת חריג: ${esc(formatMissionReason(deal.exception_reason))} · מוכר: ${esc(deal.seller_name || deal.seller_id)} · עודכן: ${dt(deal.updated_at)}</p>
            <div class="actions"><a class="button secondary" href="/app/admin/deals/${encodeURIComponent(deal.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(deal.deal_id)}">כניסה לפרופיל עסקה</a></div>
          </article>
        `).join("")}</div>` : `<div class="empty-surface"><p class="muted">אין עסקאות חריגות כרגע.</p></div>`}
      </section>
      <div class="admin-ops-grid">
        <section class="compact-section stack">
          <h3>זיהוי מוכרים</h3>
          ${(mission.kyc_queue || []).length ? renderRowsTable((mission.kyc_queue || []).slice(0, 8), ["seller_id", "seller_name", "verification_status", "settlement_status", "missing_fields", "updated_at"]) : `<div class="empty-surface"><p class="muted">אין מוכרים שממתינים לבקרה כרגע.</p></div>`}
        </section>
        <section class="compact-section stack">
          <h3>Audit & Forensics</h3>
          ${(mission.audit_forensics?.recent_events || []).length ? renderRowsTable((mission.audit_forensics.recent_events || []).slice(0, 8), ["entity_type", "entity_id", "deal_id", "action_name", "created_at"]) : `<div class="empty-surface"><p class="muted">אין אירועי Audit להצגה כרגע.</p></div>`}
        </section>
      </div>
      <div class="info-strip tone-info">
        <strong>גבולות פעולות אדמין</strong>
        <p>המסך מאפשר בקרה, פתיחת פניות, זיהוי מוכרים דרך המסלולים הקיימים וצפייה בפיקוח העברות. הוא לא מאפשר שינוי סטייט ידני, חיוב, זיכוי, ביטול חיוב או העברה כספית ישירה.</p>
      </div>
    </section>
  `;
}

function renderAdminMissionControlDeep(mission) {
  const anomalies = mission.anomaly_center?.anomalies || [];
  const actions = state.adminActionsPayload?.actions || [];
  const sections = [
    ["system_summary", "System", mission.system_summary],
    ["database", "DB", mission.database],
    ["outbox", "Outbox", mission.outbox],
    ["workers", "Workers", mission.workers],
    ["webhooks", "Webhooks", mission.webhooks],
    ["payments", "Payments", mission.payments],
    ["invoices", "Invoices", mission.invoices],
    ["payouts", "Payouts", mission.payouts],
    ["notifications", "Notifications", mission.notifications],
    ["security", "Security", mission.security],
    ["frontend_surface", "Frontend", mission.frontend_surface],
    ["performance", "Performance", mission.performance]
  ];
  return `
    <section class="compact-section stack" id="mission-control">
      <div class="section-header">
        <div>
          <h3>Admin Mission Control</h3>
          <p class="small muted">תמונת אמת תפעולית read-only: ראיות, חריגים, drill-down והמלצות בטוחות בלבד.</p>
        </div>
        <span class="badge ${mission.verdict === "red" ? "danger" : mission.verdict === "yellow" ? "warning" : "success"}">${esc(formatMissionVerdict(mission.verdict))}</span>
      </div>
      <div class="admin-urgency-grid">
        ${sections.map(([key, title, section]) => renderMissionStatusCard(key, title, section)).join("")}
      </div>
    </section>
    <section class="compact-section stack" id="anomaly-center">
      <div class="section-header">
        <div>
          <h3>Anomaly Center</h3>
          <p class="small muted">חריגים מסודרים לפי חומרה. פתיחת trace מובילה למסכי drill-down או לפרופיל ישות קיים.</p>
        </div>
        <span class="badge ${anomalies.some((a) => a.severity === "critical") ? "danger" : anomalies.length ? "warning" : "success"}">${num(anomalies.length)} חריגים</span>
      </div>
      ${anomalies.length ? renderMissionAnomalyTable(anomalies) : `<div class="empty-surface"><p class="muted">לא נמצאו חריגים קריטיים לפי הבדיקות הקיימות.</p><p class="small muted">סקשנים שלא ניתן לבדוק מוצגים כלא ידוע ולא כהצלחה.</p></div>`}
    </section>
    <section class="compact-section stack" id="admin-actions">
      <div class="section-header">
        <div>
          <h3>Admin Actions</h3>
          <p class="small muted">היסטוריית Safe Actions: פעולות מערכת מבוקרות, מתועדות ואידמפוטנטיות. אין כאן עריכת state או כסף ידנית.</p>
        </div>
        <button class="secondary" type="button" data-inline-action="admin-safe-action-open" data-action-type="open_support_case" data-target-type="system" data-target-id="mission-control">פתיחת Safe Action</button>
      </div>
      ${actions.length ? renderRowsTable(actions.slice(0, 20), ["created_at", "action_type", "target_type", "target_id", "status", "requested_by_admin_id", "correlation_id", "result_code"]) : `<div class="empty-surface"><p class="muted">עדיין אין פעולות אדמין מתועדות.</p></div>`}
    </section>
    <section class="compact-section stack">
      <h3>System Timeline / אירועים קריטיים אחרונים</h3>
      ${(mission.audit_forensics?.recent_events || []).length ? renderRowsTable((mission.audit_forensics.recent_events || []).slice(0, 20), ["entity_type", "entity_id", "deal_id", "action_name", "state_type", "from_state", "to_state", "created_at"]) : `<div class="empty-surface"><p class="muted">אין אירועים אחרונים להצגה.</p></div>`}
    </section>
    <div class="admin-ops-grid">
      ${renderMissionSection("system_summary", "System", mission.system_summary, ["verdict", "runtime_env", "deploy_freshness_status", "uptime_seconds", "node_version", "platform", "timezone", "warnings_count", "critical_count"])}
      ${renderMissionSection("frontend_surface", "Frontend Surface", mission.frontend_surface, ["status", "last_modified", "issues"])}
      ${renderMissionSection("api_surface", "API Surface", mission.api_surface, ["status", "routes_detected", "routes_missing"])}
      ${renderMissionSection("database", "Database", mission.database, ["status", "connectivity", "missing_tables", "warnings"])}
      ${renderMissionSection("state_machine_integrity", "State Machine Integrity", mission.state_machine_integrity, ["status", "risk_level", "stuck_deals"])}
      ${renderMissionSection("outbox", "Outbox", mission.outbox, ["status", "pending", "processing", "failed", "dlq", "oldest_pending_age_seconds", "recommended_action"])}
      ${renderMissionSection("workers", "Workers", mission.workers, ["status", "enabled", "disabled_reason", "issues"])}
      ${renderMissionSection("webhooks", "Webhooks", mission.webhooks, ["status", "pending", "failed", "duplicates", "late_events", "secret_configured", "signature_verification_mode"])}
      ${renderMissionSection("payments", "Payments", mission.payments, ["status", "provider", "mode", "configured", "unknown_count", "reconcile_needed", "retry_storm_candidates"])}
      ${renderMissionSection("invoices", "Invoices", mission.invoices, ["status", "provider", "mode", "configured", "pending", "failed", "issued"])}
      ${renderMissionSection("payouts", "Payouts", mission.payouts, ["status", "provider_mode", "pending", "failed", "returned", "frozen"])}
      ${renderMissionSection("notifications", "Notifications", mission.notifications, ["status", "pending", "failed", "oldest_pending_age_seconds"])}
      ${renderMissionSection("security", "Security", mission.security, ["status", "admin_auth", "debug_surfaces", "public_debug_risk", "issues"])}
      ${renderMissionSection("storage_uploads", "Storage & Uploads", mission.storage_uploads, ["status", "adapter", "mime_policy", "size_limit", "path_traversal_protection", "issues"])}
      ${renderMissionSection("performance", "Performance", mission.performance, ["status", "generated_in_ms", "db_ping_ms", "latency_warnings"])}
      ${renderMissionSection("business_metrics", "Business Metrics", mission.business_metrics, ["active_deals", "draft_deals", "pending_target", "target_reached", "completion_window", "completed", "failed", "cancelled", "buyers_joined", "units_committed", "units_charged", "gross_charged", "platform_fee_total", "seller_net"])}
    </div>
  `;
}

function renderMissionStatusCard(key, title, section) {
  const status = section?.status || section?.verdict || "unknown";
  const tone = status === "red" ? "danger" : status === "yellow" || status === "unknown" ? "warning" : "success";
  const issues = Array.isArray(section?.issues) ? section.issues.length : Array.isArray(section?.warnings) ? section.warnings.length : 0;
  return `
    <a class="kpi-card ${tone}" href="#mission-section-${esc(key)}">
      <span class="muted">${esc(title)}</span>
      <strong>${esc(formatMissionVerdict(status))}</strong>
      <p class="small muted">${num(issues)} אזהרות/סוגיות</p>
    </a>
  `;
}

function renderMissionAnomalyTable(anomalies) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>חומרה</th><th>Domain</th><th>כותרת</th><th>ישות מושפעת</th><th>גיל</th><th>הצעד הבטוח הבא</th><th>Trace</th></tr></thead>
        <tbody>
          ${anomalies.map((item) => {
            const entity = (item.affected_entities || [])[0] || {};
            const link = item.link_target || (entity.type === "deal" && entity.id ? `/app/admin/deals/${encodeURIComponent(entity.id)}` : entity.type === "participant" && entity.id ? `/app/admin/participants/${encodeURIComponent(entity.id)}` : "/app/admin");
            return `
              <tr>
                <td><span class="badge ${item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : "success"}">${esc(formatMissionSeverity(item.severity))}</span></td>
                <td>${esc(item.domain || "לא ידוע")}</td>
                <td>${esc(item.title || "לא ידוע")}</td>
                <td>${esc(entity.type || "לא ידוע")}: ${esc(entity.id || "לא ידוע")}</td>
                <td>${item.age_seconds == null ? "לא ידוע" : `${num(Math.round(item.age_seconds))} שניות`}</td>
                <td>${esc(item.recommended_next_step || "בדיקה ידנית בטוחה בלבד")}</td>
                <td>
                  <div class="actions">
                    <a class="button secondary" href="${esc(link)}" data-nav="${esc(link)}">Open Trace</a>
                    <button class="secondary" type="button" data-inline-action="admin-safe-action-open" data-action-type="${esc(recommendedActionForDomain(item.domain))}" data-target-type="${esc(entity.type || "system")}" data-target-id="${esc(entity.id || item.id || "mission-control")}">Safe Actions</button>
                    ${item.evidence?.correlation_id ? `<button class="secondary" type="button" data-inline-action="copy-link" data-share-url="${esc(item.evidence.correlation_id)}">העתקת correlation</button>` : ""}
                  </div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function recommendedActionForDomain(domain) {
  const map = {
    outbox: "requeue_outbox_event",
    webhooks: "trigger_reconcile",
    payments: "trigger_reconcile",
    invoices: "retry_invoice_failed",
    payouts: "freeze_payouts",
    notifications: "retry_notification",
    security: "open_support_case"
  };
  return map[domain] || "open_support_case";
}

function renderAdminSafeActionModal() {
  const draft = state.adminSafeActionDraft;
  if (!draft) return "";
  return `
    <section class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="safeActionTitle">
      <div class="modal wide stack">
        <div class="section-header">
          <div>
            <h2 id="safeActionTitle">Safe Action</h2>
            <p class="small muted">הפעולה נרשמת כ-admin_action. היא לא משנה state ידנית, לא נוגעת בכסף ידנית ולא מוחקת ראיות.</p>
          </div>
          <button class="secondary" type="button" data-inline-action="admin-safe-action-close">סגירה</button>
        </div>
        <form class="stack" data-action="admin-safe-action-create">
          <input type="hidden" name="action_type" value="${esc(draft.action_type)}" />
          <input type="hidden" name="target_type" value="${esc(draft.target_type)}" />
          <input type="hidden" name="target_id" value="${esc(draft.target_id)}" />
          <div class="summary-grid">
            <div class="summary-item"><span class="muted">פעולה</span><strong>${esc(formatAdminActionType(draft.action_type))}</strong></div>
            <div class="summary-item"><span class="muted">Target</span><strong>${esc(draft.target_type)}: ${esc(draft.target_id)}</strong></div>
          </div>
          <div class="info-strip tone-info">
            <strong>מה הפעולה עושה</strong>
            <p>${esc(describeSafeAction(draft.action_type))}</p>
          </div>
          <div class="info-strip tone-warning">
            <strong>מה הפעולה לא עושה</strong>
            <p>לא עורכת state, לא מחייבת, לא מזכה, לא מוחקת payloads, לא מנקה DLQ ולא עוקפת idempotency.</p>
          </div>
          <div class="field">
            <label>reason חובה</label>
            <textarea name="reason" rows="4" required></textarea>
          </div>
          <label class="check-row">
            <input type="checkbox" name="safe_action_confirm" required />
            <span>אני מבין שהפעולה אינה משנה state ידנית ואינה עוקפת את חוקת C-ton.</span>
          </label>
          ${["freeze_payouts", "unfreeze_payouts", "pause_charging_emergency"].includes(draft.action_type) ? `<span class="badge warning">דורש אישור מנהל נוסף</span>` : ""}
          <div class="actions">
            <button class="primary" type="submit">יצירת Safe Action</button>
            <button class="secondary" type="button" data-inline-action="admin-safe-action-close">ביטול</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function formatAdminActionType(type) {
  const map = {
    trigger_reconcile: "Trigger reconcile",
    requeue_outbox_event: "Requeue outbox event",
    retry_notification: "Retry notification",
    retry_invoice_failed: "Retry failed invoice",
    freeze_payouts: "Freeze payouts",
    unfreeze_payouts: "Unfreeze payouts",
    open_support_case: "Open support case"
  };
  return map[type] || type || "Safe Action";
}

function describeSafeAction(type) {
  const map = {
    trigger_reconcile: "מבקשת מהמערכת לבדוק מחדש מצב מול מקור אמת קיים. אם אין worker בטוח, הפעולה תסומן NotImplemented.",
    requeue_outbox_event: "מחזירה אירוע outbox תקוע ל-pending רק אם הוא לא הסתיים בהצלחה.",
    retry_notification: "מחזירה notification שנכשלה לתור retry בלי לייצר כפילות אם כבר נשלחה.",
    retry_invoice_failed: "מנסה שוב מסמך failed בלבד ורק אם אין provider reference שמעלה סיכון לכפילות.",
    freeze_payouts: "מבקשת הקפאת payout במסלול מבוקר ודורשת אישור נוסף.",
    open_support_case: "פותחת או מאתרת תיק תמיכה פתוח עבור היעד."
  };
  return map[type] || "מתעדת בקשת פעולה. אם אין מסילה בטוחה, היא תישאר NotImplemented.";
}

function renderMissionSection(id, title, section, keys) {
  const status = section?.status || "unknown";
  const tone = status === "red" ? "danger" : status === "yellow" || status === "unknown" ? "warning" : "success";
  return `
    <section class="compact-section stack" id="mission-section-${esc(id)}">
      <div class="section-header">
        <h3>${esc(title)}</h3>
        <span class="badge ${tone}">${esc(formatMissionVerdict(status))}</span>
      </div>
      <div class="summary-grid">
        ${keys.map((key) => `
          <div class="summary-item">
            <span class="muted">${esc(key)}</span>
            <strong>${esc(formatMissionValue(section?.[key]))}</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function formatMissionValue(value) {
  if (value === null || value === undefined || value === "") return "לא ידוע";
  if (typeof value === "boolean") return value ? "כן" : "לא";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.slice(0, 4).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", ") : "אין";
  if (typeof value === "object") return Object.entries(value).slice(0, 4).map(([key, item]) => `${key}: ${formatMissionValue(item)}`).join(" · ");
  return String(value);
}

function formatMissionVerdict(value) {
  const map = { green: "ירוק", yellow: "צהוב", red: "אדום", unknown: "לא ידוע" };
  return map[value] || value || "לא ידוע";
}

function formatMissionSeverity(value) {
  const map = { critical: "קריטי", warning: "אזהרה", info: "מידע" };
  return map[value] || value || "לא ידוע";
}

function formatMissionReason(reason) {
  const map = {
    completion_window_ending_soon: "חלון השלמה מסתיים בקרוב",
    dlq_not_empty: "אירועים יצאו מתור העבודה התקין",
    charging_in_progress: "תהליך חיוב פעיל",
    deal_failed: "עסקה נכשלה",
    completed_without_charged_success: "עסקה הושלמה בלי חיוב מוצלח מתועד",
    pending_target_near_deadline: "קרובה לדדליין ועדיין לא הגיעה ליעד",
    payout_exception: "חריג בפיקוח payout",
    invoice_issue_failed: "כשל במסמך או חשבונית",
    operational_attention: "דורשת תשומת לב תפעולית"
  };
  return map[reason] || reason || "דורשת תשומת לב תפעולית";
}

function renderAdminMissionSearchResults(results) {
  return `
    <div class="card-list admin-search-grid">
      ${results.map((item) => {
        const route = item.route || "/app/admin";
        return `
          <article class="summary-item stack">
            <div class="actions spread">
              <div>
                <span class="muted">${esc(formatMissionEntityType(item.entity_type))}</span>
                <h3>${esc(item.headline || item.entity_id)}</h3>
              </div>
              <strong>${esc(formatOperatorState(item.status, "status"))}</strong>
            </div>
            <p class="small muted">מזהה: <span class="mono">${esc(item.entity_id)}</span></p>
            <p class="small muted">מסלול: ${esc(formatMissionResultKind(item.result_kind))}</p>
            <div class="actions">
              <a class="button secondary" href="${esc(route)}" data-nav="${esc(route)}">פתיחת פריט תפעולי</a>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function formatMissionEntityType(type) {
  const map = {
    deal: "עסקה",
    participant: "משתתף",
    seller: "מוכר",
    support_ticket: "פניית תמיכה",
    invoice_document: "מסמך",
    payout_batch: "אצוות payout"
  };
  return map[type] || type || "פריט תפעולי";
}

function formatMissionResultKind(kind) {
  const map = {
    admin_deal_profile: "פרופיל עסקה לאדמין",
    admin_participant_profile: "פרופיל משתתף לאדמין",
    admin_seller_kyc: "תור זיהוי מוכר",
    admin_support_ticket: "מרכז תמיכה",
    admin_invoice_document: "מסמך תפעולי",
    admin_payout_batch: "פיקוח העברות"
  };
  return map[kind] || kind || "תוצאה תפעולית";
}

function renderAdminDealPage() {
  const payload = state.adminDealPayload?.profile;
  const ops = state.adminDealOpsPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("פרופיל העסקה לתפעול לא זמין", "לא הצלחנו לטעון עכשיו את פרופיל העסקה לתפעול.");
  const participantsByState = summarizeParticipantStateBuckets(ops?.participants?.by_state || {});
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">פרופיל עסקה לתפעול</span>
        <h1>${esc(payload.deal.title || payload.deal.deal_id)}</h1>
        <p class="muted">משטח בקרה לקריאת מצב העסקה, המשתתפים, המסמכים, ההתראות ותור העבודה, בלי לרמוז על פעולה שלא קיימת בפועל.</p>
        <div class="summary-grid">
          <div class="summary-item summary-spotlight"><span class="muted">סטטוס עסקה</span><strong>${esc(getDealCopy(payload.deal.state).label)}</strong><p class="small muted">${esc(getDealCopy(payload.deal.state).description)}</p></div>
          <div class="summary-item"><span class="muted">מזהה עסקה</span><strong class="mono">${esc(payload.deal.deal_id)}</strong></div>
          <div class="summary-item"><span class="muted">יעד בסיס</span><strong>${num(payload.deal.threshold_units)}</strong></div>
          <div class="summary-item"><span class="muted">מועד סיום</span><strong>${dt(payload.deal.deadline)}</strong></div>
        </div>
        ${ops ? renderAdminDealOpsHero(ops) : ""}
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">משתתפים כוללים</span><strong>${num(ops?.participants?.total || payload.participants.length)}</strong></div>
        <div class="summary-item"><span class="muted">התראות פעילות</span><strong>${num((ops?.notifications?.pending || 0) + (ops?.notifications?.processing || 0))}</strong></div>
        <div class="summary-item"><span class="muted">מסמכים שהונפקו</span><strong>${num(ops?.invoice_documents?.issued || 0)}</strong></div>
        <div class="summary-item"><span class="muted">תור עבודה פעיל</span><strong>${num((ops?.outbox?.pending || 0) + (ops?.outbox?.processing || 0))}</strong></div>
        <div class="actions">
          <a class="button secondary" href="/app/admin" data-nav="/app/admin">חזרה למרכז התפעול</a>
          <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(payload.deal.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(payload.deal.deal_id)}">מעבר למסך המוכר</a>
        </div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>תמונת משתתפים</h2>
      ${participantsByState.length ? `<div class="summary-grid">${participantsByState.map((item) => `<div class="summary-item"><span class="muted">${esc(item.label)}</span><strong>${num(item.count)}</strong></div>`).join("")}</div>` : `<div class="empty-surface"><p class="muted">עדיין אין נתוני משתתפים מסוכמים לעסקה הזו.</p></div>`}
      ${payload.participants.length ? renderAdminParticipantCards(payload.participants) : `<div class="empty-surface"><p class="muted">לא נמצאו משתתפים לעסקה הזו.</p></div>`}
    </section>
    <section class="card section stack"><h2>תור עבודה והתראות</h2>${ops ? renderAdminDealOpsBuckets(ops) : `<div class="empty-surface"><p class="muted">סיכום התורים לא זמין כרגע.</p></div>`}</section>
    <section class="card section stack"><h2>ניסיונות חיוב מתועדים</h2>${payload.payment_attempts.length ? renderRowsTable(payload.payment_attempts, ["attempt_type", "correlation_id", "result_class", "created_at"]) : `<div class="empty-surface"><p class="muted">לא נמצאו ניסיונות חיוב לעסקה הזו.</p></div>`}</section>
    <section class="card section stack"><h2>ייחוס ותמיכה</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">ייחוסי שיתוף</span><strong>${num(payload.affiliate_attributions.length)}</strong></div>
        <div class="summary-item"><span class="muted">פניות תמיכה</span><strong>${num(payload.support_tickets.length)}</strong></div>
      </div>
      ${payload.affiliate_attributions.length ? renderTablePanel("ייחוסי שיתוף", "מופיעים רק שיוכים שנרשמו בפועל במערכת.", payload.affiliate_attributions, ["participant_id", "share_code", "display_name"]) : ""}
        <div class="summary-item"><span class="muted">פניות תמיכה</span><strong>${num(payload.support_tickets.length)}</strong></div>
    </section>
    <section class="card section stack"><h2>יומן בקרה</h2>${payload.audit.length ? renderTablePanel("Audit אחרון", "יומן הפעולות האחרון שמסביר איך העסקה התקדמה בין מצבים.", payload.audit, ["entity_type", "state_type", "from_state", "to_state", "action_name", "created_at"]) : `<div class="empty-surface"><p class="muted">לא נמצאו אירועי audit לעסקה הזו.</p></div>`}</section>
  `;
}

function renderAdminParticipantPage() {
  const payload = state.adminParticipantOpsPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("פרופיל המשתתף לתפעול לא זמין", "לא הצלחנו לטעון עכשיו את פרופיל המשתתף.");
  const participant = payload.participant;
  const opsSummary = summarizeParticipantOps(payload);
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">פרופיל משתתף לתפעול</span>
        <h1>${esc(participant.deal_title)}</h1>
        <p class="muted">מסך תפעולי לקריאת מצב ההשתתפות, ההתראות, המסמכים ותור העבודה של המשתתף, בלי להציג truth שלא נרשם בפועל.</p>
        <div class="summary-grid">
          <div class="summary-item summary-spotlight"><span class="muted">מצב השתתפות</span><strong>${esc(formatVisibleBuyerState(participant.buyer_state))}</strong><p class="small muted">${esc(formatVisibleMoneyState(participant.money_state))}</p></div>
          <div class="summary-item"><span class="muted">מזהה משתתף</span><strong class="mono">${esc(participant.participant_id)}</strong></div>
          <div class="summary-item"><span class="muted">מזהה קונה</span><strong>${esc(participant.buyer_id)}</strong></div>
          <div class="summary-item"><span class="muted">כמות</span><strong>${num(participant.qty)}</strong></div>
        </div>
        <div class="summary-grid">
          ${opsSummary.map((item) => `<div class="summary-item"><span class="muted">${esc(item.label)}</span><strong>${esc(item.value)}</strong><p class="small muted">${esc(item.detail)}</p></div>`).join("")}
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">סטטוס עסקה</span><strong>${esc(getDealCopy(participant.deal_state).label)}</strong></div>
        <div class="summary-item"><span class="muted">התראות מתועדות</span><strong>${num(payload.notifications.length)}</strong></div>
        <div class="summary-item"><span class="muted">מסמכים מתועדים</span><strong>${num(payload.invoice_documents.length)}</strong></div>
        <div class="summary-item"><span class="muted">אירועי תור לעסקה</span><strong>${num(payload.outbox_events_for_deal.length)}</strong></div>
        <div class="actions">
          <a class="button secondary" href="/app/admin/deals/${encodeURIComponent(participant.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(participant.deal_id)}">פתיחת העסקה</a>
          <a class="button secondary" href="/app/admin" data-nav="/app/admin">חזרה למרכז התפעול</a>
        </div>
      </aside>
    </section>
    <section class="card section stack"><h2>התראות</h2>${payload.notifications.length ? renderTablePanel("התראות למשתתף", "הטבלה מציגה רק התראות שנרשמו בפועל עבור המשתתף הזה.", payload.notifications.map((row) => ({ ...row, notification_status: row.status })), ["notification_event_type", "channel", "notification_status", "attempt_count", "provider_message_id", "sent_at", "created_at"]) : `<div class="empty-surface"><p class="muted">לא נמצאו התראות מתועדות למשתתף הזה.</p></div>`}</section>
    <section class="card section stack"><h2>מסמכים</h2>${payload.invoice_documents.length ? renderTablePanel("מסמכים למשתתף", "רק מסמכים שנשענים על invoice_documents אמיתיים מוצגים כאן.", payload.invoice_documents.map((row) => ({ ...row, document_status: row.status })), ["document_type", "document_status", "provider_document_id", "issued_at", "gross_amount", "money_state_at_issue", "created_at"]) : `<div class="empty-surface"><p class="muted">עדיין אין מסמך אמיתי שרשום למשתתף הזה.</p></div>`}</section>
    <section class="card section stack"><h2>תור עבודה רלוונטי לעסקה</h2>${payload.outbox_events_for_deal.length ? renderTablePanel("Outbox רלוונטי", "הטבלה מתארת את אירועי התור האחרונים שקשורים לעסקה של המשתתף.", payload.outbox_events_for_deal.map((row) => ({ ...row, outbox_status: row.status })), ["event_type", "aggregate_type", "aggregate_id", "outbox_status", "attempt_count", "created_at"]) : `<div class="empty-surface"><p class="muted">לא נמצאו אירועי תור רלוונטיים כרגע.</p></div>`}</section>
  `;
}

function renderAdminUserPage() {
  const payload = state.adminUserPayload?.profile;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("פרופיל המשתמש לתפעול לא זמין", "לא הצלחנו לטעון עכשיו את פרופיל המשתמש.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">פרופיל משתמש לתפעול</span>
        <h1>${esc(payload.buyer_id)}</h1>
        <p class="muted">כל ההצטרפויות של אותו קונה מרוכזות כאן כדי לאפשר תמיכת המשך בלי לנדוד בין מזהים וטבלאות.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">סך ההצטרפויות</span><strong>${num(payload.totals.total_joins)}</strong></div>
          <div class="summary-item"><span class="muted">הצטרפויות פעילות</span><strong>${num(payload.totals.active_joins)}</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="actions"><a class="button secondary" href="/app/admin" data-nav="/app/admin">חזרה למרכז התפעול</a></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>היסטוריית הצטרפויות</h2>
      ${payload.joins.length ? renderAdminUserJoinCards(payload.joins) : `<div class="empty-surface"><p class="muted">לא נמצאו הצטרפויות עבור המשתמש הזה.</p></div>`}
    </section>
  `;
}

function summarizeParticipantStateBuckets(byState) {
  const entries = Object.entries(byState || {});
  return entries
    .map(([stateName, count]) => ({ label: formatVisibleBuyerState(stateName), count: Number(count || 0) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function renderAdminParticipantCards(rows) {
  return `
    <div class="card-list admin-ops-grid">
      ${rows.map((row) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(formatVisibleBuyerState(row.buyer_state))}</span>
              <h3>${esc(row.buyer_id)}</h3>
            </div>
            <strong>${esc(formatVisibleMoneyState(row.money_state))}</strong>
          </div>
          <div class="pill-row">
            <span class="stat-pill"><span>מזהה משתתף</span><strong class="mono">${esc(row.participant_id)}</strong></span>
            <span class="stat-pill"><span>כמות</span><strong>${num(row.qty)}</strong></span>
            <span class="stat-pill"><span>נוצר</span><strong>${dt(row.created_at)}</strong></span>
          </div>
          <div class="actions">
            <a class="button secondary" href="/app/admin/participants/${encodeURIComponent(row.participant_id)}" data-nav="/app/admin/participants/${encodeURIComponent(row.participant_id)}">פתיחת פרופיל המשתתף</a>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAdminDealOpsHero(ops) {
  return `
    <div class="admin-ops-hero-grid">
      <div class="summary-item">
        <span class="muted">התראות</span>
        <strong>${num(ops.notifications.pending + ops.notifications.processing)} פעילות</strong>
        <p class="small muted">${num(ops.notifications.sent)} נשלחו · ${num(ops.notifications.failed)} נכשלו</p>
      </div>
      <div class="summary-item">
        <span class="muted">מסמכים</span>
        <strong>${num(ops.invoice_documents.issued)} issued</strong>
        <p class="small muted">${num(ops.invoice_documents.pending + ops.invoice_documents.processing)} ממתינים · ${num(ops.invoice_documents.failed)} נכשלו</p>
      </div>
      <div class="summary-item">
        <span class="muted">תור עבודה</span>
        <strong>${num(ops.outbox.pending + ops.outbox.processing)} פעיל</strong>
        <p class="small muted">${num(ops.outbox.sent)} נשלחו · ${num(ops.outbox.failed)} נכשלו</p>
      </div>
    </div>
  `;
}

function renderAdminDealOpsBuckets(ops) {
  return `
    <div class="summary-grid">
      <div class="summary-item"><span class="muted">משתתפים רשומים</span><strong>${num(ops.participants.total)}</strong></div>
      <div class="summary-item"><span class="muted">התראות שנשלחו</span><strong>${num(ops.notifications.sent)}</strong></div>
      <div class="summary-item"><span class="muted">מסמכים שהונפקו</span><strong>${num(ops.invoice_documents.issued)}</strong></div>
      <div class="summary-item"><span class="muted">Outbox שנשלח</span><strong>${num(ops.outbox.sent)}</strong></div>
    </div>
    <div class="summary-grid">
      <div class="summary-item"><span class="muted">התראות בהמתנה</span><strong>${num(ops.notifications.pending + ops.notifications.processing)}</strong></div>
      <div class="summary-item"><span class="muted">מסמכים בהמתנה</span><strong>${num(ops.invoice_documents.pending + ops.invoice_documents.processing)}</strong></div>
      <div class="summary-item"><span class="muted">Outbox בהמתנה</span><strong>${num(ops.outbox.pending + ops.outbox.processing)}</strong></div>
      <div class="summary-item"><span class="muted">Outbox שנכשל</span><strong>${num(ops.outbox.failed)}</strong></div>
    </div>
    ${(ops.notifications.by_channel?.length || ops.invoice_documents.by_type?.length) ? `
      <div class="summary-grid">
        ${ops.notifications.by_channel?.map((row) => `<div class="summary-item"><span class="muted">ערוץ ${esc(formatNotificationChannel(row.channel))}</span><strong>${num(row.sent)} נשלחו</strong><p class="small muted">${num(row.pending)} ממתינות · ${num(row.failed)} נכשלו</p></div>`).join("") || ""}
        ${ops.invoice_documents.by_type?.map((row) => `<div class="summary-item"><span class="muted">${esc(formatDocumentTypeLabel(row.document_type))}</span><strong>${num(row.issued)} issued</strong><p class="small muted">${num(row.pending + row.processing)} ממתינים · ${num(row.failed)} נכשלו</p></div>`).join("") || ""}
      </div>
    ` : ""}
  `;
}

function summarizeParticipantOps(payload) {
  const docs = Array.isArray(payload?.invoice_documents) ? payload.invoice_documents : [];
  const notifications = Array.isArray(payload?.notifications) ? payload.notifications : [];
  const outbox = Array.isArray(payload?.outbox_events_for_deal) ? payload.outbox_events_for_deal : [];
  return [
    {
      label: "מסמכים שהונפקו",
      value: String(docs.filter((row) => String(row.status) === "issued").length),
      detail: docs.length ? "מופיעים רק מסמכים שנרשמו ב־invoice_documents." : "עדיין אין מסמך אמיתי שרשום למשתתף הזה."
    },
    {
      label: "התראות שנשלחו",
      value: String(notifications.filter((row) => String(row.status) === "sent").length),
      detail: notifications.length ? "מציג רק התראות עם truth תפעולי אמיתי." : "לא נרשמו התראות רלוונטיות למשתתף הזה."
    },
    {
      label: "אירועי תור לעסקה",
      value: String(outbox.length),
      detail: outbox.length ? "זהו ה־outbox האחרון שקשור לעסקה של המשתתף." : "לא נמצאו כרגע אירועי תור רלוונטיים."
    }
  ];
}

function renderAdminUserJoinCards(rows) {
  return `
    <div class="card-list admin-ops-grid">
      ${rows.map((row) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(getDealCopy(row.deal_state).label)}</span>
              <h3>${esc(row.title)}</h3>
            </div>
            <strong>${esc(formatVisibleBuyerState(row.buyer_state))}</strong>
          </div>
          <div class="pill-row">
            <span class="stat-pill"><span>מזהה משתתף</span><strong class="mono">${esc(row.participant_id)}</strong></span>
            <span class="stat-pill"><span>כמות</span><strong>${num(row.qty)}</strong></span>
            <span class="stat-pill"><span>מצב כספי</span><strong>${esc(formatVisibleMoneyState(row.money_state))}</strong></span>
          </div>
          <div class="actions">
            <a class="button secondary" href="/app/admin/deals/${encodeURIComponent(row.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(row.deal_id)}">פתיחת העסקה</a>
            <a class="button secondary" href="/app/admin/participants/${encodeURIComponent(row.participant_id)}" data-nav="/app/admin/participants/${encodeURIComponent(row.participant_id)}">פתיחת המשתתף</a>
          </div>
        </article>
      `).join("")}
    </div>
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
  platform_fee_rate: "עמלת C-ton",
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
  document_id: "מזהה מסמך",
  document_status: "מצב מסמך",
  notification_status: "סטטוס התראה",
  outbox_status: "סטטוס תור",
  support_status: "סטטוס פנייה",
  provider_document_id: "מזהה ספק",
  share_code: "קוד שיתוף",
  display_name: "שם תצוגה",
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
  if (!normalized) return "מצב הצגה";
  if (normalized === "preview" || normalized === "demo" || normalized === "demo-preview") return "מצב הצגה";
  if (normalized === "internal" || normalized === "internal-runtime") return "סביבת עבודה פנימית";
  if (normalized === "production") return "סביבת ייצור";
  if (normalized === "staging") return "סביבת בדיקות";
  return String(value);
}

function formatRuntimeModeLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "לא הוגדר";
  if (normalized === "log-only") return "לוג בלבד";
  if (normalized === "mock" || normalized === "mock-backed") return "בדיקה פנימית";
  if (normalized === "demo-preview" || normalized === "preview") return "מצב הצגה";
  return String(value);
}

function formatSupportPriority(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high") return "גבוהה";
  if (normalized === "normal") return "רגילה";
  return String(value || "לא הוגדר");
}

function formatVerificationStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "approved") return "מאושר";
  if (normalized === "pending") return "ממתין לאישור";
  if (normalized === "rejected") return "נדחה";
  return String(value || "לא הוגדר");
}

function formatNotificationChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "sms") return "SMS";
  if (normalized === "email") return "Email";
  if (normalized === "push") return "Push";
  return String(value || "ערוץ לא ידוע");
}

function formatNotificationStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pending") return "ממתינה";
  if (normalized === "processing") return "בעיבוד";
  if (normalized === "sent") return "נשלחה";
  if (normalized === "failed") return "נכשלה";
  return String(value || "לא הוגדר");
}

function formatDocumentTypeLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "charge_receipt") return "מסמך חיוב";
  if (normalized === "refund_receipt") return "מסמך זיכוי";
  return String(value || "מסמך");
}

function formatOutboxStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pending") return "ממתין";
  if (normalized === "processing") return "בעיבוד";
  if (normalized === "sent") return "נשלח";
  if (normalized === "failed") return "נכשל";
  return String(value || "לא הוגדר");
}

function formatAttemptResultClass(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "success") return "הושלם";
  if (normalized === "retryable_failure") return "נכשל וניתן לנסות שוב";
  if (normalized === "terminal_failure") return "נכשל סופית";
  return String(value || "לא הוגדר");
}

function formatOperatorState(value, column = "") {
  if (column === "deal_state") return getDealCopy(String(value || "")).label;
  if (column === "buyer_state") return formatVisibleBuyerState(value);
  if (column === "money_state") return formatVisibleMoneyState(value);
  if (column === "document_status") return formatDocumentStatus(String(value));
  if (column === "notification_status") return formatNotificationStatus(value);
  if (column === "outbox_status") return formatOutboxStatus(value);
  if (column === "support_status") return formatSupportTicketStatus(value);
  if (column === "priority") return formatSupportPriority(value);
  return String(value || "לא הוגדר");
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
    if (value.includes("Receipt visibility relies on actual invoice_documents rows")) {
      return "מסמכי עסקה מוצגים רק אם קיימת רשומה אמיתית ב-invoice_documents. כשאין עדיין רשומה כזאת, מוצג במפורש שטרם הונפק מסמך.";
    }
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
  if (!value || /^\?+$/.test(value.replace(/\s+/g, "")) || value.includes("??")) {
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
  if (column === "document_status") return formatDocumentStatus(String(value));
  if (column === "notification_status") return formatNotificationStatus(value);
  if (column === "outbox_status") return formatOutboxStatus(value);
  if (column === "support_status") return formatSupportTicketStatus(value);
  if (column === "delivery_method_type") return formatDeliveryTypeLabel(String(value));
  if (column === "status") return formatOperatorState(value, inferStatusColumn(column, value));
  if (column === "priority") return formatSupportPriority(value);
  if (column === "notification_event_type") return formatNotificationEventType(value);
  if (column === "channel") return formatNotificationChannel(value);
  if (column === "document_type") return formatDocumentTypeLabel(value);
  if (column === "result_class") return formatAttemptResultClass(value);
  if (["price_per_unit", "delivery_cost", "gross_amount"].includes(column)) return currency(value);
  if (["qty", "min_units", "max_units", "threshold_units"].includes(column)) return num(value);
  if (column.endsWith("_at") || column === "deadline" || column === "available_at") return dt(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inferStatusColumn(column, value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["pending", "processing", "sent", "failed"].includes(normalized)) return "outbox_status";
  if (["issued", "pending", "processing", "failed"].includes(normalized)) return "document_status";
  if (["open", "investigating", "resolved"].includes(normalized)) return "support_status";
  return column;
}

function formatDocumentStatus(status) {
  const map = {
    pending: "ממתין להנפקה",
    processing: "בעיבוד",
    issued: "הונפק",
    failed: "נכשל",
    skipped: "נדלג"
  };
  return map[status] || status;
}

function formatNotificationEventType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const map = {
    charge_succeeded: "אישור חיוב",
    charge_failed: "כשל חיוב",
    payment_authorized: "אישור מסגרת",
    payment_failed: "כשל באישור",
    deal_completed: "עסקה הושלמה"
  };
  return map[normalized] || String(value || "אירוע הודעה");
}

function formatSupportScopeType(scopeType) {
  const map = {
    deal: "עסקה",
    participant: "משתתף",
    affiliate: "מפיץ",
    seller: "מוכר",
    system: "מערכת"
  };
  return map[scopeType] || scopeType;
}

function formatSupportTicketStatus(status) {
  const map = {
    open: "פתוחה",
    investigating: "בבדיקה",
    resolved: "טופלה"
  };
  return map[status] || status;
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
    <section class="card section stack empty-surface" role="status">
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
          <a href="/app" data-nav="/app" class="button secondary">C-ton</a>
          <a href="/app/seller/new" data-nav="/app/seller/new" class="button secondary">יצירת עסקה</a>
        </div>
      ${!isInternalSurface ? `<div class="route-chip">מוכר פעיל: ${esc(sellerContext.display_name)}</div>` : ""}
      ${isInternalSurface ? `<div class="route-chip">מסך פנימי</div>` : ""}
      <a href="/app" data-nav="/app" class="button secondary">C-ton</a>
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
          <p class="muted">ב-C-ton הקונה מתקדם דרך לינק ישיר לעסקה. בשלב ההצטרפות נשמרת תפיסת מסגרת בלבד, והחיוב בפועל מתבצע רק אם העסקה נסגרת בהצלחה. אם העסקה לא נסגרת, המסגרת משתחררת, מתבטלת או לא הופכת לחיוב בפועל לפי מצב העסקה.</p>
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
      <a href="/legal/terms">תקנון</a>
      <a href="/legal/privacy">מדיניות פרטיות</a>
      <a href="/legal/refunds">ביטולים והחזרים</a>
      <a href="/app/accessibility" data-nav="/app/accessibility">הצהרת נגישות</a>
      <a href="/legal/sellers">תנאי מוכרים</a>
      <a href="/legal/affiliates">תנאי מפיצים</a>
      <a href="/legal/payments">מדיניות תשלומים</a>
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

function renderSellerPublishLegalAcceptance() {
  return `
    <label class="check-row legal-consent-row">
      <input type="checkbox" name="sellerPublishLegalAccepted" required />
      <span>קראתי ואני מאשר את <a href="/legal/sellers">תנאי המוכרים</a>, <a href="/legal/terms">התקנון</a> ומדיניות C-ton</span>
    </label>
  `;
}

function renderBuyerPaymentLegalAcceptance() {
  return `
    <div class="legal-payment-consent stack compact-section">
      <label class="check-row legal-consent-row">
        <input type="checkbox" name="buyerPaymentDisclosureAcceptance" required />
        <span>אני מאשר את תנאי העסקה, <a href="/legal/terms">התקנון</a>, <a href="/legal/refunds">מדיניות הביטולים</a> ו<a href="/legal/privacy">מדיניות הפרטיות</a></span>
      </label>
      <p class="small muted">ההצטרפות לעסקה אינה חיוב מיידי. בשלב הראשון מתבצעת תפיסת מסגרת אשראי בלבד. חיוב בפועל יתבצע רק אם העסקה תיסגר בהצלחה.</p>
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
    "תנאי השימוש מגדירים איך משתמשים במשטחים הציבוריים של C-ton, מהו אופי העסקה הקבוצתית, ואיפה עוברת האחריות בין הפלטפורמה, המוכר והקונה.",
    [
      { title: "מהו השירות", body: "C-ton היא פלטפורמה טכנולוגית לעסקאות קבוצתיות מבוססות לינק. המוכר פותח עסקה, מפרסם דף ציבורי, והקונה מצטרף דרך קישור ישיר ולא דרך קטלוג ציבורי פתוח." },
      { title: "C-ton אינה המוכר", body: "C-ton מספקת את מערכת העסקה, התיעוד, מסכי ההצטרפות והמעקב, אך אינה המוכר של המוצר או השירות. האחריות למוצר, איכות, מלאי, אספקה, שירות ואחריות צרכנית היא של המוכר, בכפוף לדין החל ולתנאי העסקה שפורסמו." },
      { title: "הצטרפות ותפיסת מסגרת", body: "הצטרפות לעסקה אינה חיוב בפועל. בשלב ההצטרפות נשמרים פרטי המסלול ותפיסת מסגרת בלבד עד להצלחת העסקה. חיוב יתבצע רק אם העסקה עומדת בתנאים ובמצב המערכת מאפשר חיוב." },
      { title: "אם העסקה לא תושלם", body: "אם העסקה לא תושלם, המסגרת תשוחרר, תתבטל או יבוצע טיפול כספי לפי המסלול האוטומטי הרלוונטי. זמני שחרור מסגרת תלויים גם בחברת האשראי, בבנק או בספק הסליקה, ולכן אינם תמיד מיידיים." },
      { title: "אין התחייבות להשלמת העסקה", body: "אין התחייבות שהעסקה תצא לפועל, ואין התחייבות לזמינות מוצר עד השלמת העסקה. העסקה יכולה להיכשל אם לא מתקיימים תנאי הסף, אם חל כשל סליקה, או אם מנגנוני המערכת מסמנים מצב שאינו מאפשר השלמה." },
      { title: "תנאים קריטיים לאחר פרסום", body: "מחיר, מינימום, מקסימום, דדליין, אופן קבלה ותנאים קריטיים נוספים אינם משתנים לאחר פרסום העסקה. לאחר נעילה לפי חוקת העסקה אין ביטול מתוך המערכת אלא אם מצב העסקה והמנגנונים הקיימים מאפשרים זאת." },
      { title: "כלל 90%", body: "עסקה תיחשב מוצלחת רק אם חויבו בפועל לפחות 90% מהמינימום שהוגדר. אם פחות מכך חויב בפועל, העסקה נכשלת לפי מנגנון המערכת." },
      { title: "לינקי הפצה ומפיצים", body: "מפיצים הם ערוץ מדידה ושיתוף בלבד. אין במערכת עמלה, יתרה, payout או תשלום למפיץ, וכל הסכמה אחרת בין מוכר למפיץ נמצאת מחוץ ל-C-ton." },
      { title: "הודעות ומקור אמת", body: "SMS, Email או הודעות אחרות הם כלי עזר בלבד. מסך המעקב של ההשתתפות והסטטוסים שמוצגים במערכת הם מקור האמת לגבי מצב העסקה, תפיסת המסגרת וההשתתפות." },
      { title: "כשלים טכניים ועיכובים", body: "שגיאות טכניות, כשלי רשת, כשלי סליקה או עיכובים יטופלו לפי מנגנוני המערכת והסטטוסים הקיימים. ייתכנו עיכובים שאינם בשליטת C-ton, למשל אצל ספק סליקה או חברת אשראי." },
      { title: "אחריות הקונה", body: "הקונה אחראי למסור פרטים נכונים, לעקוב אחר מצב ההשתתפות במסך המעקב, ולוודא שהכמות ואופן הקבלה שנשמרו תואמים את רצונו לפני אישור המסגרת." },
      { title: "סביבת דמו", body: "הדמו אינו סביבת תשלום אמיתית, ואין להסתמך על נתוני דמו כמסחר אמיתי. התוכן כאן הוא ניסוח מוצרי לתצוגת דמו ודורש בדיקה משפטית לפני שימוש בפרודקשן." }
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
      { title: "תפיסת מסגרת מול חיוב", body: "בזמן הצטרפות לא מתבצע חיוב בפועל. הסכום יתפוס מסגרת אשראי בלבד, והחיוב יתבצע רק אם העסקה תיסגר בהצלחה. אם העסקה לא תיסגר, המסגרת תשוחרר לפי כללי ספק האשראי." },
      { title: "ביטול לפני ואחרי נעילה", body: "לפני נעילת העסקה, ביטול אפשרי רק אם מצב העסקה והמערכת מאפשרים זאת. אחרי שלבי ReadyForCharging או נעילה תפעולית, אין ביטול מצד קונה מתוך המערכת." },
      { title: "עסקה שהושלמה", body: "לאחר עסקה Completed, בקשות שירות, אספקה או תיאום המשך הן מול המוכר, לפי פרטי הקשר ותנאי העסקה שהוצגו." },
      { title: "אם העסקה לא נסגרת", body: "אם העסקה לא מגיעה להשלמה, המסגרת אמורה להשתחרר, להתבטל או לא להפוך לחיוב בפועל, בהתאם למצב הסופי של העסקה ולשכבת האישור הרלוונטית." },
      { title: "אם בוצע חיוב והעסקה שונתה לאחר מכן", body: "במקרה שבו הושלם חיוב בפועל ובהמשך נדרש ביטול או החזר, מסך המעקב והסטטוסים במערכת הם מקור האמת לגבי המצב התפעולי שהקונה רואה." },
      { title: "אחריות להסבר לקונה", body: "המוכר נדרש להציג עסקה ברורה ולהימנע מיצירת פער בין מה שהקונה מבין בדף העסקה לבין ההתנהגות התפעולית של העסקה בפועל." },
      { title: "איפה רואים סטטוס", body: "מסך המעקב נשאר הנקודה הפעילה ביותר לקונה אחרי הצטרפות, ובו רואים האם נשמרה מסגרת, האם שוחררה, והאם חל שינוי שמצריך מעקב נוסף." }
    ]
  );
}

function renderAccessibilityPage() {
  return renderLegalPage(
    "הצהרת נגישות",
    "נגישות השירות",
    "C-ton פועלת להנגיש את השירות הדיגיטלי לפי תי 5568 ו-WCAG 2.0 AA, כדי לאפשר שימוש ברור במקלדת, בקורא מסך, בזום ובמובייל.",
    [
      { title: "תקן יעד", body: "השירות מתוכנן לפי דרישות הנגישות בישראל, תי 5568 והנחיות WCAG 2.0 ברמת AA. המשמעות היא מבנה סמנטי, ניווט מקלדת, ניגודיות סבירה, טקסט חלופי לתמונות והודעות סטטוס קריאות." },
      { title: "מה הונגש", body: "קיימים קישור דילוג לתוכן המרכזי, אזורי header, nav, main ו-footer, תוויות לשדות, הודעות חיות למצבי טעינה ושגיאה, focus-visible ברור, תמיכה בעברית RTL ופריסות מותאמות מובייל." },
      { title: "מסכי כסף ומעקב", body: "מסכי אימות טלפון, תפיסת מסגרת, אישור הצטרפות ומעקב קונה מציגים טקסט ברור על סטטוס העסקה, סטטוס המסגרת ומה יקרה במקרה של כשל עסקה." },
      { title: "פנייה בנושא נגישות", body: "אם נתקלת בקושי נגישות בשימוש בשירות, אפשר לפנות אל accessibility@c-ton.co.il בצירוף תיאור הבעיה, הקישור הרלוונטי וסוג המכשיר או הדפדפן." }
    ]
  );
}

function renderSellerTermsPage() {
  return renderLegalPage(
    "תנאי מוכר",
    "פרסום עסקאות",
    "תנאים אלה חלים על מוכר שפותח או מפרסם עסקה ב-C-ton. המוכר אחראי לפרטי העסקה, למוצר, לאספקה, לאחריות ולשירות.",
    [
      { title: "אחריות לפרטי העסקה", body: "המוכר אחראי לכך שכל פרטי העסקה נכונים, מלאים ואינם מטעים: מחיר, מינימום, מקסימום, דדליין, אפשרויות אספקה, חלון השלמה וכל תנאי מהותי אחר." },
      { title: "אחריות מוצר ושירות", body: "המוכר אחראי למוצר, לאיכות, למלאי, לאספקה, לשירות לאחר השלמת העסקה, לאחריות צרכנית ולכל תיאום מול קונים זכאים. C-ton אינה מחליפה את המוכר ואינה מתחייבת לזמינות מוצר." },
      { title: "תנאים קריטיים", body: "לאחר פרסום אין שינוי שקט של תנאים קריטיים. מחיר, מינימום, מקסימום, דדליין, משלוח, חלון השלמה ועמלות חייבים להיות סופיים לפני פרסום." },
      { title: "נעילה וביטול", body: "לאחר נעילת העסקה לפי חוקת העסקה אין ביטול מתוך המערכת, אלא אם מצב העסקה והמנגנונים האוטומטיים הקיימים מאפשרים זאת. מסך המעקב הוא מקור האמת לקונה." },
      { title: "כלל 90%", body: "המוכר מבין שהעסקה תושלם אם יחויבו בפועל לפחות 90% מהמינימום לפי יחידות. לכן ייתכן שהעסקה תושלם גם אם לא כל ההתחייבויות חויבו בפועל." },
      { title: "עמלת C-ton", body: "C-ton גובה 8% כולל הכל מהכל, כולל משלוח, למעט מעמ. אין עמלת מפיצים במערכת וכל הסדר עם מפיץ הוא מחוץ למערכת בלבד." },
      { title: "דמו ובדיקה משפטית", body: "סביבת הדמו אינה סביבת תשלום אמיתית ואין להסתמך על נתוני דמו כמסחר אמיתי. נוסח זה דורש בדיקה משפטית לפני שימוש בפרודקשן." },
      { title: "KYC והקפאה", body: "מוכר נדרש לאישור KYC בסיסי לפני פעילות אמיתית. C-ton רשאית להקפיא פעילות במקרה של חשד להונאה, תלונה מהותית, בעיית אספקה או סיכון משפטי." }
    ]
  );
}

function renderDistributorTermsPage() {
  return renderLegalPage(
    "תנאי מפיץ",
    "מדידה ושיתוף",
    "מפיץ ב-C-ton הוא ערוץ מדידה ושיתוף בלבד. אין במערכת יתרה, משיכה, עמלה, payout או חשבונית למפיץ.",
    [
      { title: "תפקיד המפיץ", body: "המפיץ משתף לינק ומאפשר ייחוס אנליטי של קליקים, כניסות, הצטרפויות מצרפיות, יחידות מיוחסות וברוטו מיוחס. הנתונים אינם יוצרים זכאות כספית במערכת." },
      { title: "אין זכאות כספית במערכת", body: "אין עמלה למפיץ, אין יתרה, אין משיכה, אין payout ואין חשבונית למפיץ דרך C-ton. כל הסדר כספי בין מוכר למפיץ נמצא מחוץ למערכת בלבד." },
      { title: "פרטיות קונים", body: "המפיץ לא מקבל מידע אישי על קונים. משטח ההפצה מציג נתונים מצרפיים בלבד לצורך מדידה." },
      { title: "שימוש אסור", body: "אסור למפיץ להטעות, להבטיח מחיר אחר, להבטיח זמינות, או להציג עצמו כנציג רשמי של C-ton. C-ton רשאית לחסום לינק הפצה במקרה של שימוש מטעה." }
    ]
  );
}

function renderContactPage() {
  return renderLegalPage(
    "יצירת קשר",
    "קשר ותמיכה",
    "יצירת הקשר ב-C-ton בנויה סביב העסקה עצמה: היכן הקונה נמצא במסלול, מה המוכר פרסם, ומהו המסך שממנו ברור ביותר להמשיך טיפול.",
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
  return `
      <nav class="shell-surface page-nav" aria-label="ניווט ראשי">
        <div class="actions">
          <a href="/app" data-nav="/app" class="button secondary">C-ton</a>
          <a href="/app/seller/new" data-nav="/app/seller/new" class="button secondary">יצירת עסקה</a>
        </div>
        <div class="shell-meta">
          ${isInternalSurface ? `<div class="route-chip">גישה פנימית</div>` : ""}
          <div class="route-chip">${getRouteLabel()}</div>
        </div>
    </nav>
  `;
}

function getPrimaryDealImage(deal) {
  const images = Array.isArray(deal?.images) ? deal.images : [];
  return images.find((image) => image?.is_primary) || images[0] || null;
}

function renderDealImageGallery(deal) {
  const images = Array.isArray(deal?.images) ? deal.images : [];
  if (!images.length) {
    return `<div class="empty-surface"><strong>אין תמונות לעסקה</strong><p class="small muted">אפשר לפרסם בלי תמונה, אבל תמונה טובה מחזקת אמון לפני שיתוף.</p></div>`;
  }
  return `
    <div class="seller-image-gallery deal-image-gallery" aria-label="תמונות העסקה">
      ${images.map((image, index) => `
        <article class="seller-image-thumb ${image.is_primary ? "is-primary" : ""}">
          <img src="${esc(image.url)}" alt="תמונה ${index + 1} עבור ${esc(deal.title || "עסקה")}" />
          <span class="badge ${image.is_primary ? "pending" : ""}">${image.is_primary ? "תמונה ראשית" : `תמונה ${index + 1}`}</span>
        </article>
      `).join("")}
    </div>
  `;
}

function renderDealVisual(title, deliveryOptions, selectedDelivery, image = null) {
  const trimmedTitle = String(title || "").trim();
  const firstLetter = [...trimmedTitle][0] || "\u05e1";
  const visibleOptions = (deliveryOptions || []).slice(0, 3);
  const selectedLabel = selectedDelivery?.label
    ? esc(selectedDelivery.label)
    : "\u05dc\u05d1\u05d7\u05d9\u05e8\u05d4 \u05d1\u05d4\u05de\u05e9\u05da";

  return `
    <section class="deal-visual-card" aria-label="\u05de\u05d1\u05d8 \u05de\u05d4\u05d9\u05e8 \u05e2\u05dc \u05d4\u05e2\u05e1\u05e7\u05d4">
      ${image?.url ? `<img class="deal-visual-image" src="${esc(image.url)}" alt="תמונת מוצר עבור ${esc(trimmedTitle || "העסקה")}" />` : `<div class="deal-visual-mark" aria-hidden="true">${esc(firstLetter)}</div>`}
      <div class="deal-visual-copy">
        <span class="eyebrow">\u05de\u05d1\u05d8 \u05de\u05d4\u05d9\u05e8</span>
        <strong>${esc(trimmedTitle || "\u05e2\u05e1\u05e7\u05d4")}</strong>
        <p class="small muted">\u05d3\u05e3 \u05d4\u05e2\u05e1\u05e7\u05d4 \u05de\u05e6\u05d9\u05d2 \u05de\u05d4 \u05de\u05e7\u05d1\u05dc\u05d9\u05dd, \u05db\u05de\u05d4 \u05db\u05d1\u05e8 \u05e0\u05e8\u05e9\u05dd, \u05d5\u05de\u05d4 \u05e0\u05d9\u05ea\u05df \u05dc\u05e1\u05d2\u05d5\u05e8 \u05db\u05e8\u05d2\u05e2.</p>
      </div>
      <div class="deal-visual-chips" aria-label="\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea \u05e7\u05d1\u05dc\u05d4 \u05d5\u05d1\u05d7\u05d9\u05e8\u05d4">
        <span class="deal-chip deal-chip-strong">\u05d0\u05d5\u05e4\u05df \u05e7\u05d1\u05dc\u05d4: ${selectedLabel}</span>
        ${visibleOptions.map((option) => `<span class="deal-chip">${esc(option.label)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderShareActions(url, title) {
  const shareUrl = absoluteUrl(url);
  const text = encodeURIComponent(title || "עסקה ב-C-ton");
  const encodedUrl = encodeURIComponent(shareUrl);
  return `
    <div class="share-panel" aria-label="עזרו לעסקה לקרות">
      <strong>עזרו לעסקה לקרות</strong>
      <button class="secondary share-native" type="button" data-inline-action="share-link" data-share-url="${esc(shareUrl)}" data-share-title="${esc(title || "עסקה ב-C-ton")}">שיתוף</button>
      <a class="button secondary" href="https://wa.me/?text=${text}%20${encodedUrl}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="button secondary" href="https://t.me/share/url?url=${encodedUrl}&text=${text}" target="_blank" rel="noopener">Telegram</a>
      <a class="button secondary" href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" target="_blank" rel="noopener">Facebook</a>
      <a class="button secondary" href="https://twitter.com/intent/tweet?url=${encodedUrl}&text=${text}" target="_blank" rel="noopener">X</a>
      <a class="button secondary" href="mailto:?subject=${text}&body=${encodedUrl}">Email</a>
      <button class="secondary" type="button" data-inline-action="copy-link" data-share-url="${esc(shareUrl)}">העתקת לינק</button>
    </div>
  `;
}

function renderDealAvailabilityBanner(availability, metrics, nextAction) {
  if (availability?.canJoin && Number(metrics?.remaining_units || 0) > 0) return "";
  const tone = Number(metrics?.remaining_units || 0) > 0 ? "tone-warning" : "";
  return `
    <div class="info-strip ${tone}">
      <strong>${esc(nextAction?.cta || "\u05d4\u05e2\u05e1\u05e7\u05d4 \u05dc\u05d0 \u05d6\u05de\u05d9\u05e0\u05d4 \u05db\u05e8\u05d2\u05e2")}</strong>
      <p class="small">${esc(availability?.message || nextAction?.description || "\u05dc\u05d0 \u05e0\u05d9\u05ea\u05df \u05dc\u05d4\u05de\u05e9\u05d9\u05da \u05dc\u05d4\u05e6\u05d8\u05e8\u05e4\u05d5\u05ea \u05d1\u05de\u05e6\u05d1 \u05d4\u05e0\u05d5\u05db\u05d7\u05d9.")}</p>
    </div>
  `;
}

function classifySellerDeals(deals) {
  const list = Array.isArray(deals) ? deals : [];
  return {
    attention: list.filter((deal) => ["Published", "Charging", "CompletionWindow"].includes(deal.state)),
    draft: list.filter((deal) => deal.state === "Draft"),
    closed: list.filter((deal) => ["Completed", "Failed", "Cancelled"].includes(deal.state))
  };
}

function renderSellerBoardSection(title, intro, deals, emptyTitle, emptyMessage) {
  if (!deals.length) {
    return `
      <section class="seller-board-section stack">
        <div class="section-header">
          <div class="stack compact compact-section">
            <h3>${esc(title)}</h3>
            <p class="muted section-intro">${esc(intro)}</p>
          </div>
        </div>
        <div class="empty-surface stack">
          <strong>${esc(emptyTitle)}</strong>
          <p class="small muted">${esc(emptyMessage)}</p>
        </div>
      </section>
    `;
  }

  return `
    <section class="seller-board-section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h3>${esc(title)}</h3>
          <p class="muted section-intro">${esc(intro)}</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>\u05db\u05de\u05d5\u05ea</span><strong>${num(deals.length)}</strong></span>
        </div>
      </div>
      <div class="card-list seller-board">${deals.map(renderSellerDealCard).join("")}</div>
    </section>
  `;
}

function summarizeSellerParticipants(participants) {
  const rows = Array.isArray(participants) ? participants : [];
  return {
    charged: rows.filter((row) => ["ChargedSuccess", "RecoveredCharge"].includes(row.money_state)).length,
    pending: rows.filter((row) => ["AuthHeld", "AuthLocked", "ChargeAttempt"].includes(row.money_state)).length,
    unresolved: rows.filter((row) => ["ChargeFailedCompletion", "ChargeFailedRecovery", "AuthReleased"].includes(row.money_state)).length
  };
}

function trackingStatusTone(tracking) {
  if (["Completed"].includes(String(tracking?.deal_state || ""))) return "tone-success";
  if (["Failed", "Cancelled"].includes(String(tracking?.deal_state || ""))) return "tone-warning";
  if (tracking?.buyer_state === "ChargeFailedCompletion" || tracking?.money_state === "ChargeFailedRecovery") return "tone-warning";
  return "";
}

function buildTrackingFocusCards(tracking) {
  const cards = [];
  if (tracking?.money_state === "AuthHeld" || tracking?.money_state === "AuthLocked") {
    cards.push({
      title: "מה קרה עד עכשיו",
      value: "ההצטרפות נשמרה ונתפסה מסגרת",
      detail: "עדיין לא בוצע חיוב בפועל. המסך הזה יעדכן אם העסקה תעבור לחיוב."
    });
  }
  if (tracking?.buyer_state === "ChargeFailedCompletion" || tracking?.money_state === "ChargeFailedRecovery") {
    cards.push({
      title: "נדרש שים לב",
      value: "המערכת מטפלת בהשלמת",
      detail: tracking?.completion_window_until
        ? `יש חלון השלמה עד ${dt(tracking.completion_window_until)}. אם יעדכן פעולה נוספת, ההודעה תופיע כאן.`
        : "יש כשל שנדרש לטפל, והמערכת עדיין מנסה לסגור את המסלול."
    });
  }
  if (tracking?.deal_state === "Completed") {
    cards.push({
      title: "תוצאה סופית",
      value: "העסקה הושלמה",
      detail: "המףקח העיקרי עכשיו הוא מעקב אחר אספקה או אישור סופי, אם הם רלוונטיים."
    });
  }
  if (tracking?.deal_state === "Failed" || tracking?.deal_state === "Cancelled") {
    cards.push({
      title: "תוצאה סופית",
      value: tracking.deal_state === "Cancelled" ? "העסקה בוטלה" : "העסקה לא הושלמה",
      detail: "המסך מרכז את התוצאה הסופית לקונה, ואין צורך לחפש מידע במסכים אחרים."
    });
  }
  if (!cards.length) {
    cards.push({
      title: "מה קורה עכשיו",
      value: "המסלול בתנועה",
      detail: "מסך המעקב ימשיך להתעדכן עם כל שינוי במצב העסקה וההשתתפות."
    });
  }
  return cards;
}

function buildTrackingTimeline(tracking) {
  const rows = [];
  rows.push({
    label: "הצטרפות",
    value: "נקלטה בהצלחה",
    detail: `${num(tracking.qty)} יח' · ${dt(tracking.created_at)}`
  });
  rows.push({
    label: "מצב עסקה",
    value: getDealCopy(tracking.deal_state).label,
    detail: getDealCopy(tracking.deal_state).description
  });
  rows.push({
    label: "מצב כסף",
    value: getLabel(MONEY_COPY, tracking.money_state)[0],
    detail: getLabel(MONEY_COPY, tracking.money_state)[1]
  });
  if (tracking.completion_window_until) {
    rows.push({
      label: "חלון השלמה",
      value: dt(tracking.completion_window_until),
      detail: "אם יהיה צורך בפעולה נוספת, היא תופיע במסך הזה."
    });
  }
  const documentVisibility = buildTrackingDocumentVisibility(tracking);
  rows.push({
    label: "\u05de\u05e1\u05de\u05da",
    value: documentVisibility.shortLabel,
    detail: documentVisibility.shortDetail
  });
  return rows;
}

function buildTrackingSupportNote(tracking) {
  if (["Completed"].includes(String(tracking?.deal_state || ""))) {
    return "לשאלות על אספקה או סטטוס סופי, כדאי להתיחס למסך המעקב כמקור האמת.";
  }
  if (["Failed", "Cancelled"].includes(String(tracking?.deal_state || ""))) {
    return "אם נדרש בירור, מסך המעקב הזה הוא המקום הנכון להבנת התוצאה.";
  }
  return "כל עדכון משמעותי יופיע כאן. הודעות אחרות הן תומכות בלבד.";
}

function buildTrackingDocumentVisibility(tracking) {
  const visibility = tracking?.document_visibility || {};
  const state = String(visibility.state || "");
  if (state === "issued" && visibility.document_id) {
    return {
      title: "\u05de\u05e1\u05de\u05da \u05d4\u05d5\u05e0\u05e4\u05e7 \u05d5\u05d6\u05de\u05d9\u05df \u05dc\u05de\u05e2\u05e7\u05d1",
      detail: "\u05db\u05d1\u05e8 \u05d4\u05d5\u05e0\u05e4\u05e7 \u05de\u05e1\u05de\u05da \u05d0\u05de\u05d9\u05ea\u05d9 \u05dc\u05d4\u05e9\u05ea\u05ea\u05e4\u05d5\u05ea \u05d4\u05d6\u05d0\u05ea. \u05de\u05d6\u05d4\u05d4 \u05d4\u05de\u05e1\u05de\u05da \u05de\u05d5\u05e6\u05d2 \u05db\u05de\u05d5 \u05e9\u05d4\u05d5\u05d0 \u05e0\u05e8\u05e9\u05dd \u05d1\u05de\u05e2\u05e8\u05db\u05ea.",
      shortLabel: "\u05d4\u05d5\u05e0\u05e4\u05e7",
      shortDetail: visibility.document_id,
      documentId: visibility.document_id,
      issuedAt: visibility.issued_at || null
    };
  }
  if (state === "pending_issue") {
    return {
      title: "\u05d4\u05de\u05e1\u05de\u05da \u05e2\u05d3\u05d9\u05d9\u05df \u05dc\u05d0 \u05d4\u05d5\u05e0\u05e4\u05e7",
      detail: "\u05d4\u05d7\u05d9\u05d5\u05d1 \u05db\u05d1\u05e8 \u05e0\u05e7\u05dc\u05d8 \u05d0\u05d5 \u05d4\u05d4\u05e9\u05ea\u05ea\u05e4\u05d5\u05ea \u05db\u05d1\u05e8 \u05d6\u05db\u05d0\u05d9\u05ea \u05dc\u05de\u05e1\u05de\u05da, \u05d0\u05d1\u05dc \u05e2\u05d3\u05d9\u05d9\u05df \u05d0\u05d9\u05df \u05e8\u05e9\u05d5\u05de\u05d4 \u05e9\u05dc \u05de\u05e1\u05de\u05da \u05de\u05d5\u05e0\u05e4\u05e7. \u05d4\u05de\u05e1\u05da \u05d4\u05d6\u05d4 \u05d9\u05ea\u05e2\u05d3\u05db\u05df \u05db\u05e9\u05d9\u05d4\u05d9\u05d4 \u05de\u05e1\u05de\u05da \u05d0\u05de\u05d9\u05ea\u05d9.",
      shortLabel: "\u05de\u05de\u05ea\u05d9\u05df \u05dc\u05d4\u05e0\u05e4\u05e7\u05d4",
      shortDetail: "\u05d8\u05e8\u05dd \u05e0\u05d5\u05e6\u05e8\u05d4 \u05e8\u05e9\u05d5\u05de\u05ea \u05de\u05e1\u05de\u05da \u05de\u05d5\u05e0\u05e4\u05e7.",
      documentId: null,
      issuedAt: null
    };
  }
  if (state === "issue_failed") {
    return {
      title: "\u05d4\u05de\u05e1\u05de\u05da \u05e2\u05d3\u05d9\u05d9\u05df \u05dc\u05d0 \u05d4\u05d5\u05e0\u05e4\u05e7",
      detail: "\u05d4\u05de\u05e2\u05e8\u05db\u05ea \u05e2\u05d3\u05d9\u05d9\u05df \u05dc\u05d0 \u05e1\u05d2\u05e8\u05d4 \u05d4\u05e0\u05e4\u05e7\u05d4 \u05e9\u05dc \u05de\u05e1\u05de\u05da \u05d0\u05de\u05d9\u05ea\u05d9. \u05e2\u05d3 \u05e9\u05ea\u05d4\u05d9\u05d4 \u05e8\u05e9\u05d5\u05de\u05ea issued \u05dc\u05d0 \u05e0\u05e6\u05d9\u05d2 \u05de\u05e1\u05de\u05da \u05db\u05d0\u05d9\u05dc\u05d5 \u05d4\u05d5\u05d0 \u05d6\u05de\u05d9\u05df.",
      shortLabel: "\u05d4\u05e0\u05e4\u05e7\u05d4 \u05d1\u05d8\u05d9\u05e4\u05d5\u05dc",
      shortDetail: "\u05d0\u05d9\u05df \u05e2\u05d3\u05d9\u05d9\u05df \u05de\u05e1\u05de\u05da issued.",
      documentId: null,
      issuedAt: null
    };
  }
  if (state === "not_expected") {
    return {
      title: "\u05dc\u05d0 \u05e6\u05e4\u05d5\u05d9 \u05de\u05e1\u05de\u05da \u05dc\u05d4\u05e9\u05ea\u05ea\u05e4\u05d5\u05ea \u05d4\u05d6\u05d0\u05ea",
      detail: "\u05d1\u05de\u05e6\u05d1 \u05d4\u05e1\u05d5\u05e4\u05d9 \u05d4\u05d6\u05d4 \u05dc\u05d0 \u05d1\u05d5\u05e6\u05e2 \u05d7\u05d9\u05d5\u05d1 \u05de\u05e1\u05ea\u05d9\u05d9\u05dd \u05d0\u05d5 \u05e9\u05d4\u05d4\u05e9\u05ea\u05ea\u05e4\u05d5\u05ea \u05dc\u05d0 \u05d4\u05e1\u05ea\u05d9\u05d9\u05de\u05d4 \u05db\u05e2\u05e1\u05e7\u05d4 \u05d7\u05d9\u05d5\u05d1\u05d9\u05ea. \u05dc\u05db\u05df \u05d0\u05d9\u05df \u05de\u05e1\u05de\u05da \u05dc\u05d4\u05e6\u05d9\u05d2.",
      shortLabel: "\u05dc\u05d0 \u05e6\u05e4\u05d5\u05d9",
      shortDetail: "\u05d0\u05d9\u05df \u05de\u05e1\u05de\u05da \u05d1\u05de\u05e6\u05d1 \u05d4\u05e1\u05d5\u05e4\u05d9 \u05d4\u05d6\u05d4.",
      documentId: null,
      issuedAt: null
    };
  }
  return {
    title: "\u05de\u05e1\u05de\u05da \u05d9\u05d5\u05e4\u05d9\u05e2 \u05e8\u05e7 \u05d0\u05d7\u05e8\u05d9 \u05e1\u05d2\u05d9\u05e8\u05d4 \u05de\u05dc\u05d0\u05d4",
    detail: "\u05db\u05dc \u05e2\u05d5\u05d3 \u05d4\u05e2\u05e1\u05e7\u05d4 \u05e2\u05d3\u05d9\u05d9\u05df \u05d1\u05ea\u05d4\u05dc\u05d9\u05da \u05d0\u05d5 \u05d4\u05d7\u05d9\u05d5\u05d1 \u05e2\u05d3\u05d9\u05d9\u05df \u05dc\u05d0 \u05d4\u05d5\u05e9\u05dc\u05dd, \u05d0\u05d9\u05df \u05e2\u05d3\u05d9\u05d9\u05df \u05de\u05e1\u05de\u05da \u05d0\u05de\u05d9\u05ea\u05d9 \u05dc\u05d4\u05e6\u05d9\u05d2.",
    shortLabel: "\u05e2\u05d3\u05d9\u05d9\u05df \u05dc\u05d0 \u05d6\u05de\u05d9\u05df",
    shortDetail: "\u05d4\u05de\u05e1\u05de\u05da \u05d9\u05d5\u05e6\u05d2 \u05e8\u05e7 \u05d0\u05dd \u05d9\u05d4\u05d9\u05d4 issued \u05d0\u05de\u05d9\u05ea\u05d9.",
    documentId: null,
    issuedAt: null
  };
}

function buildTrackingPersonalCardFallback(tracking) {
  const actionRequired = tracking?.buyer_state === "ChargeFailedCompletion" || tracking?.money_state === "ChargeFailedRecovery";
  if (actionRequired) {
    return {
      action_required: true,
      title: "נדרש עדכון תשלום",
      detail: "החיוב לא הושלם והמסך יציג את הפעולה הזמינה להשלמה.",
      cta: { label: "בדיקת פרטי העסקה", href: "deal" }
    };
  }
  return {
    action_required: false,
    title: "כרגע לא נדרשת ממך פעולה",
    detail: "ההשתתפות שלך שמורה ומסך המעקב יתעדכן אוטומטית.",
    cta: null
  };
}

function renderTrackingProgressChart(points, progress) {
  const rows = Array.isArray(points) ? points : [];
  const targetUnits = Math.max(1, Number(progress?.target_units || progress?.threshold_units || 1));
  const maxUnits = Math.max(targetUnits, Number(progress?.max_units || targetUnits));
  const chartMax = Math.max(maxUnits, ...rows.map((point) => Number(point.cumulative_units || 0)), 1);
  if (!rows.length) {
    return `
      <div class="tracking-chart-empty stack">
        <strong>עדיין אין מספיק נתונים לגרף</strong>
        <p class="small muted">ברגע שיצטרפו יחידות לעסקה, הגרף יראה את ההתקדמות המצטברת בזמן.</p>
      </div>
    `;
  }

  const width = 640;
  const height = 260;
  const paddingX = 34;
  const paddingY = 24;
  const span = Math.max(1, rows.length - 1);
  const toX = (index) => paddingX + (index / span) * (width - paddingX * 2);
  const toY = (value) => height - paddingY - (Number(value || 0) / chartMax) * (height - paddingY * 2);
  const polyline = rows.map((point, index) => `${toX(index).toFixed(1)},${toY(point.cumulative_units).toFixed(1)}`).join(" ");
  const targetY = toY(targetUnits).toFixed(1);
  const maxY = toY(maxUnits).toFixed(1);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return `
    <div class="tracking-chart-wrap">
      <svg class="tracking-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="גרף יחידות מצטברות בעסקה">
        <line class="chart-grid-line" x1="${paddingX}" y1="${targetY}" x2="${width - paddingX}" y2="${targetY}"></line>
        <line class="chart-grid-line chart-grid-line-soft" x1="${paddingX}" y1="${maxY}" x2="${width - paddingX}" y2="${maxY}"></line>
        <polyline class="chart-line" points="${esc(polyline)}"></polyline>
        ${rows.map((point, index) => `<circle class="chart-point" cx="${toX(index).toFixed(1)}" cy="${toY(point.cumulative_units).toFixed(1)}" r="${index === rows.length - 1 ? 5 : 3}"></circle>`).join("")}
        <text class="chart-label" x="${width - paddingX}" y="${Math.max(14, Number(targetY) - 8)}" text-anchor="end">מינימום ${num(targetUnits)}</text>
        <text class="chart-label muted-label" x="${paddingX}" y="${Math.max(14, Number(maxY) - 8)}">מקסימום ${num(maxUnits)}</text>
      </svg>
      <div class="tracking-chart-meta">
        <span><strong>${num(first.added_units || first.cumulative_units || 0)}</strong> יח' בהתחלה</span>
        <span><strong>${num(last.cumulative_units || 0)}</strong> יח' עכשיו</span>
        <span>${relativeTime(last.at)}</span>
      </div>
    </div>
  `;
}

function renderTrackingActivityFeed(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    return `
      <div class="empty-surface compact">
        <strong>עדיין אין פעילות להצגה</strong>
        <p class="small muted">העדכונים יופיעו כאן כשהעסקה תתקדם בפועל.</p>
      </div>
    `;
  }
  return `
    <div class="tracking-activity-feed" aria-live="polite">
      ${rows.map((item) => `
        <article class="tracking-activity-item">
          <span class="activity-dot" aria-hidden="true"></span>
          <div>
            <strong>${esc(item.message || "עדכון בעסקה")}</strong>
            <p class="small muted">${relativeTime(item.at)}${item.cumulative_units ? ` · ${num(item.cumulative_units)} יחידות מצטברות` : ""}</p>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderErrorCard(error) {
  return `
    <section class="error-card validation-summary" role="alert" tabindex="-1" data-testid="seller-create-error-summary">
      <strong>${esc(error.title || "אירעה שגיאה")}</strong>
      <p>${esc(error.message || "נסה שוב בעוד רגע.")}</p>
      ${Array.isArray(error.items) && error.items.length ? `<ul>${error.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
    </section>
  `;
}

function renderInfoStrip(message) {
  return `<section class="info-strip" role="status"><strong>${esc(message)}</strong></section>`;
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
    const headers = {
      "content-type": "application/json",
      ...(usesDemoSellerContext() ? { "x-seller-id": sellerContext.seller_id } : {}),
      ...(options.headers || {})
    };
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers
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
  error.code = payload?.code || payload?.error || fallbackStatus(response.status) || "request_failed";
  error.payload = payload;
  throw error;
}

async function downloadSellerDealExport(dealId) {
  if (!dealId) return;
  const sellerContext = currentSellerContext();
  const url = `/api/seller/deals/${encodeURIComponent(dealId)}/export.xlsx`;
  await busy("מכין קובץ Excel לעסקה...", async () => {
    const response = await fetch(url, {
      headers: usesDemoSellerContext() ? { "x-seller-id": sellerContext.seller_id } : {}
    });
    if (!response.ok) {
      const error = new Error(await response.text());
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `siton-deal-export-${dealId}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }, "לא הצלחנו להוריד את קובץ ה-Excel של העסקה.");
}

const paymentService = {
  createHostedPaymentMethodId(dealId, buyerId) {
    const seed = `${dealId || "deal"}:${buyerId || "buyer"}:${Date.now()}`;
    return `pm_hosted_${btoa(unescape(encodeURIComponent(seed))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
  },
  authorize(paymentDetails) {
    return api("/api/payments/authorize", {
      method: "POST",
      body: json(paymentDetails)
    });
  }
};

const buyerFlowService = {
  joinDeal(dealId, { buyerId, qty, affiliateRef, deliveryOptionId, buyerName, deliveryAddress, deliveryCity, deliveryNote, otpToken, otpChallengeId, authorizationId, authorizationProvider, authorizationCorrelationId, paymentDisclosureAccepted }) {
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
        buyer_name: buyerName || undefined,
        delivery_address: deliveryAddress || undefined,
        delivery_city: deliveryCity || undefined,
        delivery_notes: deliveryNote || undefined,
        otp_token: otpToken || undefined,
        otp_challenge_id: otpChallengeId || undefined,
        authorization_id: authorizationId || undefined,
        authorization_provider: authorizationProvider || undefined,
        authorization_correlation_id: authorizationCorrelationId || undefined,
        payment_disclosure_accepted: paymentDisclosureAccepted === true
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
    return { title: "נדרשת כניסת מוכר", message: "המשך העבודה בניהול העסקאות מחייב כניסה מחדש עם פרטי הגישה של המוכר." };
  }
  if (status === 401 && lower.includes("seller id or access code is invalid")) {
    return { title: "פרטי הגישה לא נכונים", message: "מזהה המוכר או קוד הגישה לא תואמים לרשימת המוכרים המורשים של סביבת ה-launch." };
  }
  if (status === 403 && lower.includes("manual seller context switching is disabled")) {
    return { title: "החלפת זהות ידנית חסומה", message: "בסביבה הזו זהות המוכר נקבעת דרך מנגנון הכניסה הפעיל, ולכן אי אפשר להחליף אותה ידנית מתוך הטופס." };
  }
  if (status === 503 && lower.includes("seller auth is not configured")) {
    return { title: "גישה למוכר עדיין לא הוגדרה", message: "סביבת העבודה עדיין לא קיבלה את כל פרטי הגישה למוכר, ולכן האזור נשאר חסום עד להשלמת ההגדרה." };
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
  if (lower.includes("title is required") || String(error?.code || "") === "title_required") {
    return { title: "חסר שם לעסקה.", message: "אנא הזן שם קצר וברור לעסקה. לא נשלח request תקין בלי שם עסקה." };
  }
  if (status >= 500) {
    return { title: "המערכת כרגע לא זמינה", message: `לא הצלחנו להשלים את הפעולה בגלל בעיית שרת. קוד: ${friendlyApiCode(error)}. כדאי לנסות שוב בעוד רגע.` };
  }
  if (lower.includes("networkerror") || lower.includes("failed to fetch") || lower.includes("load failed")) {
    return { title: "בעיית חיבור", message: "לא הצלחנו להגיע לשרת. בדוק את החיבור לאינטרנט ונסה שוב." };
  }
  return {
    title: "אירעה שגיאה",
    message: `${fallback || message || "נסה שוב בעוד רגע."} קוד: ${friendlyApiCode(error)}.`
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

function renderDeliveryOptionDetails(option) {
  const label = String(option?.label || "");
  const urlMatch = label.match(/https?:\/\/[^\s·]+/i);
  const locationUrl = urlMatch ? urlMatch[0] : "";
  if (!locationUrl && option?.option_type !== "distribution_point") return "";
  return `
    <div class="delivery-location-details">
      ${option?.option_type === "distribution_point" ? `<span class="badge success">מיקום נקודת החלוקה מופיע לפני הצטרפות</span>` : ""}
      ${locationUrl ? `<a href="${esc(locationUrl)}" target="_blank" rel="noopener noreferrer">פתיחת קישור מיקום</a>` : ""}
    </div>
  `;
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
  const errors = [];
  const fieldErrors = {};
  const fulfillmentType = String(formData.get("sellerFulfillmentType") || state.form.sellerFulfillmentType || "delivery").trim();
  if (fulfillmentType === "delivery") {
    options.push({
      option_type: "delivery",
      label: "משלוח",
      cost: 0,
      sort_order: 0
    });
    return { options, errors, fieldErrors };
  }
  for (let index = 1; index <= 5; index += 1) {
    const type = fulfillmentType === "distribution_point" ? "distribution_point" : "pickup";
    const label = String(formData.get(`sellerDeliveryLabel${index}`) || "").trim();
    const rawCost = String(formData.get(`sellerDeliveryCost${index}`) || "").trim();
    const pointName = String(formData.get(`sellerDeliveryPointName${index}`) || "").trim();
    const address = String(formData.get(`sellerDeliveryAddress${index}`) || "").trim();
    const city = String(formData.get(`sellerDeliveryCity${index}`) || "").trim();
    const instructions = String(formData.get(`sellerDeliveryInstructions${index}`) || "").trim();
    const locationUrl = String(formData.get(`sellerDeliveryLocationUrl${index}`) || "").trim();
    if (!label && !rawCost && !pointName && !address && !city && !instructions && !locationUrl) continue;
    const cost = Number(rawCost || 0);
    if (!Number.isFinite(cost) || cost < 0) {
      errors.push(`אפשרות קבלה ${index}: עלות לא תקינה.`);
      fieldErrors[`sellerDeliveryCost${index}`] = "עלות המיקום חייבת להיות מספר לא שלילי.";
      continue;
    }
    let finalLabel = label;
    if (type === "distribution_point" || type === "pickup") {
      const locationKind = type === "distribution_point" ? "נקודת חלוקה" : "מיקום איסוף";
      if (!pointName) {
        errors.push(`${locationKind} ${index}: חסר שם המקום.`);
        fieldErrors[`sellerDeliveryPointName${index}`] = "יש להזין שם מקום.";
      }
      if (!address) {
        errors.push(`${locationKind} ${index}: חסרה כתובת.`);
        fieldErrors[`sellerDeliveryAddress${index}`] = "יש להזין כתובת.";
      }
      if (!city) {
        errors.push(`${locationKind} ${index}: חסרה עיר.`);
        fieldErrors[`sellerDeliveryCity${index}`] = "יש להזין עיר.";
      }
      if (locationUrl && !/^https?:\/\//i.test(locationUrl)) {
        errors.push(`${locationKind} ${index}: קישור המיקום חייב להתחיל ב-http או https.`);
        fieldErrors[`sellerDeliveryLocationUrl${index}`] = "קישור מיקום חייב להתחיל ב-http או https.";
      }
      finalLabel = buildDistributionPointLabel({
        label,
        pointName,
        address,
        city,
        instructions,
        locationUrl
      });
    }
    if (!finalLabel) {
      errors.push(`אפשרות קבלה ${index}: חסרה תווית ברורה לקונה.`);
      fieldErrors[`sellerDeliveryLabel${index}`] = "יש להזין תווית קצרה לקונה.";
      continue;
    }
    options.push({
      option_type: type || "pickup",
      label: finalLabel,
      cost,
      sort_order: options.length
    });
  }
  if ((fulfillmentType === "pickup" || fulfillmentType === "distribution_point") && !options.length && !errors.length) {
    errors.push("בחרת איסוף עצמי או נקודת חלוקה. יש להוסיף לפחות מיקום אחד.");
    fieldErrors.sellerFulfillmentType = "בחרת איסוף עצמי או נקודת חלוקה. יש להוסיף לפחות מיקום אחד.";
  }
  return { options, errors, fieldErrors };
}

function buildDistributionPointLabel({ label, pointName, address, city, instructions, locationUrl }) {
  const title = label || pointName;
  const parts = [];
  if (title) parts.push(title);
  if (address || city) parts.push([address, city].filter(Boolean).join(", "));
  if (instructions) parts.push(`הוראות: ${instructions}`);
  if (locationUrl) parts.push(`קישור מיקום: ${locationUrl}`);
  return parts.filter(Boolean).join(" · ");
}

function rememberSellerCreateForm(formData) {
  for (const [key, value] of formData.entries()) {
    if (key in state.form && key !== "sellerImage") {
      state.form[key] = String(value || "");
    }
  }
  state.form.sellerFinalTerms = formData.get("sellerFinalTerms") === "on" ? "on" : "";
  state.form.sellerFinalConfirm = formData.get("sellerFinalConfirm") === "on" ? "on" : "";
}

function friendlyApiCode(error) {
  const code = String(error?.code || "").trim();
  const status = Number(error?.status || 0);
  if (code) return code;
  return status ? `HTTP ${status}` : "request_failed";
}

function validatePayment(payload) {
  if (!payload.payer_name || !payload.payment_method_id) {
    return "יש להזין שם למשלם/ת ולאשר את תפיסת המסגרת דרך רכיב ספק הסליקה המאובטח.";
  }
  return "";
}

function getFlow(dealId) {
  const all = readFlow();
  let flow = all[dealId] || null;
  if (!flow) {
    flow = readSafeResume(dealId);
    if (flow) {
      all[dealId] = flow;
      try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(all)); } catch {}
    }
  }
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

function currentTrackingToken(participantId) {
  const fromUrl = new URLSearchParams(location.search).get("t");
  if (fromUrl) return fromUrl;
  const flows = readFlow();
  for (const flow of Object.values(flows)) {
    if (flow && flow.participantId === participantId && flow.trackingAccessToken) {
      return flow.trackingAccessToken;
    }
  }
  return "";
}

function trackingApiUrl(participantId) {
  const base = `/api/participants/${encodeURIComponent(participantId)}/tracking`;
  const token = currentTrackingToken(participantId);
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}

function saveFlow(dealId, next) {
  const all = readFlow();
  all[dealId] = { ...(all[dealId] || {}), ...next, updatedAt: new Date().toISOString(), _v: FLOW_SCHEMA_VERSION };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
  writeSafeResume(dealId, all[dealId]);
  return all[dealId];
}

function clearFlowFields(dealId, keys) {
  const all = readFlow();
  if (!all[dealId]) return;
  for (const key of keys) delete all[dealId][key];
  all[dealId].updatedAt = new Date().toISOString();
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
  writeSafeResume(dealId, all[dealId]);
}

function removeFlow(dealId) {
  const all = readFlow();
  delete all[dealId];
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
  removeSafeResume(dealId);
}

function readFlow() {
  try {
    return JSON.parse(sessionStorage.getItem(FLOW_KEY) || "{}");
  } catch {
    return {};
  }
}

function safeResumeProjection(dealId, flow) {
  const allowed = [
    "dealTitle", "qty", "deliveryOptionId", "deliveryMethodType",
    "deliveryMethodLabel", "deliveryCost", "affiliateRef", "estimatedTotal",
    "startedAt"
  ];
  const projected = {
    dealId,
    _v: FLOW_SCHEMA_VERSION,
    _safeV: SAFE_RESUME_SCHEMA_VERSION,
    updatedAt: new Date().toISOString()
  };
  for (const key of allowed) {
    if (flow?.[key] !== undefined) projected[key] = flow[key];
  }
  return projected;
}

function writeSafeResume(dealId, flow) {
  try {
    const all = JSON.parse(localStorage.getItem(SAFE_RESUME_KEY) || "{}");
    all[dealId] = safeResumeProjection(dealId, flow);
    localStorage.setItem(SAFE_RESUME_KEY, JSON.stringify(all));
  } catch {}
}

function readSafeResume(dealId) {
  try {
    const all = JSON.parse(localStorage.getItem(SAFE_RESUME_KEY) || "{}");
    const resume = all[dealId] || null;
    if (!resume || resume._safeV !== SAFE_RESUME_SCHEMA_VERSION) return null;
    if (!resume.updatedAt || Date.now() - new Date(resume.updatedAt).getTime() > SAFE_RESUME_TTL_MS) {
      removeSafeResume(dealId);
      return null;
    }
    return { ...resume, updatedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

function removeSafeResume(dealId) {
  try {
    const all = JSON.parse(localStorage.getItem(SAFE_RESUME_KEY) || "{}");
    delete all[dealId];
    localStorage.setItem(SAFE_RESUME_KEY, JSON.stringify(all));
  } catch {}
}

function defaultSellerContext() {
  return {
    seller_id: "seller-default",
    display_name: "מוכר דמו ברירת מחדל",
    verification_status: "approved",
    settlement_status: "active",
    is_default_context: true,
    context_source: "default_fallback"
  };
}

function lockedSellerContext() {
  return {
    seller_id: "",
    display_name: "נדרשת התחברות מוכר",
    verification_status: "pending",
    settlement_status: "review",
    is_default_context: false,
    context_source: "session_required"
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
    return state.sellerAuth?.seller_context || state.homePayload?.site?.seller_context || lockedSellerContext();
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
    return "מוכר דמו ברירת מחדל";
  }
  return displayName || "";
}

function syncSellerContext(next) {
  const normalized = { ...defaultSellerContext(), ...(next || {}) };
  if (
    normalized.seller_id === "seller-default" &&
    (!normalized.display_name || normalized.display_name === "Default Seller Workspace")
  ) {
    normalized.display_name = "מוכר דמו ברירת מחדל";
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
        <span class="eyebrow">ניהול העסקאות שלי</span>
        <h1>${configured ? "נדרשת כניסת מוכר" : "ניהול העסקאות עדיין לא זמין בסביבה הזו"}</h1>
        <p class="muted">${configured ? "כדי לפתוח, לפרסם ולנהל עסקאות צריך להיכנס עם פרטי הגישה של המוכר שהוגדרו לסביבה הזו. בלי כניסה תקינה משטח המוכר נשאר חסום." : "בסביבה הנוכחית עדיין לא הוגדרו פרטי גישה מלאים למוכר. החסימה נשארת מכוונת כדי לא ליצור מצג שווא של גישה פעילה."}</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">מקור הזיהוי</span><strong>כניסת מוכר דרך השרת</strong></div>
          <div class="trust-point"><span class="muted">מה לא פותח גישה</span><strong>שמירה מקומית בדפדפן בלבד</strong></div>
          <div class="trust-point"><span class="muted">שמירת גישה</span><strong>המשטח נשאר מבוקר ומופרד</strong></div>
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
            <strong>${auth.authenticated ? esc(sellerContext.display_name) : auth.configured === false ? "נדרשת השלמת הגדרת סביבה" : "כניסת מוכר"}</strong>
          </div>
          <span class="badge ${auth.authenticated ? "success" : auth.configured === false ? "danger" : "warning"}">${auth.authenticated ? "גישה פעילה" : auth.configured === false ? "לא הוגדר" : "נעול"}</span>
        </div>
        <p class="small muted">${auth.authenticated ? `הגישה של המוכר מזוהה כעת כ-<span class="mono">${esc(sellerContext.seller_id)}</span>, וכל העסקאות שמוצגות כאן שייכות לזהות הזו.` : auth.configured === false ? "הסביבה הזו עדיין לא קיבלה את כל פרטי הגישה הנדרשים למוכר, ולכן המשטח נשאר חסום בצורה מכוונת." : "כדי להיכנס לניהול העסקאות צריך להזין מזהה מוכר וקוד גישה שהוגדרו מראש לסביבת העבודה."}</p>
        ${auth.authenticated ? `
          <form data-action="seller-logout" class="stack">
            <div class="actions">
              <button class="secondary" type="submit">יציאה מניהול העסקאות</button>
            </div>
          </form>
        ` : auth.configured === false ? "" : `
          <form data-action="seller-login" class="stack">
            <div class="inline-fields">
              <div class="field">
                <label for="sellerContextId">מזהה מוכר</label>
                <input id="sellerContextId" name="sellerContextId" type="text" data-dir="ltr" autocomplete="username" value="${esc(state.form.sellerContextId || "")}" placeholder="seller-north" />
              </div>
              <div class="field">
                <label for="sellerAccessCode">קוד גישה</label>
                <input id="sellerAccessCode" name="sellerAccessCode" type="password" data-dir="ltr" autocomplete="current-password" value="${esc(state.form.sellerAccessCode || "")}" placeholder="קוד גישה" />
              </div>
            </div>
            <div class="actions">
              <button class="primary" type="submit">כניסה לניהול העסקאות</button>
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
    sellerContext.display_name = "מוכר דמו ברירת מחדל";
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
      <p class="small muted">כל עסקה חדשה תיווצר תחת <span class="mono">${esc(sellerContext.seller_id)}</span>. ניהול העסקאות מציג רק את העסקאות של הזהות הפעילה.</p>
      ${sellerContext.is_default_context ? `<p class="small muted">כדאי לשמור מזהה מוכר ברור כדי לא לעבוד תחת ברירת מחדל עמומה.</p>` : ""}
      <form data-action="seller-context" class="stack">
        <div class="inline-fields">
          <div class="field">
            <label for="sellerContextId">מזהה מוכר</label>
            <input id="sellerContextId" name="sellerContextId" type="text" data-dir="ltr" value="${esc(state.form.sellerContextId || sellerContext.seller_id)}" placeholder="seller-north" />
          </div>
          <div class="field">
            <label for="sellerContextName">שם מוכר לתצוגה</label>
            <input id="sellerContextName" name="sellerContextName" type="text" data-dir="rtl" value="${esc(state.form.sellerContextName || sellerContext.display_name)}" placeholder="C-ton צפון" />
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
  return { label: item[0], title: item[0], description: item[1], badgeTone: DEAL_TONE[stateName] || "warning" };
}

function getLabel(map, key) {
  return map[key] || [key, "נמצא מצב שלא קיבל ניסוח ייעודי."];
}

function nextDealAction(stateName, canJoin) {
  if (canJoin) {
    return {
      cta: stateName === "TargetReached" ? "הצטרפו ליחידות האחרונות" : "הצטרפו לעסקה",
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

function percent(value) {
  return `${num(Math.round(Number(value || 0)))}%`;
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

function absoluteUrl(pathOrUrl) {
  try {
    return new URL(pathOrUrl || "/app", location.origin).toString();
  } catch {
    return location.origin + "/app";
  }
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

function failValidation(title, items) {
  state.error = {
    title,
    message: "מצאנו כמה דברים שצריך לתקן לפני שאפשר להמשיך. כל מה שכבר מילאת נשמר במסך, כולל אישורי תקנון שסומנו.",
    items
  };
  render();
  if (state.route.name === "seller-new") focusCreateDealError();
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
