const root = document.getElementById("app");
const FLOW_KEY = "siton_flow_v2";
const FLOW_SCHEMA_VERSION = 2;
const SELLER_CONTEXT_KEY = "siton_seller_context_v1";
const FLOW_TTL_MS = 1000 * 60 * 60 * 6;
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
  adminSellerStatusModal: null,
  adminSellerStatusReason: "",
  adminDealPayload: null,
  adminDealOpsPayload: null,
  adminParticipantOpsPayload: null,
  adminUserPayload: null,
  error: null,
  banner: null,
  form: {
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
    sellerDescription: "",
    sellerImageDataUrl: "",
    sellerImageName: "",
    sellerContextId: "",
    sellerContextName: "",
    sellerAccessCode: "",
    sellerPrice: "10",
    sellerMinUnits: "10",
    sellerMaxUnits: "20",
    sellerDeadline: "",
    sellerDeliveryType1: "pickup",
    sellerDeliveryLabel1: "איסוף עצמי",
    sellerDeliveryCost1: "0",
    sellerDeliveryType2: "delivery",
    sellerDeliveryLabel2: "",
    sellerDeliveryCost2: "0",
    sellerDeliveryType3: "distribution_point",
    sellerDeliveryLabel3: "",
    sellerDeliveryCost3: "0",
    sellerBizName: "",
    sellerContactName: "",
    sellerSupportPhone: "",
    sellerSupportEmail: "",
    sellerBizDesc: "",
    sellerBizId: "",
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
  "מרכז התפעול של סיטון",
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
  Draft: ["׳”׳¢׳¡׳§׳” ׳¢׳“׳™׳™׳ ׳‘׳˜׳™׳•׳˜׳”", "׳”׳¢׳¡׳§׳” ׳¢׳•׳“ ׳׳ ׳ ׳₪׳×׳—׳” ׳׳§׳•׳ ׳™׳ ׳•׳׳›׳ ׳¢׳“׳™׳™׳ ׳׳™ ׳׳₪׳©׳¨ ׳׳”׳¦׳˜׳¨׳£."],
  PendingTarget: ["׳₪׳×׳•׳—׳” ׳׳”׳¦׳˜׳¨׳₪׳•׳×", "׳׳₪׳©׳¨ ׳׳”׳¦׳˜׳¨׳£ ׳¢׳›׳©׳™׳•. ׳‘׳©׳׳‘ ׳”׳–׳” ׳ ׳©׳׳¨׳™׳ ׳׳™׳׳•׳×, ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳•׳”׳¨׳©׳׳” ׳׳¢׳¡׳§׳”."],
  TargetReached: ["׳”׳™׳¢׳“ ׳”׳•׳©׳’", "׳”׳¢׳¡׳§׳” ׳—׳¦׳×׳” ׳׳× ׳”׳™׳¢׳“ ׳•׳¢׳“׳™׳™׳ ׳₪׳×׳•׳—׳” ׳׳”׳¦׳˜׳¨׳₪׳•׳× ׳›׳ ׳¢׳•׳“ ׳ ׳©׳׳¨׳” ׳§׳™׳‘׳•׳׳×."],
  ClosedForJoining: ["׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳¡׳’׳¨", "׳”׳¢׳¡׳§׳” ׳›׳‘׳¨ ׳¢׳‘׳¨׳” ׳׳©׳׳‘ ׳”׳‘׳, ׳•׳׳›׳ ׳׳ ׳ ׳™׳×׳ ׳׳”׳¦׳˜׳¨׳£ ׳׳׳™׳” ׳›׳¢׳×."],
  ReadyForCharging: ["׳׳•׳›׳ ׳” ׳׳—׳™׳•׳‘", "׳”׳¢׳¡׳§׳” ׳›׳‘׳¨ ׳׳ ׳₪׳×׳•׳—׳” ׳׳”׳¦׳˜׳¨׳₪׳•׳× ׳—׳“׳©׳” ׳•׳”׳™׳ ׳ ׳¢׳¨׳›׳× ׳׳©׳׳‘ ׳”׳—׳™׳•׳‘."],
  Charging: ["׳‘׳—׳™׳•׳‘", "׳”׳׳¢׳¨׳›׳× ׳׳¨׳™׳¦׳” ׳›׳¢׳× ׳—׳™׳•׳‘׳™׳ ׳•׳׳™׳ ׳׳₪׳©׳¨׳•׳× ׳׳”׳¦׳˜׳¨׳£ ׳׳—׳“׳© ׳׳¢׳¡׳§׳”."],
  CompletionWindow: ["׳‘׳—׳׳•׳ ׳”׳©׳׳׳”", "׳”׳¢׳¡׳§׳” ׳ ׳׳¦׳׳× ׳‘׳¡׳’׳™׳¨׳” ׳×׳₪׳¢׳•׳׳™׳× ׳•׳׳›׳ ׳׳ ׳₪׳×׳•׳—׳” ׳׳”׳¦׳˜׳¨׳₪׳•׳× ׳—׳“׳©׳”."],
  Completed: ["׳”׳•׳©׳׳׳”", "׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳”. ׳׳ ׳”׳©׳×׳×׳₪׳×, ׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳™׳¦׳™׳’ ׳׳× ׳”׳×׳•׳¦׳׳” ׳©׳׳."],
  Failed: ["׳׳ ׳”׳•׳©׳׳׳”", "׳”׳¢׳¡׳§׳” ׳ ׳¡׳’׳¨׳” ׳׳׳ ׳”׳©׳׳׳”. ׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳™׳¡׳‘׳™׳¨ ׳׳” ׳§׳¨׳” ׳׳”׳©׳×׳×׳₪׳•׳×."],
  Cancelled: ["׳‘׳•׳˜׳׳”", "׳”׳¢׳¡׳§׳” ׳‘׳•׳˜׳׳” ׳•׳׳›׳ ׳׳ ׳ ׳™׳×׳ ׳׳”׳¦׳˜׳¨׳£ ׳׳׳™׳”."]
};

const BUYER_COPY = {
  JoinedAuthorized: ["׳ ׳¨׳©׳׳× ׳‘׳”׳¦׳׳—׳”", "׳”׳”׳©׳×׳×׳₪׳•׳× ׳ ׳§׳׳˜׳” ׳•׳ ׳©׳׳¨ ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×."],
  LockedIn: ["׳ ׳ ׳¢׳׳× ׳׳¢׳¡׳§׳”", "׳”׳”׳©׳×׳×׳₪׳•׳× ׳©׳׳ ׳›׳‘׳¨ ׳‘׳₪׳ ׳™׳, ׳׳₪׳ ׳™ ׳©׳׳‘ ׳”׳—׳™׳•׳‘."],
  ChargingAttempt: ["׳׳×׳‘׳¦׳¢ ׳ ׳™׳¡׳™׳•׳ ׳—׳™׳•׳‘", "׳”׳¢׳¡׳§׳” ׳”׳’׳™׳¢׳” ׳׳©׳׳‘ ׳©׳‘׳• ׳”׳׳¢׳¨׳›׳× ׳׳ ׳¡׳” ׳׳—׳™׳™׳‘."],
  ChargedSuccess: ["׳”׳—׳™׳•׳‘ ׳”׳¦׳׳™׳—", "׳”׳—׳™׳•׳‘ ׳¢׳‘׳•׳¨ ׳”׳”׳©׳×׳×׳₪׳•׳× ׳©׳׳ ׳¢׳‘׳¨ ׳‘׳”׳¦׳׳—׳”."],
  ChargeFailedCompletion: ["׳ ׳“׳¨׳© ׳˜׳™׳₪׳•׳ ׳‘׳”׳©׳׳׳”", "׳”׳—׳™׳•׳‘ ׳׳ ׳”׳•׳©׳׳ ׳•׳”׳”׳©׳×׳×׳₪׳•׳× ׳ ׳׳¦׳׳× ׳‘׳—׳׳•׳ ׳”׳©׳׳׳”."],
  Recovered: ["׳”׳•׳©׳׳׳” ׳‘׳©׳—׳–׳•׳¨", "׳”׳׳¢׳¨׳›׳× ׳”׳©׳׳™׳׳” ׳׳× ׳”׳”׳©׳×׳×׳₪׳•׳× ׳‘׳׳¡׳׳•׳ ׳©׳—׳–׳•׳¨."],
  Dropped: ["׳”׳”׳©׳×׳×׳₪׳•׳× ׳™׳¨׳“׳”", "׳”׳”׳©׳×׳×׳₪׳•׳× ׳©׳׳ ׳׳ ׳”׳•׳©׳׳׳” ׳‘׳×׳•׳ ׳”׳¢׳¡׳§׳”."],
  DealCompleted: ["׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳” ׳¢׳‘׳•׳¨׳", "׳”׳”׳©׳×׳×׳₪׳•׳× ׳ ׳¡׳’׳¨׳” ׳›׳—׳׳§ ׳׳¢׳¡׳§׳” ׳©׳”׳•׳©׳׳׳”."],
  DealFailed: ["׳”׳¢׳¡׳§׳” ׳ ׳›׳©׳׳” ׳¢׳‘׳•׳¨׳", "׳”׳”׳©׳×׳×׳₪׳•׳× ׳ ׳¡׳’׳¨׳” ׳›׳—׳׳§ ׳׳¢׳¡׳§׳” ׳©׳׳ ׳”׳•׳©׳׳׳”."]
};

const MONEY_COPY = {
  AuthHeld: ["׳™׳© ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳×", "׳‘׳•׳¦׳¢ ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“. ׳¢׳“׳™׳™׳ ׳׳™׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳."],
  AuthLocked: ["׳×׳₪׳™׳¡׳× ׳”׳׳¡׳’׳¨׳× ׳ ׳ ׳¢׳׳”", "׳”׳׳™׳©׳•׳¨ ׳ ׳©׳׳¨ ׳׳§׳¨׳׳× ׳—׳™׳•׳‘ ׳׳₪׳©׳¨׳™."],
  ChargeAttempt: ["׳׳×׳‘׳¦׳¢ ׳—׳™׳•׳‘", "׳”׳׳¢׳¨׳›׳× ׳׳ ׳¡׳” ׳׳‘׳¦׳¢ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳."],
  ChargedSuccess: ["׳—׳•׳™׳‘׳×", "׳”׳—׳™׳•׳‘ ׳”׳•׳©׳׳ ׳‘׳”׳¦׳׳—׳”."],
  ChargeFailedRecovery: ["׳”׳—׳™׳•׳‘ ׳׳ ׳”׳•׳©׳׳", "׳”׳׳¢׳¨׳›׳× ׳׳ ׳¡׳” ׳׳¡׳’׳•׳¨ ׳׳× ׳”׳׳¡׳׳•׳ ׳“׳¨׳ ׳׳¡׳׳•׳ ׳©׳—׳–׳•׳¨."],
  RecoveredCharge: ["׳”׳—׳™׳•׳‘ ׳”׳•׳©׳׳ ׳‘׳©׳—׳–׳•׳¨", "׳”׳׳¢׳¨׳›׳× ׳”׳¦׳׳™׳—׳” ׳׳”׳©׳׳™׳ ׳׳× ׳”׳—׳™׳•׳‘ ׳‘׳׳¡׳׳•׳ ׳©׳—׳–׳•׳¨."],
  AuthReleased: ["׳×׳₪׳™׳¡׳× ׳”׳׳¡׳’׳¨׳× ׳©׳•׳—׳¨׳¨׳”", "׳׳ ׳‘׳•׳¦׳¢ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳׳• ׳©׳”׳×׳₪׳™׳¡׳” ׳‘׳•׳˜׳׳”."],
  Refunded: ["׳‘׳•׳¦׳¢ ׳–׳™׳›׳•׳™", "׳”׳׳¢׳¨׳›׳× ׳”׳—׳–׳™׳¨׳” ׳׳× ׳”׳¡׳›׳•׳ ׳׳׳—׳¨ ׳—׳™׳•׳‘."]
};

const ROUTE_LABELS = {
  seller: "אזור מוכר",
  "seller-new": "פתיחת עסקה",
  "seller-deal": "ניהול עסקה",
  affiliate: "מרכז הפצה",
  admin: "מרכז תפעול",
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
  contact: "יצירת קשר",
  "not-found": "עמוד לא נמצא"
};

const PAYMENT_READINESS = {
  settlementModel: "קודם מתבצעת תפיסת מסגרת, ורק אחרי סגירת העסקה בהצלחה יכול להתבצע חיוב בפועל",
  integrationNote: "מסלול ההצטרפות נשאר זהה: אישור מסגרת עכשיו, חיוב רק אם העסקה נסגרת בהצלחה."
};

const INTERNAL_SURFACE_ROUTES = new Set(["affiliate", "admin", "admin-deal", "admin-user"]);
const PUBLIC_TRUST_ROUTES = new Set(["home", "deal", "otp", "payment", "confirmation", "tracking", "recovery", "terms", "privacy", "refunds", "contact"]);

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
    if (action === "seller-clone") void cloneSellerDeal(actionTarget.dataset.dealId);
    if (action === "share-link") void shareLink(actionTarget.dataset.shareUrl, actionTarget.dataset.shareTitle);
    if (action === "copy-link") void copyLink(actionTarget.dataset.shareUrl);
    if (action === "seller-excel-export") void downloadSellerDealExport(actionTarget.dataset.dealId);
    if (action === "download-delivery-handoff-excel") void downloadDeliveryHandoffExcel(actionTarget.dataset.dealId);
    if (action === "copy-delivery-address") void copyLink(actionTarget.dataset.address);
    if (action === "seller-analytics-period") void loadSellerAnalytics(actionTarget.dataset.period || "all");
    if (action === "seller-analytics-refresh") void loadSellerAnalytics(state.sellerAnalyticsPeriod || "all");
    if (action === "admin-refresh") void loadAdmin(state.form.adminQuery);
    if (action === "admin-seller-status-open") openSellerStatusModal(actionTarget);
    if (action === "admin-seller-status-close") closeSellerStatusModal();
    if (action === "clear-product-image") clearSellerProductImage();
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
  if (!(target.name in state.form)) return;
  state.form[target.name] = target.value;
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "sellerImage") void handleSellerImageSelection(target);
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
    ["contact", /^\/app\/contact$/],
    ["seller", /^\/app\/seller$/],
    ["seller-new", /^\/app\/seller\/new$/],
    ["seller-deal", /^\/app\/seller\/deals\/([^/]+)$/],
    ["affiliate", /^\/app\/affiliate$/],
    ["admin", /^\/app\/admin$/],
    ["admin-deal", /^\/app\/admin\/deals\/([^/]+)$/],
    ["admin-participant", /^\/app\/admin\/participants\/([^/]+)$/],
    ["admin-user", /^\/app\/admin\/users\/([^/]+)$/]
  ];

  for (const [name, regex] of patterns) {
    const match = normalized.match(regex);
    if (!match) continue;
    if (name === "seller" || name === "seller-new" || name === "affiliate" || name === "admin" || name === "terms" || name === "privacy" || name === "refunds" || name === "contact") {
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
  if (route.name === "admin-deal") return loadAdminDeal(route.dealId);
  if (route.name === "admin-participant") return loadAdminParticipant(route.participantId);
  if (route.name === "admin-user") return loadAdminUser(route.buyerId);

  if (["otp", "payment", "confirmation"].includes(route.name)) {
    await ensureDeal(route.dealId);
    const flow = getFlow(route.dealId);
    if (!flow) {
      state.banner = {
        tone: "warning",
        title: "׳”׳¡׳©׳ ׳”׳§׳•׳“׳ ׳›׳‘׳¨ ׳׳ ׳–׳׳™׳",
        message: "׳׳₪׳©׳¨ ׳׳—׳–׳•׳¨ ׳׳“׳£ ׳”׳¢׳¡׳§׳” ׳•׳׳”׳×׳—׳™׳ ׳©׳•׳‘ ׳׳× ׳”׳׳¡׳׳•׳ ׳‘׳¦׳•׳¨׳” ׳׳¡׳•׳“׳¨׳×."
      };
      render();
      return;
    }

    if (route.name === "payment" && !flow.otpVerified) {
      state.banner = {
        tone: "warning",
        title: "׳¦׳¨׳™׳ ׳׳”׳©׳׳™׳ ׳§׳•׳“׳ ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳",
        message: "׳”׳›׳׳•׳× ׳ ׳©׳׳¨׳”, ׳׳‘׳ ׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳¦׳¨׳™׳ ׳׳”׳©׳׳™׳ ׳׳× ׳׳™׳׳•׳× ׳”׳˜׳׳₪׳•׳."
      };
      render();
      return;
    }

    if (route.name === "confirmation" && !flow.participantId) {
      state.banner = {
        tone: "warning",
        title: "׳¢׳“׳™׳™׳ ׳׳™׳ ׳”׳¦׳˜׳¨׳₪׳•׳× ׳¡׳•׳₪׳™׳× ׳׳”׳¦׳’׳”",
        message: "׳׳₪׳©׳¨ ׳׳—׳–׳•׳¨ ׳׳©׳׳‘ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳•׳׳”׳׳©׳™׳ ׳׳׳™׳₪׳” ׳©׳¢׳¦׳¨׳×."
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
  await busy("׳˜׳•׳¢׳ ׳׳× ׳₪׳¨׳˜׳™ ׳”׳¢׳¡׳§׳”...", async () => {
    state.dealPayload = await api(`/api/deals/${encodeURIComponent(dealId)}/public`);
    await loadDealChat(dealId, false);
    state.form.qty = String(getFlow(dealId)?.qty || 1);
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳”׳¢׳¡׳§׳”.");
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
  await busy("׳˜׳•׳¢׳ ׳׳× ׳¡׳˜׳˜׳•׳¡ ׳”׳”׳©׳×׳×׳₪׳•׳×...", async () => {
    state.trackingPayload = await api(`/api/participants/${encodeURIComponent(participantId)}/tracking`);
    const tracking = state.trackingPayload?.tracking;
    if (tracking?.deal_id) {
      saveFlow(tracking.deal_id, {
        participantId: tracking.participant_id,
        buyerId: tracking.buyer_id,
        lastTrackingViewedAt: new Date().toISOString()
      });
    }
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳”׳׳¢׳§׳‘.");
}

async function loadRecovery(participantId) {
  await busy("טוען את מסך השלמת התשלום...", async () => {
    state.recoveryPayload = await api(`/api/participants/${encodeURIComponent(participantId)}/tracking`);
  }, "לא הצלחנו לטעון את מסך השלמת התשלום.");
}

async function refreshRecoverySilently(participantId) {
  try {
    state.recoveryPayload = await api(`/api/participants/${encodeURIComponent(participantId)}/tracking`);
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
    const response = await api(`/api/participants/${encodeURIComponent(participantId)}/recovery`, {
      method: "POST",
      headers: {
        "x-request-id": idemKey,
        "idempotency-key": idemKey
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
  await busy("׳˜׳•׳¢׳ ׳׳× ׳”׳׳×׳¨ ׳”׳¨׳׳©׳™ ׳©׳ ׳¡׳™׳˜׳•׳...", async () => {
    state.homePayload = await api("/api/site/home");
    state.sellerAuth = state.homePayload?.site?.seller_auth || state.sellerAuth;
    syncSellerContext(state.homePayload?.site?.seller_context || null);
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳”׳׳×׳¨ ׳”׳¨׳׳©׳™ ׳©׳ ׳¡׳™׳˜׳•׳.");
}

async function loadSeller() {
  await busy('טוען את אזור המוכר...', async () => {
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
  }, 'לא הצלחנו לטעון את אזור המוכר.');
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
  await busy("׳˜׳•׳¢׳ ׳׳× ׳׳¡׳ ׳”׳©׳•׳×׳₪׳™׳ ׳”׳₪׳ ׳™׳׳™...", async () => {
    state.affiliatePayload = await api("/api/affiliate/overview");
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳׳¡׳ ׳”׳©׳•׳×׳₪׳™׳ ׳”׳₪׳ ׳™׳׳™.");
}

async function loadAdmin(query = "") {
  await busy("׳˜׳•׳¢׳ ׳׳× ׳׳¡׳ ׳”׳ ׳™׳”׳•׳ ׳”׳₪׳ ׳™׳׳™...", async () => {
    const [overview, missionControl, launchConsole, systemStatus, notificationsStatus, invoiceStatus, sellerRisk] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(query || "")}`),
      api(`/api/admin/mission-control?q=${encodeURIComponent(query || "")}`),
      api("/api/admin/launch-console"),
      api("/api/admin/system-status"),
      api("/api/admin/notifications-status"),
      api("/api/admin/invoice-status"),
      api("/api/admin/sellers/risk")
    ]);
    state.adminPayload = overview;
    state.adminMissionPayload = missionControl;
    state.adminLaunchPayload = launchConsole;
    state.adminSystemStatusPayload = systemStatus;
    state.adminNotificationsStatusPayload = notificationsStatus;
    state.adminInvoiceStatusPayload = invoiceStatus;
    state.adminSellerRiskPayload = sellerRisk;
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳׳¡׳ ׳”׳ ׳™׳”׳•׳ ׳”׳₪׳ ׳™׳׳™.");
}

async function loadAdminDeal(dealId) {
  await busy("׳˜׳•׳¢׳ ׳׳× ׳₪׳¨׳•׳₪׳™׳ ׳”׳¢׳¡׳§׳” ׳”׳₪׳ ׳™׳׳™...", async () => {
    const [profile, opsSummary] = await Promise.all([
      api(`/api/admin/deals/${encodeURIComponent(dealId)}/profile`),
      api(`/api/admin/deals/${encodeURIComponent(dealId)}/ops-summary`)
    ]);
    state.adminDealPayload = profile;
    state.adminDealOpsPayload = opsSummary;
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳₪׳¨׳•׳₪׳™׳ ׳”׳¢׳¡׳§׳” ׳”׳₪׳ ׳™׳׳™.");
}

async function loadAdminParticipant(participantId) {
  await busy("טוען את פרופיל המשתתף לתפעול...", async () => {
    state.adminParticipantOpsPayload = await api(`/api/admin/participants/${encodeURIComponent(participantId)}/ops`);
  }, "לא הצלחנו לטעון את פרופיל המשתתף לתפעול.");
}

async function loadAdminUser(buyerId) {
  await busy("׳˜׳•׳¢׳ ׳׳× ׳₪׳¨׳•׳₪׳™׳ ׳”׳׳©׳×׳׳© ׳”׳₪׳ ׳™׳׳™...", async () => {
    state.adminUserPayload = await api(`/api/admin/users/${encodeURIComponent(buyerId)}/profile`);
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳₪׳¨׳•׳₪׳™׳ ׳”׳׳©׳×׳׳© ׳”׳₪׳ ׳™׳׳™.");
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
  if (route.name === "recovery") {
    await refreshRecoverySilently(route.participantId);
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
        title: "׳”׳¢׳¡׳§׳” ׳¢׳•׳“׳›׳ ׳”",
        message: "׳¡׳˜׳˜׳•׳¡ ׳”׳¢׳¡׳§׳” ׳׳• ׳”׳§׳™׳‘׳•׳׳× ׳¢׳•׳“׳›׳ ׳• ׳‘׳–׳׳ ׳׳׳×."
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
        title: "׳¡׳˜׳˜׳•׳¡ ׳”׳”׳©׳×׳×׳₪׳•׳× ׳¢׳•׳“׳›׳",
        message: "׳”׳׳¡׳ ׳¨׳¢׳ ׳ ׳׳× ׳׳¦׳‘ ׳”׳¢׳¡׳§׳” ׳•׳”׳”׳©׳×׳×׳₪׳•׳× ׳‘׳׳™ ׳׳׳‘׳“ ׳׳× ׳¨׳¦׳£ ׳”׳—׳•׳•׳™׳”."
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
    const [next, missionControl, launchConsole, systemStatus, notificationsStatus, invoiceStatus, sellerRisk] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(state.form.adminQuery || "")}`),
      api(`/api/admin/mission-control?q=${encodeURIComponent(state.form.adminQuery || "")}`),
      api("/api/admin/launch-console"),
      api("/api/admin/system-status"),
      api("/api/admin/notifications-status"),
      api("/api/admin/invoice-status"),
      api("/api/admin/sellers/risk")
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
    if (totalsChanged || launchChanged || missionChanged || systemChanged || notificationsChanged || invoiceChanged || sellerRiskChanged) {
      state.adminPayload = next;
      state.adminMissionPayload = missionControl;
      state.adminLaunchPayload = launchConsole;
      state.adminSystemStatusPayload = systemStatus;
      state.adminNotificationsStatusPayload = notificationsStatus;
      state.adminInvoiceStatusPayload = invoiceStatus;
      state.adminSellerRiskPayload = sellerRisk;
      render();
    }
  } catch {}
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
  if (action === "seller-publish") return publishDeal(form.dataset.dealId);
  if (action === "seller-profile-save") return saveSellerProfile(form);
  if (action === "recovery-submit") return submitRecoveryRequest(form.dataset.participantId || state.route.participantId);
  if (action === "admin-search") return loadAdmin(state.form.adminQuery);
  if (action === "admin-kyc-decision") return decideKyc(form);
  if (action === "admin-seller-status") return changeSellerStatus(form);
  if (action === "admin-support-create") return createSupportTicket(form);
  if (action === "admin-support-update") return updateSupportTicket(form);
}

function startJoin() {
  const payload = state.dealPayload;
  if (!payload?.deal) return;
  const qty = Number(state.form.qty);
  const issue = validateQty(payload, qty);
  if (issue) return fail("׳¦׳¨׳™׳ ׳׳¢׳“׳›׳ ׳׳× ׳”׳›׳׳•׳×", issue);
  const deliveryIssue = validateDeliveryChoice(payload, state.form.deliveryOptionId);
  if (deliveryIssue) return fail("׳¦׳¨׳™׳ ׳׳¢׳“׳›׳ ׳׳× ׳׳•׳₪׳ ׳”׳§׳‘׳׳”", deliveryIssue);
  const selectedDelivery = getSelectedDeliveryOption(payload, state.form.deliveryOptionId);
  if (!selectedDelivery) return fail("׳׳ ׳ ׳‘׳—׳¨ ׳׳•׳₪׳ ׳§׳‘׳׳”", "׳™׳© ׳׳‘׳—׳•׳¨ ׳׳•׳₪׳ ׳§׳‘׳׳” ׳׳₪׳ ׳™ ׳”׳”׳׳©׳.");

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
  if (!phone) return fail("׳—׳¡׳¨ ׳׳¡׳₪׳¨ ׳˜׳׳₪׳•׳", "׳™׳© ׳׳”׳–׳™׳ ׳׳¡׳₪׳¨ ׳˜׳׳₪׳•׳ ׳ ׳™׳™׳“ ׳›׳“׳™ ׳׳”׳׳©׳™׳.");

  await busy("׳©׳•׳׳— ׳§׳•׳“ ׳׳™׳׳•׳×...", async () => {
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
      title: "׳§׳•׳“ ׳”׳׳™׳׳•׳× ׳ ׳©׳׳—",
      message: `׳©׳׳—׳ ׳• ׳§׳•׳“ ׳׳˜׳׳₪׳•׳ ${flow.otpMaskedDestination || phone}.`
    };
  }, "׳©׳׳™׳—׳× ׳§׳•׳“ ׳”׳׳™׳׳•׳× ׳ ׳›׳©׳׳”.");
}

async function otpVerify(form) {
  const route = state.route;
  if (route.name !== "otp") return;
  const flow = getFlow(route.dealId);
  if (!flow?.otpSessionId) {
    return fail("׳׳™׳ ׳¡׳©׳ ׳׳™׳׳•׳× ׳₪׳¢׳™׳", "׳¦׳¨׳™׳ ׳׳‘׳§׳© ׳§׳•׳“ ׳—׳“׳© ׳׳₪׳ ׳™ ׳׳™׳׳•׳×.");
  }

  const code = String(new FormData(form).get("code") || "").trim();
  if (!code) return fail("׳—׳¡׳¨ ׳§׳•׳“ ׳׳™׳׳•׳×", "׳™׳© ׳׳”׳–׳™׳ ׳׳× ׳§׳•׳“ ׳”׳׳™׳׳•׳× ׳©׳ ׳©׳׳— ׳׳׳™׳.");

  await busy("׳׳׳׳× ׳׳× ׳”׳§׳•׳“...", async () => {
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
      title: "׳”׳׳™׳׳•׳× ׳”׳¦׳׳™׳—",
      message: "׳׳₪׳©׳¨ ׳׳”׳׳©׳™׳ ׳¢׳›׳©׳™׳• ׳׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×."
    };
    navigate(`/app/join/${encodeURIComponent(route.dealId)}/payment`);
  }, "׳׳™׳׳•׳× ׳”׳§׳•׳“ ׳ ׳›׳©׳.");
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
    title: "׳©׳׳‘ ׳׳™׳׳•׳× ׳”׳˜׳׳₪׳•׳ ׳׳•׳₪׳¡",
    message: "׳׳₪׳©׳¨ ׳׳‘׳§׳© ׳¢׳›׳©׳™׳• ׳§׳•׳“ ׳—׳“׳© ׳•׳׳”׳׳©׳™׳."
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
      title: "׳—׳¡׳¨ ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳ ׳×׳§׳£",
      message: "׳¦׳¨׳™׳ ׳׳”׳©׳׳™׳ ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳ ׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×."
    };
    render();
    return;
  }

  const formData = new FormData(form);
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
  if (issue) return fail("׳₪׳¨׳˜׳™ ׳”׳׳©׳¨׳׳™ ׳׳ ׳׳׳׳™׳", issue);

  await busy("׳׳׳©׳¨ ׳׳× ׳”׳׳¡׳’׳¨׳× ׳•׳©׳•׳׳¨ ׳׳× ׳”׳”׳¦׳˜׳¨׳₪׳•׳×...", async () => {
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
      buyerTermsAccepted: true,
      paymentDisclosureAccepted: true
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
      title: "׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳”",
      message: "׳×׳₪׳™׳¡׳× ׳”׳׳¡׳’׳¨׳× ׳‘׳•׳¦׳¢׳” ׳•׳ ׳©׳׳¨׳” ׳”׳©׳×׳×׳₪׳•׳× ׳₪׳¢׳™׳׳” ׳׳¢׳¡׳§׳”."
    };
    navigate(`/app/join/${encodeURIComponent(route.dealId)}/confirmation`);
  }, "׳×׳₪׳™׳¡׳× ׳”׳׳¡׳’׳¨׳× ׳׳• ׳©׳׳™׳¨׳× ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳›׳©׳׳•.");
}

async function createDeal(form) {
  const formData = new FormData(form);
  const title = String(formData.get("sellerTitle") || "").trim();
  const deadline = String(formData.get("sellerDeadline") || "").trim();
  const finalTerms = formData.get("sellerFinalTerms") === "on";
  const finalConfirm = formData.get("sellerFinalConfirm") === "on";
  if (!title) return fail("׳—׳¡׳¨׳” ׳›׳•׳×׳¨׳× ׳׳¢׳¡׳§׳”", "׳™׳© ׳׳”׳–׳™׳ ׳›׳•׳×׳¨׳× ׳׳₪׳ ׳™ ׳™׳¦׳™׳¨׳× ׳”׳˜׳™׳•׳˜׳”.");
  if (!deadline) return fail("׳—׳¡׳¨ ׳׳•׳¢׳“ ׳¡׳’׳™׳¨׳”", "׳™׳© ׳׳‘׳—׳•׳¨ ׳׳•׳¢׳“ ׳¡׳’׳™׳¨׳” ׳׳₪׳ ׳™ ׳™׳¦׳™׳¨׳× ׳”׳˜׳™׳•׳˜׳”.");
  if (!finalTerms || !finalConfirm) {
    return fail("חסר אישור סופי", "לפני יצירת הטיוטה צריך לאשר שהשדות הקריטיים סופיים ושאחרי פרסום אין עריכה שקטה שלהם.");
  }
  const deliveryOptions = collectSellerDeliveryOptions(formData);
  if (!deliveryOptions.length) {
    return fail("׳—׳¡׳¨׳” ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳”", "׳™׳© ׳׳”׳•׳¡׳™׳£ ׳׳₪׳—׳•׳× ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳” ׳׳—׳× ׳׳₪׳ ׳™ ׳™׳¦׳™׳¨׳× ׳”׳¢׳¡׳§׳”.");
  }

  await busy("׳™׳•׳¦׳¨ ׳˜׳™׳•׳˜׳× ׳¢׳¡׳§׳”...", async () => {
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
        seller_id: sellerContext.seller_id,
        seller_display_name: sellerContext.display_name,
        delivery_options: deliveryOptions
      })
    });
    let imageUploadWarning = "";
    if (state.form.sellerImageDataUrl) {
      try {
        await uploadSellerDealImage(response.deal_id, {
          dataUrl: state.form.sellerImageDataUrl,
          filename: state.form.sellerImageName
        });
      } catch {
        imageUploadWarning = "העסקה נשמרה, אבל העלאת התמונה לא הושלמה. אפשר להמשיך לפרסום עם תצוגת ברירת המחדל.";
      }
    }
    state.banner = {
      tone: imageUploadWarning ? "warning" : "success",
      title: imageUploadWarning ? "הטיוטה נשמרה ללא תמונה" : "׳”׳˜׳™׳•׳˜׳” ׳ ׳©׳׳¨׳”",
      message: imageUploadWarning || "׳˜׳™׳•׳˜׳× ׳”׳¢׳¡׳§׳” ׳ ׳©׳׳¨׳”. ׳¢׳›׳©׳™׳• ׳׳₪׳©׳¨ ׳׳¢׳‘׳•׳¨ ׳¢׳׳™׳”, ׳׳₪׳¨׳¡׳ ׳׳× ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™, ׳•׳׳– ׳׳”׳₪׳™׳¥ ׳׳× ׳”׳׳™׳ ׳§ ׳”׳™׳©׳™׳¨."
    };
    navigate(`/app/seller/deals/${encodeURIComponent(response.deal_id)}`);
  }, "׳™׳¦׳™׳¨׳× ׳”׳¢׳¡׳§׳” ׳ ׳›׳©׳׳”.");
}

async function uploadSellerDealImage(dealId, image) {
  if (!dealId || !image?.dataUrl) return null;
  return api(`/api/seller/deals/${encodeURIComponent(dealId)}/images`, {
    method: "POST",
    body: json({
      image_data_url: image.dataUrl,
      original_filename: image.filename || ""
    })
  });
}

async function publishDeal(dealId) {
  if (!dealId) return;
  await busy("׳׳₪׳¨׳¡׳ ׳׳× ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™...", async () => {
    await api(`/deals/${encodeURIComponent(dealId)}/publish`, {
      method: "POST",
      headers: {
        "x-request-id": `seller-publish:${Date.now()}`,
        "idempotency-key": `seller-publish:${dealId}`
      },
      body: json({
        seller_terms_accepted: true
      })
    });
    state.banner = {
      tone: "success",
      title: "׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳₪׳•׳¨׳¡׳",
      message: "׳“׳£ ׳”׳¢׳¡׳§׳” ׳”׳¦׳™׳‘׳•׳¨׳™ ׳›׳‘׳¨ ׳—׳™ ׳•׳׳•׳›׳ ׳׳”׳₪׳¦׳” ׳™׳©׳™׳¨׳” ׳׳§׳•׳ ׳™׳."
    };
    await loadSellerDeal(dealId);
  }, "׳₪׳¨׳¡׳•׳ ׳”׳¢׳¡׳§׳” ׳ ׳›׳©׳.");
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
    return fail("׳—׳¡׳¨ ׳׳–׳”׳” ׳׳•׳›׳¨", "׳™׳© ׳׳‘׳—׳•׳¨ ׳׳–׳”׳” ׳׳•׳›׳¨ ׳₪׳¢׳™׳ ׳׳₪׳ ׳™ ׳›׳ ׳™׳¡׳” ׳׳׳–׳•׳¨ ׳”׳׳•׳›׳¨.");
  }

  await busy("׳©׳•׳׳¨ ׳׳× ׳–׳”׳•׳× ׳”׳׳•׳›׳¨ ׳”׳₪׳¢׳™׳׳”...", async () => {
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
      title: "׳–׳”׳•׳× ׳”׳׳•׳›׳¨ ׳ ׳©׳׳¨׳”",
      message: `׳”׳¢׳‘׳•׳“׳” ׳‘׳׳–׳•׳¨ ׳”׳׳•׳›׳¨ ׳×׳×׳‘׳¦׳¢ ׳¢׳›׳©׳™׳• ׳×׳—׳× ${sellerContext.display_name}.`
    };
    if (["home", "seller", "seller-new"].includes(state.route.name)) {
      await runRoute();
    } else {
      render();
    }
  }, "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳©׳׳•׳¨ ׳׳× ׳–׳”׳•׳× ׳”׳׳•׳›׳¨ ׳”׳₪׳¢׳™׳׳”.");
}

async function loginSellerFromForm(form) {
  const formData = new FormData(form);
  const sellerId = String(formData.get("sellerContextId") || "").trim();
  const accessCode = String(formData.get("sellerAccessCode") || "").trim();
  if (!sellerId || !accessCode) {
    return fail("חסרים פרטי כניסה", "יש להזין מזהה מוכר וקוד גישה כדי להיכנס לאזור המוכר.");
  }

  await busy("פותח את אזור המוכר...", async () => {
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
      title: "אזור המוכר נפתח",
      message: `העבודה באזור המוכר מתבצעת עכשיו תחת ${state.sellerAuth?.seller_context?.display_name || sellerId}.`
    };
    await runRoute();
  }, "הכניסה לאזור המוכר נכשלה.");
}

async function logoutSeller() {
  await busy("סוגר את אזור המוכר...", async () => {
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
      message: "אזור המוכר חזר למצב נעול עד לכניסה מחודשת."
    };
    await runRoute();
  }, "היציאה מאזור המוכר נכשלה.");
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
  const file = input.files?.[0];
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    input.value = "";
    return fail("סוג תמונה לא נתמך", "אפשר להעלות תמונת JPG, PNG או WebP בלבד.");
  }
  if (file.size > 2 * 1024 * 1024) {
    input.value = "";
    return fail("התמונה גדולה מדי", "בשלב הזה תמונת תצוגה מקומית מוגבלת ל-2MB כדי לא להכביד על הדפדפן.");
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.form.sellerImageDataUrl = String(reader.result || "");
    state.form.sellerImageName = file.name;
    state.banner = {
      tone: "success",
      title: "התמונה נוספה לתצוגה מקדימה",
      message: "התמונה מוצגת עכשיו במסך היצירה ותופיע בתצוגת העסקה לפני הפרסום."
    };
    render();
  };
  reader.onerror = () => fail("טעינת התמונה נכשלה", "לא הצלחנו לקרוא את הקובץ שנבחר.");
  reader.readAsDataURL(file);
}

function clearSellerProductImage() {
  state.form.sellerImageDataUrl = "";
  state.form.sellerImageName = "";
  state.banner = {
    tone: "warning",
    title: "התמונה הוסרה מהתצוגה",
    message: "דף העסקה יחזור לתצוגת ברירת המחדל עד שתבחר תמונת מוצר חדשה."
  };
  render();
}

async function shareLink(url, title) {
  const shareUrl = absoluteUrl(url || location.pathname);
  const shareTitle = title || "עסקה בסיטון";
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
    holderName: "",
    cardNumber: "",
    expiry: "",
    cvv: "",
    sellerTitle: state.form.sellerTitle,
    sellerDescription: state.form.sellerDescription,
    sellerImageDataUrl: state.form.sellerImageDataUrl,
    sellerImageName: state.form.sellerImageName,
    sellerContextId: state.form.sellerContextId,
    sellerContextName: state.form.sellerContextName,
    sellerPrice: state.form.sellerPrice,
    sellerMinUnits: state.form.sellerMinUnits,
    sellerMaxUnits: state.form.sellerMaxUnits,
    sellerDeadline: state.form.sellerDeadline,
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
  syncDocumentFrame();
  const routeLabel = getRouteLabel();
  const routeSummary = getRouteSummary();
  root.innerHTML = `
    <div class="shell app-shell">
      <header class="app-shell-header">
        <section class="shell-surface shell-header-bar" aria-label="כותרת האפליקציה">
          <div class="shell-brand">
            <strong>סיטון</strong>
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
      ${renderPublicTrustFooter()}
    </div>
  `;
}

function syncDocumentFrame() {
  document.documentElement.setAttribute("lang", "he");
  document.documentElement.setAttribute("dir", "rtl");
  document.body.setAttribute("dir", "rtl");
  document.title = `סיטון | ${getRouteLabel()}`;
}

function getRouteLabel() {
  return ROUTE_LABELS[state.route.name] || "מסלול קונה";
}

function getRouteSummary() {
  const summaries = {
    home: "שער העבודה הראשי למוכר, לקונה דרך לינק ישיר, ולמשטחי התפעול.",
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
    "admin-deal": "פרופיל עסקה לתפעול, בקרה ותמיכה.",
    "admin-participant": "פרופיל משתתף לתפעול, תמיכה ואבחון חוצה מערכות.",
    "admin-user": "פרופיל משתמש לתפעול, תמיכה וחקירה.",
    terms: "תנאי השימוש של סיטון.",
    privacy: "מדיניות הפרטיות של סיטון.",
    refunds: "מדיניות ביטולים והחזרים של סיטון.",
    contact: "פרטי יצירת קשר ושכבת אמון ציבורית."
  };
  return summaries[state.route.name] || "ממשק סיטון מיושר ל-RTL, מובייל ונגישות כברירת מחדל.";
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
  if (route.name === "home") return renderHome();
  if (route.name === "deal") return renderDealPage();
  if (route.name === "otp") return renderOtpPage(route.dealId);
  if (route.name === "payment") return renderPaymentPage(route.dealId);
  if (route.name === "confirmation") return renderConfirmationPage(route.dealId);
  if (route.name === "tracking") return renderTrackingPage();
  if (route.name === "recovery") return renderRecoveryPage();
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
  if (route.name === "admin-participant") return renderAdminParticipantPage();
  if (route.name === "admin-user") return renderAdminUserPage();
  return renderEmptyState("׳”׳¢׳׳•׳“ ׳׳ ׳ ׳׳¦׳", "׳”׳§׳™׳©׳•׳¨ ׳”׳–׳” ׳׳ ׳§׳™׳™׳ ׳׳• ׳©׳›׳‘׳¨ ׳׳™׳ ׳• ׳–׳׳™׳.");
}

function renderHomeLegacy() {
  const payload = state.homePayload?.site;
  const preview = state.previewMeta?.preview;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">׳”׳׳×׳¨ ׳”׳¨׳׳©׳™ ׳©׳ ׳¡׳™׳˜׳•׳</span>
        <h1>׳₪׳•׳×׳—׳™׳ ׳¢׳¡׳§׳”, ׳׳¢׳׳™׳ ׳“׳£ ׳׳™׳©׳™, ׳•׳׳₪׳™׳¦׳™׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳§׳•׳ ׳™׳</h1>
        <p class="muted">
          ׳¡׳™׳˜׳•׳ ׳”׳™׳ ׳₪׳׳˜׳₪׳•׳¨׳׳” ׳׳¢׳¡׳§׳׳•׳× ׳§׳‘׳•׳¦׳×׳™׳•׳× ׳׳‘׳•׳¡׳¡׳•׳× ׳׳™׳ ׳§. ׳”׳׳×׳¨ ׳”׳¨׳׳©׳™ ׳”׳•׳ ׳©׳¢׳¨ ׳”׳¢׳‘׳•׳“׳” ׳׳׳•׳›׳¨: ׳׳›׳׳ ׳₪׳•׳×׳—׳™׳ ׳¢׳¡׳§׳”, ׳׳₪׳¨׳¡׳׳™׳ ׳“׳£ ׳¦׳™׳‘׳•׳¨׳™ ׳׳™׳©׳™, ׳•׳׳₪׳™׳¦׳™׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳©׳“׳¨׳›׳• ׳”׳§׳•׳ ׳™׳ ׳׳¦׳˜׳¨׳₪׳™׳.
        </p>
        <div class="actions">
          <a class="button primary" href="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}" data-nav="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}">׳₪׳×׳™׳—׳× ׳¢׳¡׳§׳” ׳—׳“׳©׳”</a>
          <a class="button secondary" href="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}" data-nav="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}">׳ ׳™׳”׳•׳ ׳”׳¢׳¡׳§׳׳•׳× ׳©׳׳™</a>
        </div>
        <div class="summary-item">
          <span class="muted">׳ ׳§׳•׳“׳× ׳”׳›׳ ׳™׳¡׳” ׳©׳ ׳”׳§׳•׳ ׳”</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
          <p class="small muted">${esc(payload?.buyer_entry_note || "הקונה נכנס ישירות לדף העסקה דרך לינק אישי שנשלח אליו.")}</p>
        </div>
        <div class="summary-item">
          <span class="muted">׳”׳›׳™׳•׳•׳ ׳”׳׳•׳¦׳¨׳™ ׳”׳₪׳¢׳™׳</span>
          <strong>${esc(payload?.product_direction || "׳¢׳¡׳§׳׳•׳× ׳§׳‘׳•׳¦׳×׳™׳•׳× ׳׳‘׳•׳¡׳¡׳•׳× ׳׳™׳ ׳§")}</strong>
          <p class="small muted">${esc(payload?.positioning || "׳׳×׳¨ ׳׳•׳×׳’׳™ ׳—׳–׳§ ׳׳׳•׳›׳¨׳™׳, ׳¢׳ ׳“׳£ ׳¢׳¡׳§׳” ׳¦׳™׳‘׳•׳¨׳™ ׳•׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳§׳•׳ ׳”.")}</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight">
          <span class="muted">׳×׳׳•׳ ׳× ׳׳¦׳‘ ׳¢׳“׳›׳ ׳™׳×</span>
          <strong>${buyerState[0]}</strong>
          <p class="small muted">${moneyState[0]} ֲ· ${dealState.label}</p>
        </div>
        <div class="summary-item"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳ ׳₪׳×׳—׳•</span><strong>${num(payload?.proof_points?.total_deals || 0)}</strong></div>
        <div class="summary-item"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳—׳™׳•׳× ׳¢׳›׳©׳™׳•</span><strong>${num(payload?.proof_points?.live_deals || 0)}</strong></div>
        <div class="summary-item"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳”׳•׳©׳׳׳•</span><strong>${num(payload?.proof_points?.completed_deals || 0)}</strong></div>
        ${preview?.is_demo_preview ? `<div class="summary-item"><span class="muted">׳׳¦׳‘ ׳”׳¡׳‘׳™׳‘׳”</span><strong>${esc(formatEnvironmentLabel(preview?.deployment_mode || "preview"))}</strong></div>` : `<div class="summary-item"><span class="muted">׳׳•׳₪׳™ ׳”׳׳•׳¦׳¨</span><strong>׳׳¡׳׳•׳ ׳§׳ ׳™׳™׳” ׳‘׳׳™׳ ׳§ ׳™׳©׳™׳¨</strong></div>`}
        <div class="summary-item"><span class="muted">׳”׳‘׳˜׳—׳× ׳”׳׳¡׳׳•׳</span><strong>׳”׳׳•׳›׳¨ ׳₪׳•׳×׳—, ׳”׳§׳•׳ ׳” ׳׳¦׳˜׳¨׳£ ׳“׳¨׳ ׳׳™׳ ׳§</strong></div>
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
        <span class="eyebrow">׳׳¡׳׳•׳ ׳”׳§׳•׳ ׳” ׳©׳ ׳¡׳™׳˜׳•׳</span>
        <h1>׳—׳•׳•׳™׳™׳× ׳§׳•׳ ׳” ׳׳—׳•׳‘׳¨׳× ׳׳‘׳§׳׳ ׳“ ׳”׳—׳™</h1>
        <p class="muted">
          ׳”׳›׳ ׳™׳¡׳” ׳׳׳¡׳׳•׳ ׳”׳׳׳™׳×׳™ ׳”׳™׳ ׳“׳¨׳ ׳§׳™׳©׳•׳¨ ׳¢׳¡׳§׳”. ׳׳©׳ ׳׳׳©׳™׳›׳™׳ ׳׳׳™׳׳•׳× ׳˜׳׳₪׳•׳, ׳׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×, ׳׳׳™׳©׳•׳¨ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳•׳׳׳¢׳§׳‘.
        </p>
        <div class="summary-item">
          <span class="muted">׳₪׳•׳¨׳׳˜ ׳§׳™׳©׳•׳¨ ׳”׳¢׳¡׳§׳”</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item">
          <span class="muted">׳׳” ׳–׳׳™׳ ׳›׳¨׳’׳¢</span>
          <strong>׳“׳£ ׳¢׳¡׳§׳”, ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳, ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×, ׳׳™׳©׳•׳¨ ׳•׳׳¢׳§׳‘</strong>
        </div>
        <div class="summary-item">
          <span class="muted">׳׳׳™ ׳”׳׳¡׳׳•׳ ׳׳™׳•׳¢׳“</span>
          <strong>׳׳§׳•׳ ׳” ׳©׳׳§׳‘׳ ׳§׳™׳©׳•׳¨ ׳™׳©׳™׳¨ ׳׳¢׳¡׳§׳”</strong>
        </div>
      </aside>
    </section>
  `;
}

function renderDealPage() {
  if (!state.dealPayload && state.loading) return "";
  if (!state.dealPayload) return renderEmptyState("׳׳™ ׳׳₪׳©׳¨ ׳׳”׳¦׳™׳’ ׳׳× ׳”׳¢׳¡׳§׳”", "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳׳× ׳₪׳¨׳˜׳™ ׳”׳¢׳¡׳§׳” ׳©׳‘׳™׳§׳©׳×.");

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
  const availabilityBanner = renderDealAvailabilityBanner(availability, metrics, nextAction);

  return `
    <section class="hero product-hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">׳¢׳¡׳§׳” ׳¦׳™׳‘׳•׳¨׳™׳×</span>
        <span class="badge ${dealCopy.badgeTone}">${dealCopy.label}</span>
        <div class="deal-hero-layout">
          ${renderDealVisual(deal.title, deliveryOptions, selectedDelivery, getPrimaryDealImage(deal))}
          <div class="stack deal-hero-copy">
            <h1>${esc(deal.title)}</h1>
            <p class="muted">${availability.message || dealCopy.description}</p>
            ${availabilityBanner}
            <div class="summary-grid deal-story-grid">
              <div class="summary-item summary-spotlight">
                <span class="muted">׳׳” ׳׳§׳‘׳׳™׳ ׳‘׳¢׳¡׳§׳”</span>
                <strong>${currency(deal.price_per_unit)} ׳׳™׳—׳™׳“׳”</strong>
                <p class="small muted">׳“׳£ ׳”׳¢׳¡׳§׳” ׳׳¨׳›׳– ׳׳× ׳”׳₪׳¨׳˜׳™׳, ׳”׳§׳¦׳‘ ׳•׳׳•׳₪׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳‘׳׳™ ׳¢׳•׳׳¡ ׳˜׳›׳ ׳™.</p>
              </div>
              <div class="summary-item">
                <span class="muted">׳׳•׳₪׳ ׳™ ׳§׳‘׳׳”</span>
                <strong>${num(deliveryOptions.length)}</strong>
                <p class="small muted">${selectedDelivery ? esc(selectedDelivery.label) : "׳ ׳™׳×׳ ׳׳‘׳—׳•׳¨ ׳׳•׳₪׳ ׳§׳‘׳׳” ׳‘׳©׳׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×."}</p>
              </div>
            </div>
          </div>
        </div>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">׳›׳ ׳™׳¡׳” ׳׳¢׳¡׳§׳”</span><strong>׳¨׳§ ׳“׳¨׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨</strong></div>
          <div class="trust-point"><span class="muted">׳‘׳©׳׳‘ ׳”׳–׳”</span><strong>׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“</strong></div>
          <div class="trust-point"><span class="muted">׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳</span><strong>׳¨׳§ ׳׳ ׳”׳¢׳¡׳§׳” ׳×׳•׳©׳׳</strong></div>
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
          <div class="metric"><span class="muted">׳׳—׳™׳¨ ׳׳™׳—׳™׳“׳”</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="metric"><span class="muted">׳›׳׳•׳× ׳©׳›׳‘׳¨ ׳ ׳¨׳©׳׳”</span><strong>${num(metrics.joined_units)} ׳™׳—'</strong></div>
          <div class="metric"><span class="muted">׳§׳™׳‘׳•׳׳× ׳©׳ ׳•׳×׳¨׳”</span><strong>${num(metrics.remaining_units)} ׳™׳—'</strong></div>
        </div>
        <div class="meter"><span style="width:${Math.max(4, metrics.progress_to_capacity_pct)}%"></span></div>
        <div class="progress-caption"><strong>${num(metrics.progress_to_capacity_pct)}%</strong><span class="muted">׳׳¢׳¡׳§׳” ׳ ׳¢׳ה ׳›׳¨׳’׳¢ ׳‘׳§׳¦׳‘ ׳”׳ ׳•׳›׳—׳™ ׳׳×׳•׳ ׳§׳™׳‘׳•׳׳× ׳›׳•׳׳׳×</span></div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">׳™׳¢׳“ ׳‘׳¡׳™׳¡ ׳׳¢׳¡׳§׳”</span><strong>${num(deal.threshold_units)} ׳™׳—'</strong></div>
          <div class="summary-item"><span class="muted">׳׳§׳¡׳™׳׳•׳ ׳‘׳¢׳¡׳§׳”</span><strong>${num(deal.max_units)} ׳™׳—'</strong></div>
          <div class="summary-item"><span class="muted">׳¡׳’׳™׳¨׳× ׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×</span><strong>${dt(deal.deadline)}</strong></div>
          <div class="summary-item"><span class="muted">׳׳¡׳₪׳¨ ׳׳©׳×׳×׳₪׳™׳</span><strong>${num(metrics.participants_count)}</strong></div>
        </div>
        ${affiliateRef ? `<div class="info-strip tone-info"><strong>׳™׳™׳—׳•׳¡ ׳©׳•׳×׳£ ׳ ׳©׳׳¨ ׳‘׳׳¡׳׳•׳</strong><p class="small">׳§׳•׳“ ׳”׳”׳₪׳ ׳™׳” <span class="mono">${esc(affiliateRef)}</span> ׳™׳™׳©׳׳¨ ׳׳—׳•׳‘׳¨ ׳׳”׳¦׳˜׳¨׳₪׳•׳× ׳”׳–׳׳× ׳•׳™׳•׳₪׳™׳¢ ׳‘׳׳¡׳›׳™׳ ׳”׳₪׳ ׳™׳׳™׳™׳ ׳”׳¨׳׳•׳•׳ ׳˜׳™׳™׳.</p></div>` : ""}
        ${flow ? renderExistingFlow(flow, deal.deal_id) : ""}
        ${renderLegalReferenceStrip("deal")}
      </article>
      <aside class="card hero-side stack">
        <h2>${dealCopy.title}</h2>
        <p class="muted">${nextAction.description}</p>
        <div class="summary-grid">
          <div class="summary-item">
            <span class="muted">׳׳¦׳‘ ׳”׳¢׳¡׳§׳”</span>
            <strong>${dealCopy.label}</strong>
            <p class="small muted">${availability.message || dealCopy.description}</p>
          </div>
          <div class="summary-item">
            <span class="muted">׳”׳©׳׳‘ ׳”׳‘׳</span>
            <strong>${nextAction.cta}</strong>
            <p class="small muted">${nextAction.description}</p>
          </div>
        </div>
        <div class="cta-panel">
          <strong>׳”׳¦׳˜׳¨׳₪׳•׳× ׳׳”׳™׳¨׳” ׳•׳‘׳¨׳•׳¨׳”</strong>
          <p class="small muted">׳‘׳—׳¨ ׳›׳׳•׳× ׳•׳׳•׳₪׳ ׳§׳‘׳׳”, ׳”׳׳©׳ ׳׳׳™׳׳•׳× ׳˜׳׳₪׳•׳, ׳•׳׳– ׳׳©׳¨ ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“.</p>
        </div>
        <form data-action="start-join" class="stack">
          <div class="field">
            <label for="qty">׳›׳׳” ׳™׳—׳™׳“׳•׳× ׳×׳¨׳¦׳” ׳׳”׳¦׳˜׳¨׳£?</label>
            <input id="qty" name="qty" type="number" min="1" max="${Math.max(1, metrics.remaining_units)}" step="1" value="${qty}" />
          </div>
          <div class="field">
            <label for="deliveryOptionId">׳׳•׳₪׳ ׳§׳‘׳׳”</label>
            ${deliveryOptions.length > 1 ? `
              <select id="deliveryOptionId" name="deliveryOptionId">
                <option value="">׳‘׳—׳¨ ׳׳•׳₪׳ ׳§׳‘׳׳”</option>
                ${deliveryOptions.map((option) => `<option value="${esc(option.option_id)}" ${selectedDelivery?.option_id === option.option_id ? "selected" : ""}>${esc(option.label)} ֲ· ${currency(option.cost || 0)}</option>`).join("")}
              </select>
            ` : selectedDelivery ? `
              <div class="info-strip">
                <strong>${esc(selectedDelivery.label)}</strong>
                <p class="small muted">${currency(selectedDelivery.cost || 0)} ֲ· ${esc(formatDeliveryTypeLabel(selectedDelivery.option_type))}</p>
              </div>
              <input type="hidden" name="deliveryOptionId" value="${esc(selectedDelivery.option_id)}" />
            ` : `
              <div class="error-card compact">׳׳ ׳”׳•׳’׳“׳¨׳” ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳” ׳׳¢׳¡׳§׳” ׳”׳–׳׳×.</div>
            `}
          </div>
          ${qtyIssue ? `<div class="error-card compact">${esc(qtyIssue)}</div>` : ""}
          ${deliveryIssue ? `<div class="error-card compact">${esc(deliveryIssue)}</div>` : ""}
          ${selectedDelivery ? `
            <div class="summary-item">
              <span class="muted">׳׳•׳₪׳ ׳§׳‘׳׳” ׳©׳ ׳‘׳—׳¨</span>
              <strong>${esc(selectedDelivery.label)}</strong>
              <p class="small muted">${esc(formatDeliveryTypeLabel(selectedDelivery.option_type))} ֲ· ${currency(selectedDelivery.cost || 0)}</p>
            </div>
          ` : ""}
          <div class="summary-item summary-spotlight">
            <span class="muted">׳¢׳׳•׳× ׳׳©׳•׳¢׳¨׳×</span>
            <strong>${currency(holdTotal)}</strong>
            <p class="small muted">${REQUIRED_PAYMENT_NOTICE}</p>
          </div>
          ${selectedDelivery ? `
            <div class="summary-item">
              <span class="muted">׳₪׳™׳¨׳•׳˜ ׳×׳₪׳™׳¡׳× ׳”׳׳¡׳’׳¨׳×</span>
              <strong>${currency(holdTotal)}</strong>
              <p class="small muted">${num(Math.max(0, qty))} ׳™׳—' x ${currency(deal.price_per_unit)} + ${currency(selectedDelivery.cost || 0)} ${esc(selectedDelivery.label)}</p>
            </div>
          ` : ""}
            <div class="info-strip tone-warning trust-box">
              <strong>׳׳” ׳ ׳©׳׳¨ ׳¢׳›׳©׳™׳•</strong>
              <p class="small">${REQUIRED_PAYMENT_NOTICE}</p>
            </div>
            <div class="mini-legal-note">
              <span class="muted">׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳–׳׳™׳ ׳×׳׳™׳“:</span>
              ${renderLegalLinkRow()}
            </div>
            <button class="primary" type="submit" ${availability.canJoin ? "" : "disabled"}>${nextAction.cta}</button>
          </form>
      </aside>
    </section>
    ${renderDealChatSection(deal)}
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
    ? `/app/track/${encodeURIComponent(flow.participantId)}`
    : flow.otpVerified
      ? `/app/join/${encodeURIComponent(dealId)}/payment`
      : `/app/join/${encodeURIComponent(dealId)}/otp`;
  const continueLabel = flow.participantId
    ? "׳׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳©׳׳™"
    : flow.otpVerified
      ? "׳׳”׳׳©׳ ׳׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×"
      : "׳׳”׳׳©׳ ׳׳׳™׳׳•׳× ׳˜׳׳₪׳•׳";

  return `
    <div class="info-strip">
      <strong>׳™׳© ׳׳ ׳›׳‘׳¨ ׳׳¡׳׳•׳ ׳₪׳×׳•׳— ׳׳¢׳¡׳§׳” ׳”׳–׳•</strong>
      <p class="small">׳”׳›׳׳•׳× ׳©׳ ׳©׳׳¨׳”: ${num(flow.qty || 0)} ׳™׳—'. ׳׳₪׳©׳¨ ׳׳”׳׳©׳™׳ ׳׳׳™׳₪׳” ׳©׳¢׳¦׳¨׳× ׳׳• ׳׳”׳×׳—׳™׳ ׳׳—׳“׳©.</p>
      <div class="actions">
        <a class="button secondary" href="${continueHref}" data-nav="${continueHref}">${continueLabel}</a>
        <button class="secondary" type="button" data-inline-action="restart-flow">׳”׳×׳—׳ ׳׳—׳“׳©</button>
      </div>
    </div>
  `;
}

function renderOtpPage(dealId) {
  const flow = getFlow(dealId);
  if (!flow) {
    return renderRecoveryState(
      "׳׳™׳ ׳׳¡׳׳•׳ ׳₪׳×׳•׳— ׳׳¢׳¡׳§׳” ׳”׳–׳•",
      "׳›׳“׳™ ׳׳”׳׳©׳™׳ ׳׳׳™׳׳•׳× ׳˜׳׳₪׳•׳ ׳¦׳¨׳™׳ ׳׳”׳×׳—׳™׳ ׳׳”׳¢׳¡׳§׳” ׳•׳׳‘׳—׳•׳¨ ׳›׳׳•׳× ׳׳”׳¦׳˜׳¨׳₪׳•׳×.",
      `/app/deal/${encodeURIComponent(dealId)}`
    );
  }

  const expired = flow.otpExpiresAt && Date.now() > new Date(flow.otpExpiresAt).getTime();
  const flowState = getFlowStatus(flow);

  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">׳©׳׳‘ 1 ׳׳×׳•׳ 3</span>
        <h1>׳׳™׳׳•׳× ׳˜׳׳₪׳•׳ ׳׳₪׳ ׳™ ׳”׳¦׳˜׳¨׳₪׳•׳×</h1>
        <p class="muted">׳׳ ׳—׳ ׳• ׳׳׳׳×׳™׳ ׳׳× ׳”׳˜׳׳₪׳•׳ ׳›׳“׳™ ׳׳©׳™׳™׳ ׳׳× ׳”׳”׳©׳×׳×׳₪׳•׳× ׳׳§׳•׳ ׳” ׳”׳ ׳›׳•׳ ׳׳₪׳ ׳™ ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳×.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">׳¢׳¡׳§׳”</span><strong>${esc(state.dealPayload?.deal?.title || flow.dealTitle || "׳¢׳¡׳§׳”")}</strong></div>
          <div class="summary-item"><span class="muted">׳›׳׳•׳× ׳©׳ ׳©׳׳¨׳”</span><strong>${num(flow.qty || 0)} ׳™׳—'</strong></div>
        </div>
        <div class="status-rail">
          ${renderStep("׳›׳׳•׳× ׳ ׳©׳׳¨׳”", true)}
          ${renderStep("׳׳™׳׳•׳× ׳˜׳׳₪׳•׳", Boolean(flow.otpSessionId), flow.otpVerified)}
          ${renderStep("׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳•׳”׳¦׳˜׳¨׳₪׳•׳×", Boolean(flow.otpVerified))}
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item">
          <span class="muted">׳׳¦׳‘ ׳”׳׳¡׳׳•׳</span>
          <strong>${flowState.title}</strong>
          <p class="small muted">${flowState.message}</p>
        </div>
        <div class="summary-item">
          <span class="muted">׳¢׳“׳›׳•׳ ׳׳—׳¨׳•׳ ׳׳׳¡׳׳•׳</span>
          <strong>${relativeTime(flow.updatedAt)}</strong>
          <p class="small muted">׳׳ ׳׳©׳”׳• ׳׳¨׳’׳™׳© ׳׳ ׳¢׳“׳›׳ ׳™, ׳׳₪׳©׳¨ ׳׳׳₪׳¡ ׳׳× ׳©׳׳‘ ׳׳™׳׳•׳× ׳”׳˜׳׳₪׳•׳ ׳•׳׳”׳׳©׳™׳ ׳׳—׳“׳©.</p>
        </div>
        <form data-action="otp-start" class="stack">
          <div class="field">
            <label for="phone">׳׳¡׳₪׳¨ ׳˜׳׳₪׳•׳ ׳ ׳™׳™׳“</label>
            <input id="phone" name="phone" type="tel" data-dir="ltr" value="${esc(flow.phone || state.form.phone || "")}" placeholder="0501234567" />
          </div>
          <button class="primary" type="submit">${flow.otpSessionId ? "׳©׳׳— ׳§׳•׳“ ׳—׳“׳©" : "׳©׳׳— ׳§׳•׳“ ׳׳™׳׳•׳×"}</button>
        </form>
        ${flow.otpSessionId ? `
          <div class="info-strip ${expired ? "tone-warning" : ""}">
            <strong>${expired ? "׳×׳•׳§׳£ ׳”׳§׳•׳“ ׳₪׳’" : `׳©׳׳—׳ ׳• ׳§׳•׳“ ׳-${esc(flow.otpMaskedDestination || flow.phone || "")}`}</strong>
            <p class="small">${expired ? "׳׳₪׳©׳¨ ׳׳‘׳§׳© ׳§׳•׳“ ׳—׳“׳© ׳•׳׳”׳׳©׳™׳." : `׳”׳§׳•׳“ ׳‘׳×׳•׳§׳£ ׳¢׳“ ${dt(flow.otpExpiresAt)}.`}</p>
          </div>
          <form data-action="otp-verify" class="stack">
            <div class="field">
              <label for="code">׳§׳•׳“ ׳׳™׳׳•׳×</label>
              <input id="code" name="code" type="text" data-dir="ltr" inputmode="numeric" value="${esc(state.form.code || "")}" placeholder="123456" />
            </div>
            <div class="actions">
              <button class="primary" type="submit" ${expired ? "disabled" : ""}>׳׳׳× ׳•׳”׳׳©׳</button>
              <button class="secondary" type="button" data-inline-action="reset-otp">׳׳₪׳¡ ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳</button>
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
      "׳׳™׳ ׳׳¡׳׳•׳ ׳©׳׳•׳¨ ׳׳”׳׳©׳",
      "׳›׳“׳™ ׳׳”׳’׳™׳¢ ׳׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳¦׳¨׳™׳ ׳׳”׳×׳—׳™׳ ׳׳”׳¢׳¡׳§׳” ׳•׳׳©׳׳•׳¨ ׳§׳•׳“׳ ׳‘׳—׳™׳¨׳× ׳›׳׳•׳×.",
      `/app/deal/${encodeURIComponent(dealId)}`
    );
  }
  if (!flow.otpVerified) {
    return renderRecoveryState(
      "׳¦׳¨׳™׳ ׳׳”׳©׳׳™׳ ׳§׳•׳“׳ ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳",
      "׳”׳›׳׳•׳× ׳ ׳©׳׳¨׳”, ׳׳‘׳ ׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳¦׳¨׳™׳ ׳׳”׳©׳׳™׳ ׳׳× ׳׳™׳׳•׳× ׳”׳˜׳׳₪׳•׳.",
      `/app/join/${encodeURIComponent(dealId)}/otp`
    );
  }

  const deal = state.dealPayload?.deal;
  const preview = state.previewMeta?.preview;
  const deliveryLabel = flow.deliveryMethodLabel || "׳׳ ׳ ׳‘׳—׳¨";
  const deliveryCost = Number(flow.deliveryCost || 0);
  const holdTotal = Number(flow.estimatedTotal || ((flow.qty || 0) * (deal?.price_per_unit || 0) + deliveryCost));
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">׳©׳׳‘ 2 ׳׳×׳•׳ 3</span>
        <h1>׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳׳₪׳ ׳™ ׳”׳¦׳˜׳¨׳₪׳•׳× ׳¡׳•׳₪׳™׳×</h1>
        <p class="muted">׳–׳”׳• ׳©׳׳‘ ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“. ׳׳™׳ ׳›׳׳ ׳—׳™׳•׳‘ ׳׳™׳™׳“׳™, ׳׳׳ ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳׳§׳¨׳׳× ׳”׳©׳׳׳× ׳”׳¢׳¡׳§׳”.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">׳׳” ׳§׳•׳¨׳” ׳¢׳›׳©׳™׳•</span><strong>׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“</strong></div>
          <div class="trust-point"><span class="muted">׳׳” ׳׳ ׳§׳•׳¨׳” ׳¢׳›׳©׳™׳•</span><strong>׳׳™׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳</strong></div>
          <div class="trust-point"><span class="muted">׳׳×׳™ ׳›׳ ׳™׳—׳•׳™׳‘</span><strong>׳¨׳§ ׳׳ ׳”׳¢׳¡׳§׳” ׳×׳•׳©׳׳</strong></div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">׳¢׳¡׳§׳”</span><strong>${esc(deal?.title || flow.dealTitle || "")}</strong></div>
          <div class="summary-item"><span class="muted">׳§׳•׳ ׳” ׳׳׳•׳׳×</span><strong>${esc(flow.buyerId || "")}</strong></div>
          <div class="summary-item"><span class="muted">׳›׳׳•׳×</span><strong>${num(flow.qty || 0)} ׳™׳—'</strong></div>
          <div class="summary-item"><span class="muted">׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${esc(deliveryLabel)}</strong></div>
          <div class="summary-item"><span class="muted">׳¢׳׳•׳× ׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${currency(deliveryCost)}</strong></div>
          <div class="summary-item"><span class="muted">׳¢׳׳•׳× ׳׳©׳•׳¢׳¨׳×</span><strong>${currency(holdTotal)}</strong></div>
        </div>
          <div class="summary-item">
            <span class="muted">׳¢׳“׳›׳•׳ ׳׳—׳¨׳•׳ ׳׳׳¡׳׳•׳</span>
            <strong>${relativeTime(flow.updatedAt)}</strong>
            <p class="small muted">׳›׳ ׳׳₪׳©׳¨ ׳׳”׳‘׳™׳ ׳׳ ׳׳×׳” ׳׳׳©׳™׳ ׳׳¡׳׳•׳ ׳˜׳¨׳™ ׳׳• ׳—׳•׳–׳¨ ׳׳׳™׳• ׳׳—׳¨׳™ ׳”׳₪׳¡׳§׳”.</p>
          </div>
          ${renderLegalReferenceStrip("payment")}
          <div class="info-strip trust-box">
            <strong>אישור תפיסת מסגרת</strong>
            <p class="small">${PAYMENT_READINESS.settlementModel}. ${PAYMENT_READINESS.integrationNote}</p>
        </div>
        <div class="summary-item summary-spotlight">
          <span class="muted">׳¡׳›׳•׳ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×</span>
          <strong>${currency(holdTotal)}</strong>
          <p class="small muted">׳–׳” ׳”׳¡׳›׳•׳ ׳©׳™׳™׳©׳׳¨ ׳›׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳©׳׳‘ ׳”׳–׳”. ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳™׳§׳¨׳” ׳¨׳§ ׳׳ ׳”׳¢׳¡׳§׳” ׳×׳•׳©׳׳.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="info-strip tone-warning">
          <strong>תפיסת מסגרת בלבד</strong>
          <p class="small">לא מתבצע חיוב בפועל עכשיו. הסכום יתפוס מסגרת אשראי בלבד, והחיוב יתבצע רק אם העסקה תיסגר בהצלחה.</p>
        </div>
        <div class="cta-panel">
          <strong>׳©׳§׳˜ ׳•׳‘׳”׳™׳¨ ׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨</strong>
          <p class="small muted">׳–׳” ׳”׳׳¡׳ ׳”׳׳—׳¨׳•׳ ׳׳₪׳ ׳™ ׳©׳׳™׳¨׳× ׳”׳”׳¦׳˜׳¨׳₪׳•׳×. ׳׳—׳¨׳™ ׳”׳׳™׳©׳•׳¨ ׳×׳¢׳‘׳•׳¨ ׳׳™׳“ ׳׳׳¡׳ ׳”׳¦׳׳—׳” ׳•׳׳¢׳§׳‘.</p>
        </div>
        <form data-action="pay" class="stack">
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
          <div class="field"><label for="holderName">׳©׳ ׳‘׳¢׳ ׳”׳›׳¨׳˜׳™׳¡</label><input id="holderName" name="holderName" type="text" data-dir="rtl" value="${esc(state.form.holderName)}" autocomplete="cc-name" /></div>
          <div class="field"><label for="cardNumber">׳׳¡׳₪׳¨ ׳›׳¨׳˜׳™׳¡</label><input id="cardNumber" name="cardNumber" type="text" data-dir="ltr" inputmode="numeric" value="${esc(state.form.cardNumber)}" autocomplete="cc-number" placeholder="4111111111111111" /></div>
          <div class="inline-fields">
            <div class="field"><label for="expiry">׳×׳•׳§׳£</label><input id="expiry" name="expiry" type="text" data-dir="ltr" value="${esc(state.form.expiry)}" autocomplete="cc-exp" placeholder="12/28" /></div>
            <div class="field"><label for="cvv">CVV</label><input id="cvv" name="cvv" type="password" data-dir="ltr" inputmode="numeric" value="${esc(state.form.cvv)}" autocomplete="cc-csc" placeholder="123" /></div>
          </div>
          <label class="check-row"><input type="checkbox" name="buyerTermsAcceptance" checked required /> <span>אני מאשר/ת את תנאי השימוש.</span></label>
          <label class="check-row"><input type="checkbox" name="buyerRefundAcceptance" checked required /> <span>אני מאשר/ת שקראתי את מדיניות הביטולים וההחזרים.</span></label>
          <label class="check-row"><input type="checkbox" name="buyerPaymentDisclosureAcceptance" checked required /> <span>אני מאשר/ת שהבנתי שמדובר בתפיסת מסגרת בלבד ולא בחיוב בפועל עכשיו.</span></label>
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
      "׳׳™׳ ׳¡׳©׳ ׳©׳׳•׳¨ ׳׳׳¡׳ ׳”׳–׳”",
      "׳׳₪׳©׳¨ ׳׳—׳–׳•׳¨ ׳׳¢׳¡׳§׳” ׳•׳׳”׳×׳—׳™׳ ׳׳¡׳׳•׳ ׳—׳“׳©, ׳׳• ׳׳”׳™׳›׳ ׳¡ ׳™׳©׳™׳¨׳•׳× ׳׳׳¢׳§׳‘ ׳׳ ׳›׳‘׳¨ ׳™׳© ׳׳ ׳׳–׳”׳” ׳”׳©׳×׳×׳₪׳•׳×.",
      `/app/deal/${encodeURIComponent(dealId)}`
    );
  }
  if (!flow.participantId) {
    return renderRecoveryState(
      "׳¢׳“׳™׳™׳ ׳׳™׳ ׳׳™׳©׳•׳¨ ׳¡׳•׳₪׳™ ׳׳”׳¦׳’׳”",
      "׳›׳“׳™ ׳׳”׳’׳™׳¢ ׳׳׳¡׳ ׳”׳׳™׳©׳•׳¨ ׳¦׳¨׳™׳ ׳׳¡׳™׳™׳ ׳§׳•׳“׳ ׳׳× ׳©׳׳‘ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳•׳”׳”׳¦׳˜׳¨׳₪׳•׳×.",
      `/app/join/${encodeURIComponent(dealId)}/payment`
    );
  }

  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis success-surface">
        <span class="eyebrow">׳©׳׳‘ 3 ׳׳×׳•׳ 3</span>
        <span class="badge success">${REQUIRED_SUCCESS_HEADLINE}</span>
        <h1>${REQUIRED_SUCCESS_HEADLINE}</h1>
        <p class="muted">׳”׳©׳׳׳ ׳• ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳, ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳•׳”׳¨׳©׳׳” ׳׳¢׳¡׳§׳”. ׳׳›׳׳ ׳¢׳•׳‘׳¨׳™׳ ׳׳׳¢׳§׳‘ ׳¢׳“ ׳׳¡׳’׳™׳¨׳× ׳”׳¢׳¡׳§׳”.</p>
        <div class="tracking-next-panel">
          <span class="muted">׳׳” ׳§׳¨׳” ׳¢׳“ ׳¢׳›׳©׳™׳•</span>
          <strong>׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳” ׳•׳ ׳×׳₪׳¡׳” ׳׳¡׳’׳¨׳×</strong>
          <p class="small muted">לא בוצע חיוב בפועל. ${REQUIRED_CHARGE_CONDITION}. ${REQUIRED_RELEASE_NOTICE}.</p>
        </div>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">׳”׳¦׳˜׳¨׳₪׳•׳×</span><strong>׳ ׳©׳׳¨׳” ׳‘׳”׳¦׳׳—׳”</strong></div>
          <div class="trust-point"><span class="muted">׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳×</span><strong>׳׳•׳©׳¨׳” ׳•׳ ׳©׳׳¨׳”</strong></div>
          <div class="trust-point"><span class="muted">׳”׳©׳׳‘ ׳”׳‘׳</span><strong>׳׳¢׳§׳‘ ׳¢׳“ ׳¡׳’׳™׳¨׳× ׳”׳¢׳¡׳§׳”</strong></div>
        </div>
          <div class="summary-grid">
            <div class="summary-item"><span class="muted">סטטוס ההצטרפות</span><strong>שמורה במערכת</strong></div>
            <div class="summary-item"><span class="muted">סטטוס המסגרת</span><strong>תפיסת מסגרת בלבד</strong></div>
            <div class="summary-item"><span class="muted">׳›׳׳•׳× ׳©׳ ׳¨׳©׳׳”</span><strong>${num(flow.qty || 0)} ׳™׳—'</strong></div>
            <div class="summary-item"><span class="muted">׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${esc(flow.deliveryMethodLabel || "׳׳ ׳–׳׳™׳")}</strong></div>
            <div class="summary-item"><span class="muted">׳¢׳׳•׳× ׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${currency(flow.deliveryCost || 0)}</strong></div>
            <div class="summary-item"><span class="muted">׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳›׳•׳׳׳×</span><strong>${currency(flow.estimatedTotal || 0)}</strong></div>
            <div class="summary-item"><span class="muted">׳׳” ׳ ׳©׳׳¨ ׳¢׳›׳©׳™׳•</span><strong>׳”׳©׳×׳×׳₪׳•׳× ׳₪׳¢׳™׳׳” ׳¢׳ ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳×</strong></div>
          </div>
          ${renderLegalReferenceStrip("confirmation")}
        </article>
      <aside class="card hero-side stack">
        <div class="info-strip tone-success">
          <strong>׳׳” ׳§׳•׳¨׳” ׳¢׳›׳©׳™׳•?</strong>
          <p class="small">׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳™׳¨׳׳” ׳׳ ׳›׳¨׳’׳¢ ׳¨׳§ ׳ ׳¨׳©׳׳×, ׳׳ ׳”׳—׳™׳•׳‘ ׳›׳‘׳¨ ׳‘׳•׳¦׳¢, ׳•׳׳ ׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳” ׳׳• ׳ ׳›׳©׳׳”.</p>
        </div>
        <div class="summary-grid">
          <div class="summary-item">
            <span class="muted">׳¢׳“׳™׳™׳ ׳׳™׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳</span>
            <strong>׳¨׳§ ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×</strong>
            <p class="small muted">׳׳₪׳ר׳ש ׳ה׳ח׳ש׳ו׳ב ׳ה׳ו׳א ׳ב׳י׳ן ׳ת׳פ׳י׳ס׳ת ׳מ׳ס׳ג׳ר׳ת ׳ל׳ב׳י׳ן ׳ח׳י׳ו׳ב ׳א׳מ׳י׳ת׳י.</p>
          </div>
          <div class="summary-item">
            <span class="muted">׳׳” ׳כ׳ד׳א׳י ׳ל׳ע׳ש׳ו׳ת ׳ע׳כ׳ש׳יו</span>
            <strong>׳׳ש׳׳•׳¨ ׳׳× ׳׳¡׳ ׳ה׳׳¢׳§׳‘</strong>
            <p class="small muted">׳א׳ם ׳י׳ש ׳ע׳ר׳ך ׳ל׳ש׳י׳ת׳ו׳ף, ׳כ׳ד׳א׳י ׳ל׳ש׳ל׳ו׳ח ׳א׳× ׳ק׳י׳ש׳ו׳ר ׳ה׳מ׳¢׳ק׳‘ ׳ל׳ע׳צ׳מ׳ך.</p>
          </div>
        </div>
        <div class="cta-panel success-panel">
          <strong>׳”׳¢׳¡׳§׳” ׳©׳׳ ׳›׳‘׳¨ ׳‘׳×׳•׳ ׳”׳׳¢׳¨׳›׳×</strong>
          <p class="small muted">׳©׳׳•׳¨ ׳׳× ׳׳¡׳ ׳”׳׳¢׳§׳‘, ׳•׳©׳׳— ׳׳•׳×׳• ׳׳¢׳¦׳׳ ׳׳• ׳׳׳™ ׳©׳¦׳¨׳™׳ ׳׳¢׳§׳•׳‘ ׳׳—׳¨׳™ ׳”׳¡׳˜׳˜׳•׳¡.</p>
        </div>
        ${flow.authorizationMessage ? `
          <div class="summary-item">
            <span class="muted">׳”׳•׳“׳¢׳× ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×</span>
            <p class="small">${esc(flow.authorizationMessage)}</p>
          </div>
        ` : ""}
        ${renderShareActions(`/app/track/${encodeURIComponent(flow.participantId)}`, flow.dealTitle || "מעקב השתתפות בסיטון")}
        <div class="summary-item">
          <span class="muted">׳”׳׳¡׳׳•׳ ׳¢׳•׳“׳›׳</span>
          <strong>${relativeTime(flow.updatedAt)}</strong>
        </div>
        <div class="actions">
          <a class="button primary" href="/app/track/${encodeURIComponent(flow.participantId)}" data-nav="/app/track/${encodeURIComponent(flow.participantId)}">׳׳׳¡׳ ׳”׳׳¢׳§׳‘</a>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(dealId)}" data-nav="/app/deal/${encodeURIComponent(dealId)}">׳—׳–׳¨׳” ׳׳¢׳¡׳§׳”</a>
        </div>
      </aside>
    </section>
  `;
}

function renderTrackingPage() {
  if (!state.trackingPayload && state.loading) return "";
  if (!state.trackingPayload) {
    return renderEmptyState("׳׳ ׳׳¦׳׳ ׳• ׳׳× ׳”׳”׳©׳×׳×׳₪׳•׳×", "׳›׳“׳׳™ ׳׳‘׳“׳•׳§ ׳׳× ׳”׳§׳™׳©׳•׳¨, ׳׳• ׳׳—׳–׳•׳¨ ׳׳¢׳¡׳§׳” ׳•׳׳”׳×׳—׳™׳ ׳׳¡׳׳•׳ ׳—׳“׳©.");
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
          <div class="tracking-progress-head">
            <div>
              <span class="muted">התקדמות למינימום</span>
              <strong>${percent(progressPct)}</strong>
            </div>
            <p class="small muted">${progress.remaining_to_minimum > 0 ? `חסרות עוד ${num(progress.remaining_to_minimum)} יחידות למינימום` : "המינימום הושג"}</p>
          </div>
          <div class="meter tracking-meter" aria-label="התקדמות העסקה למינימום">
            <span style="width:${Math.max(4, progressPct)}%"></span>
          </div>
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
          <div class="status-item"><span class="muted">׳׳¦׳‘ ׳”׳¢׳¡׳§׳”</span><strong>${dealState.label}</strong><p class="small muted">${dealState.description}</p></div>
          <div class="status-item"><span class="muted">׳׳¦׳‘ ׳”׳”׳©׳×׳×׳₪׳•׳×</span><strong>${buyerState[0]}</strong><p class="small muted">${buyerState[1]}</p></div>
          <div class="status-item"><span class="muted">׳׳¦׳‘ ׳›׳¡׳₪׳™</span><strong>${moneyState[0]}</strong><p class="small muted">${moneyState[1]}</p></div>
          <div class="status-item"><span class="muted">׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${esc(tracking.delivery_method_label || "׳׳ ׳–׳׳™׳")}</strong><p class="small muted">${esc(formatDeliveryTypeLabel(tracking.delivery_method_type || ""))}</p></div>
          <div class="status-item"><span class="muted">׳¢׳׳•׳× ׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${currency(tracking.delivery_cost || 0)}</strong><p class="small muted">׳ ׳©׳׳¨׳” ׳¢׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×</p></div>
          <div class="status-item"><span class="muted">׳¢׳׳•׳× ׳׳©׳•׳¢׳¨׳×</span><strong>${currency(tracking.estimated_total)}</strong><p class="small muted">${num(tracking.qty)} ׳™׳—' x ${currency(tracking.price_per_unit)} + ${currency(tracking.delivery_cost || 0)}</p></div>
        </div>
          <div class="stack section compact-section">
            <h3>׳׳™׳₪׳” ׳”׳׳¡׳׳•׳ ׳©׳׳ ׳¢׳•׳׳“?</h3>
            <div class="status-rail tracking-rail">
              ${journey.map((step) => renderStep(step.title, step.done, step.current)).join("")}
            </div>
            <div class="info-strip">
              <strong>׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳”׳•׳ ׳׳§׳•׳¨ ׳”׳׳׳× ׳©׳׳</strong>
              <p class="small muted">׳›׳׳ ׳¨׳•׳׳™׳ ׳™׳—׳“ ׳׳× ׳׳¦׳‘ ׳”׳¢׳¡׳§׳”, ׳׳¦׳‘ ׳”׳”׳©׳×׳×׳₪׳•׳×, ׳•׳׳¦׳‘ ׳”׳›׳¡׳£, ׳‘׳׳™ ׳׳¢׳‘׳•׳¨ ׳‘׳™׳ ׳׳¡׳›׳™׳ ׳ ׳•׳¡׳₪׳™׳.</p>
            </div>
            <div class="table-panel">
              <div class="table-toolbar">
                <div>
                  <strong>׳׳” ׳§׳¨׳” ׳¢׳‘׳•׳¨׳ ׳¢׳“ ׳¢׳›׳©׳™׳•</strong>
                  <p class="small muted">׳¦׳™׳¨ ׳–׳׳ ׳§׳¦׳¨ ׳•׳‘׳¨׳•׳¨ ׳©׳׳¡׳‘׳™׳¨ ׳׳× ׳”׳׳¦׳‘ ׳׳׳ ׳–׳¨׳’׳•׳.</p>
                </div>
              </div>
              <div class="table-like">
                ${timeline.map((row) => `
                  <div class="table-row">
                    <div class="table-cell"><span class="table-cell-label">${esc(row.label)}</span><span class="table-cell-value">${esc(row.value)}</span></div>
                    <div class="table-cell"><span class="table-cell-label">׳₪׳™׳¨׳•׳˜</span><span class="table-cell-value">${esc(row.detail)}</span></div>
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
          <span class="muted">׳×׳׳•׳ ׳× ׳׳¦׳‘ ׳¢׳“׳›׳ ׳™׳×</span>
          <strong>${buyerState[0]}</strong>
          <p class="small muted">${moneyState[0]} ֲ· ${dealState.label}</p>
        </div>
        <div class="summary-item"><span class="muted">קישור המעקב</span><strong>פרטי וזמין מהדף הזה</strong></div>
        <div class="summary-item"><span class="muted">זיהוי קונה</span><strong>מאומת ומוסתר לצורך פרטיות</strong></div>
        <div class="summary-item"><span class="muted">׳׳•׳₪׳ ׳§׳‘׳׳”</span><strong>${esc(tracking.delivery_method_label || "׳׳ ׳–׳׳™׳")}</strong></div>
        ${linkedFlow?.lastTrackingViewedAt ? `<div class="summary-item"><span class="muted">׳¦׳₪׳™׳™׳” ׳׳—׳¨׳•׳ ׳” ׳‘׳׳¡׳׳•׳</span><strong>${dt(linkedFlow.lastTrackingViewedAt)}</strong></div>` : ""}
        ${linkedFlow?.updatedAt ? `<div class="summary-item"><span class="muted">׳¡׳©׳ ׳”-flow ׳¢׳•׳“׳›׳</span><strong>${relativeTime(linkedFlow.updatedAt)}</strong></div>` : ""}
        <div class="summary-item"><span class="muted">׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×</span><strong>${dt(tracking.deadline)}</strong></div>
        ${tracking.completion_window_until ? `<div class="summary-item"><span class="muted">׳¡׳™׳•׳ ׳—׳׳•׳ ׳”׳©׳׳׳”</span><strong>${dt(tracking.completion_window_until)}</strong></div>` : ""}
        <div class="summary-item">
          <span class="muted">${esc("\u05de\u05e1\u05de\u05da \u05dc\u05e7\u05d5\u05e0\u05d4")}</span>
          <strong>${esc(documentVisibility.shortLabel)}</strong>
          <p class="small muted">${esc(documentVisibility.shortDetail)}</p>
        </div>
        <div class="info-strip ${tone}">
          <strong>׳”׳׳ ׳ ׳“׳¨׳© ׳׳׳ ׳׳©׳”׳•?</strong>
          <p class="small">${tracking.buyer_state === "ChargeFailedCompletion" ? "׳׳ ׳™׳ª׳ו׳ס׳£ ׳¦׳¢׳“ ׳ ׳“׳¨׳©, ׳ה׳מ׳ס׳ך ׳ה׳ז׳ה ׳י׳¦׳™׳’ ׳א׳ו׳ת׳ו ׳ב׳ב׳ה׳י׳¨׳ו׳ת." : "׳›׳¨׳’׳¢ ׳׳™׳ ׳¦׳•׳¨׳ ׳‘׳₪׳¢׳•׳׳” ׳™׳–׳•׳׳” ׳׳¦׳“׳."}</p>
        </div>
        <div class="surface-note">
          <strong>׳”׳׳¢׳§׳‘ ׳”׳–׳” ׳”׳•׳ ׳”׳׳§׳•׳¨ ׳”׳§׳•׳‘׳¢</strong>
          <p class="small muted">${esc(supportNote)}</p>
        </div>
        ${renderShareActions(`/app/track/${encodeURIComponent(tracking.participant_id)}`, tracking.deal_title || "מעקב השתתפות בסיטון")}
        <div class="actions"><a class="button secondary" href="/app/deal/${encodeURIComponent(tracking.deal_id)}" data-nav="/app/deal/${encodeURIComponent(tracking.deal_id)}">׳—׳–׳¨׳” ׳׳¢׳¡׳§׳”</a></div>
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
        <span class="eyebrow">׳”׳׳×׳¨ ׳”׳¨׳׳©׳™ ׳©׳ ׳¡׳™׳˜׳•׳</span>
        <h1>׳₪׳•׳×׳—׳™׳ ׳¢׳¡׳§׳”, ׳׳¢׳׳™׳ ׳“׳£ ׳׳™׳©׳™, ׳•׳׳₪׳™׳¦׳™׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳§׳•׳ ׳™׳</h1>
        <p class="muted">
          ׳¡׳™׳˜׳•׳ ׳”׳™׳ ׳₪׳׳˜׳₪׳•׳¨׳׳” ׳׳¢׳¡׳§׳׳•׳× ׳§׳‘׳•׳¦׳×׳™׳•׳× ׳׳‘׳•׳¡׳¡׳•׳× ׳׳™׳ ׳§. ׳”׳׳×׳¨ ׳”׳¨׳׳©׳™ ׳”׳•׳ ׳©׳¢׳¨ ׳”׳¢׳‘׳•׳“׳” ׳׳׳•׳›׳¨: ׳׳›׳׳ ׳₪׳•׳×׳—׳™׳ ׳¢׳¡׳§׳”, ׳׳₪׳¨׳¡׳׳™׳ ׳“׳£ ׳¦׳™׳‘׳•׳¨׳™ ׳׳™׳©׳™, ׳•׳׳₪׳™׳¦׳™׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳©׳“׳¨׳›׳• ׳”׳§׳•׳ ׳™׳ ׳׳¦׳˜׳¨׳₪׳™׳.
        </p>
        <div class="actions">
          <a class="button primary" href="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}" data-nav="${esc(payload?.seller_entry?.create_deal_url || "/app/seller/new")}">׳₪׳×׳™׳—׳× ׳¢׳¡׳§׳” ׳—׳“׳©׳”</a>
          <a class="button secondary" href="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}" data-nav="${esc(payload?.seller_entry?.manage_deals_url || "/app/seller")}">׳ ׳™׳”׳•׳ ׳”׳¢׳¡׳§׳׳•׳× ׳©׳׳™</a>
        </div>
        <div class="summary-item">
          <span class="muted">׳ ׳§׳•׳“׳× ׳”׳›׳ ׳™׳¡׳” ׳©׳ ׳”׳§׳•׳ ׳”</span>
          <strong class="mono">/app/deal/&lt;dealId&gt;</strong>
          <p class="small muted">${esc(payload?.buyer_entry_note || "הקונה נכנס ישירות לדף העסקה דרך לינק אישי שנשלח אליו.")}</p>
        </div>
        <div class="summary-item">
          <span class="muted">׳”׳›׳™׳•׳•׳ ׳”׳׳•׳¦׳¨׳™ ׳”׳₪׳¢׳™׳</span>
          <strong>${esc(payload?.product_direction || "׳¢׳¡׳§׳׳•׳× ׳§׳‘׳•׳¦׳×׳™׳•׳× ׳׳‘׳•׳¡׳¡׳•׳× ׳׳™׳ ׳§")}</strong>
          <p class="small muted">${esc(payload?.positioning || "׳׳×׳¨ ׳׳•׳×׳’׳™ ׳—׳–׳§ ׳׳׳•׳›׳¨׳™׳, ׳¢׳ ׳“׳£ ׳¢׳¡׳§׳” ׳¦׳™׳‘׳•׳¨׳™ ׳•׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳§׳•׳ ׳”.")}</p>
        </div>
      </article>
        <aside class="card hero-side stack">
          <div class="summary-item"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳ ׳₪׳×׳—׳•</span><strong>${num(payload?.proof_points?.total_deals || 0)}</strong></div>
          <div class="summary-item"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳—׳™׳•׳× ׳¢׳›׳©׳™׳•</span><strong>${num(payload?.proof_points?.live_deals || 0)}</strong></div>
          <div class="summary-item"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳”׳•׳©׳׳׳•</span><strong>${num(payload?.proof_points?.completed_deals || 0)}</strong></div>
          ${preview?.is_demo_preview ? `<div class="summary-item"><span class="muted">׳׳¦׳‘ ׳”׳¡׳‘׳™׳‘׳”</span><strong>${esc(formatEnvironmentLabel(preview?.deployment_mode || "preview"))}</strong></div>` : `<div class="summary-item"><span class="muted">׳׳¦׳‘ ׳¡׳‘׳™׳‘׳× ׳”׳¢׳‘׳•׳“׳”</span><strong>׳׳¡׳׳•׳ ׳׳•׳›׳¨ ׳₪׳¢׳™׳</strong></div>`}
          <div class="summary-item"><span class="muted">׳”׳‘׳˜׳—׳× ׳”׳׳¡׳׳•׳</span><strong>׳”׳׳•׳›׳¨ ׳₪׳•׳×׳—, ׳”׳§׳•׳ ׳” ׳׳¦׳˜׳¨׳£ ׳“׳¨׳ ׳׳™׳ ׳§</strong></div>
          <div class="summary-item summary-spotlight"><span class="muted">׳׳¢׳˜׳₪׳× ׳׳׳•׳ ׳¦׳™׳‘׳•׳¨׳™׳×</span><strong>׳×׳ ׳׳™ ׳©׳™׳׳•׳©, ׳₪׳¨׳˜׳™׳•׳×, ׳‘׳™׳˜׳•׳׳™׳ ׳•׳”׳—׳–׳¨׳™׳</strong><p class="small muted">׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳–׳׳™׳ ׳׳”׳׳©׳˜׳—׳™׳ ׳”׳¦׳™׳‘׳•׳¨׳™׳™׳ ׳›׳“׳™ ׳©׳”׳׳•׳¦׳¨ ׳™׳™׳¨׳׳” ׳¡׳’׳•׳¨, ׳׳—׳¨׳׳™ ׳•׳‘׳¨׳•׳¨ ׳’׳ ׳׳₪׳ ׳™ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×.</p></div>
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
  if (!payload) return renderEmptyState("׳׳–׳•׳¨ ׳”׳׳•׳›׳¨ ׳׳ ׳–׳׳™׳", "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳¢׳›׳©׳™׳• ׳׳× ׳׳–׳•׳¨ ׳”׳׳•׳›׳¨.");
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
        <span class="eyebrow">׳׳–׳•׳¨ ׳”׳׳•׳›׳¨</span>
        <h1>׳₪׳•׳×׳—׳™׳, ׳׳₪׳¨׳¡׳׳™׳ ׳•׳׳ ׳”׳׳™׳ ׳›׳ ׳¢׳¡׳§׳” ׳׳׳§׳•׳ ׳׳—׳“</h1>
        <p class="muted">׳–׳”׳• ׳©׳¢׳¨ ׳”׳¢׳‘׳•׳“׳” ׳”׳¨׳׳©׳™ ׳׳׳•׳›׳¨: ׳₪׳•׳×׳—׳™׳ ׳˜׳™׳•׳˜׳”, ׳׳₪׳¨׳¡׳׳™׳ ׳“׳£ ׳¢׳¡׳§׳” ׳—׳™, ׳׳¢׳×׳™׳§׳™׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳§׳•׳ ׳™׳, ׳•׳¢׳•׳§׳‘׳™׳ ׳׳—׳¨׳™ ׳”׳”׳¦׳˜׳¨׳₪׳•׳™׳•׳× ׳‘׳׳™ ׳׳”׳™׳©׳¢׳ ׳¢׳ ׳—׳™׳₪׳•׳© ׳¦׳™׳‘׳•׳¨׳™.</p>
        <div class="ops-band">
          <div class="ops-point"><span class="muted">׳–׳”׳•׳× ׳₪׳¢׳™׳׳”</span><strong>${esc(sellerDisplayName)}</strong></div>
          <div class="ops-point"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳—׳™׳•׳×</span><strong>${num(payload.totals.live_deals)}</strong></div>
          <div class="ops-point"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳”׳•׳©׳׳׳•</span><strong>${num(payload.totals.completed_deals)}</strong></div>
        </div>
        <div class="metric-grid">
          <div class="metric"><span class="muted">׳›׳ ׳”׳¢׳¡׳§׳׳•׳× ׳©׳׳™</span><strong>${num(payload.totals.total_deals)}</strong></div>
          <div class="metric"><span class="muted">׳“׳₪׳™ ׳¢׳¡׳§׳” ׳—׳™׳™׳</span><strong>${num(payload.totals.live_deals)}</strong></div>
          <div class="metric"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳”׳•׳©׳׳׳•</span><strong>${num(payload.totals.completed_deals)}</strong></div>
        </div>
        ${sellerNotice ? `<div class="info-strip tone-warning"><strong>${esc(sellerNotice)}</strong></div>` : ""}
        <div class="actions">
          ${canOpenNewDeal ? `<a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">׳₪׳×׳™׳—׳× ׳¢׳¡׳§׳” ׳—׳“׳©׳”</a>` : `<button class="primary" type="button" disabled>פתיחת עסקה חדשה חסומה</button>`}
        </div>
        <div class="kpi-strip">
          <div class="kpi-card strong"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳₪׳¢׳™׳׳•׳× ׳¢׳›׳©׳™׳•</span><strong>${num(payload.totals.live_deals)}</strong><p class="small muted">׳”׳׳¡׳›׳™׳ ׳©׳“׳•׳¨׳©׳™׳ ׳¢׳›׳©׳™׳• ׳”׳₪׳¦׳”, ׳׳¢׳§׳‘ ׳׳• ׳‘׳§׳¨׳”.</p></div>
          <div class="kpi-card warning"><span class="muted">׳˜׳™׳•׳˜׳•׳× ׳©׳׳—׳›׳•׳× ׳׳₪׳¨׳¡׳•׳</span><strong>${num(draftDeals)}</strong><p class="small muted">׳˜׳™׳•׳˜׳•׳× ׳©׳¢׳“׳™׳™׳ ׳׳₪׳©׳¨ ׳׳“׳™׳™׳§ ׳׳₪׳ ׳™ ׳™׳¦׳™׳׳” ׳׳׳™׳ ׳§ ׳—׳™.</p></div>
          <div class="kpi-card success"><span class="muted">׳¢׳¡׳§׳׳•׳× ׳©׳”׳•׳©׳׳׳•</span><strong>${num(payload.totals.completed_deals)}</strong><p class="small muted">׳¢׳¡׳§׳׳•׳× ׳©׳›׳‘׳¨ ׳¢׳‘׳¨׳• ׳׳× ׳”׳׳¡׳׳•׳ ׳”׳׳׳ ׳‘׳”׳¦׳׳—׳”.</p></div>
          <div class="kpi-card danger"><span class="muted">׳ ׳¡׳’׳¨׳• ׳׳׳ ׳”׳©׳׳׳”</span><strong>${num(payload.totals.failed_or_cancelled)}</strong><p class="small muted">׳׳§׳•׳ ׳˜׳•׳‘ ׳׳–׳”׳•׳× ׳׳”׳¨ ׳׳™׳₪׳” ׳¦׳¨׳™׳ ׳׳׳ ׳•׳¢ ׳—׳–׳¨׳” ׳¢׳ ׳׳•׳×׳• ׳“׳₪׳•׳¡.</p></div>
        </div>
        <div class="workspace-focus-grid">
          <div class="summary-item summary-spotlight">
            <span class="muted">׳׳” ׳“׳•׳¨׳© ׳§׳©׳‘ ׳¢׳›׳©׳™׳•</span>
            <strong>${num(sellerBoard.attention.length)} ׳¢׳¡׳§׳׳•׳×</strong>
            <p class="small muted">׳¢׳¡׳§׳׳•׳× ׳—׳™׳•׳×, ׳—׳׳•׳ ׳•׳× ׳¨׳’׳™׳©׳™׳, ׳•׳׳¦׳‘׳™׳ ׳©׳¦׳¨׳™׳›׳™׳ ׳¢׳™׳ ׳׳•׳›׳¨ ׳¢׳›׳©׳™׳•.</p>
          </div>
          <div class="summary-item">
            <span class="muted">׳׳›׳ ׳¡׳” ׳׳ ׳™׳”׳•׳</span>
            <strong>׳”׳¨׳©׳™׳׳” ׳׳×׳—׳׳§׳× ׳׳“׳—׳™׳£, ׳˜׳™׳•׳˜׳•׳× ׳•׳¡׳’׳•׳¨</strong>
            <p class="small muted">׳›׳š ׳‡׳¤׳©׳¨ ׳׳”׳‘׳™׳ ׳׳™׳“ ׳׳™׳₪׳” ׳׳§׳“׳, ׳׳” ׳׳₪׳¨׳¡׳, ׳•׳׳™׳¤׳” ׳׳‘׳§׳•׳¨ ׳ª׳•׳¦׳׳•׳ª.</p>
          </div>
        </div>
      </article>
      <aside class="card hero-side stack">
        ${renderSellerContextPanel(sellerProfile)}
        <div class="summary-item summary-spotlight"><span class="muted">׳×׳׳•׳ ׳× ׳©׳׳™׳˜׳”</span><strong>${num(payload.totals.total_deals)} ׳¢׳¡׳§׳׳•׳×</strong><p class="small muted">${num(payload.totals.live_deals)} ׳—׳™׳•׳× ֲ· ${num(payload.totals.failed_or_cancelled)} ׳ ׳¡׳’׳¨׳• ׳׳׳ ׳”׳©׳׳׳”</p></div>
        <div class="cta-panel">
          <strong>${esc(focus.title)}</strong>
          <p class="small muted">${esc(focus.detail)}</p>
        </div>
        <div class="surface-note">
          <strong>׳׳” ׳׳¨׳׳•׳× ׳§׳•׳“׳</strong>
          <p class="small muted">׳¢׳¡׳§׳” ׳—׳™׳” ׳¢׳ ׳—׳׳•׳ ׳§׳¦׳¨ ׳׳• ׳§׳¦׳‘ ׳—׳׳© ׳¦׳¨׳™׳›׳” ׳׳‘׳׳•׳˜ ׳׳™׳“. ׳˜׳™׳•׳˜׳” ׳©׳׳ ׳₪׳•׳¨׳¡׳׳” ׳¢׳“׳™׳™׳ ׳׳ ׳׳™׳™׳¦׳¨׳× ׳›׳¡׳£, ׳•׳׳›׳ ׳¢׳“׳™׳£ ׳׳¡׳’׳•׳¨ ׳׳•׳×׳” ׳׳”׳¨ ׳׳• ׳׳§׳“׳ ׳׳•׳×׳” ׳׳׳™׳ ׳§ ׳—׳™.</p>
        </div>
        <div class="summary-item"><span class="muted">׳›׳׳ ׳”׳¢׳¨׳™׳›׳”</span><strong>׳¢׳¨׳™׳›׳” ׳׳׳׳” ׳¨׳§ ׳‘׳˜׳™׳•׳˜׳”</strong><p class="small muted">׳׳—׳¨׳™ ׳₪׳¨׳¡׳•׳, ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳•׳”׳׳™׳ ׳§ ׳”׳™׳©׳™׳¨ ׳”׳•׳₪׳›׳™׳ ׳׳׳§׳•׳¨ ׳”׳׳׳× ׳”׳₪׳¢׳™׳ ׳©׳ ׳”׳¢׳¡׳§׳”.</p></div>
      </aside>
    </section>
    ${renderSellerAnalyticsSection()}
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>׳¤׳•׳ ׳ ׳”׳¢׳¡׳§׳׳•׳×</h2>
          <p class="muted section-intro">׳ה׳¨׳©׳™׳׳” ׳׳׳•׳¨׳’׳ ׳ת ׳׳₪׳™ ׳׳—׳™׳¤׳•׳×, ׳˜׳™׳•׳˜׳•׳ª ׳•׳¢׳¡׳§׳׳•׳ת ׳©׳›׳‘׳¨ ׳ ׳¡׳’׳¨׳•.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>׳—׳™׳•׳×</span><strong>${num(payload.totals.live_deals)}</strong></span>
          <span class="stat-pill"><span>׳˜׳™׳•׳˜׳•׳×</span><strong>${num(draftDeals)}</strong></span>
          <span class="stat-pill"><span>׳¡׳”"׳›</span><strong>${num(payload.totals.total_deals)}</strong></span>
        </div>
      </div>
      ${payload.deals.length ? `
        ${renderSellerBoardSection("׳“׳•׳¨׳©׳•׳ª ׳§׳©׳‘ ׳׳™׳©׳™", "׳›׳׳ ׳ ׳כ׳ ׳¡׳•׳ª ׳¢׳¡׳§׳׳•׳ª ׳—׳™׳•׳× ׳׳• ׳׳¡׳׳•׳׳™׳ ׳¨׳’׳™׳©׳™׳.", sellerBoard.attention, "׳׳™׳ ׳׳¨׳’׳¢ ׳¢׳¡׳§׳׳•׳ª ׳׳—׳•׳¤׳•׳ª", "׳–׳” ׳–׳׳ ׳˜׳•׳‘ ׳׳¤׳ª׳•׳— ׳¢׳¡׳§׳” ׳—׳“׳©׳” ׳׳• ׳׳׳׳•׳§ ׳׳™׳•׳˜׳•׳ת.")} 
        ${renderSellerBoardSection("׳˜׳™׳•׳˜׳•׳ª ׳׳¤׳¨׳¡׳•׳ם", "׳׳™׳•׳˜׳•׳ת ׳ש׳ע׳ד׳™׳™׳ן ׳נ׳י׳ת׳ן ׳׳ד׳™׳י׳ק ׳ו׳ל׳ק׳ד׳ם ׳ל׳ל׳י׳נ׳ק ׳—׳™.", sellerBoard.draft, "׳׳™׳ן ׳׳™׳•׳˜׳•׳ת ׳׳¤׳¨׳¡׳•׳ם", "׳׳ ׳ה׳¢׳¡׳§׳׳•׳ת ׳ש׳׳ ׳כ׳ב׳ר ׳׳¦׳ו׳™׳•׳ת ׳ב׳מ׳צ׳ב ׳ח׳י ׳א׳ו ׳ס׳ג׳ו׳¨.")} 
        ${renderSellerBoardSection("׳¢׳¡׳§׳׳•׳ת ׳©׳ ׳¡׳’׳¨׳•", "׳₪׳׳ן ׳ר׳ו׳א׳י׳ם ׳ת׳ו׳צ׳א׳ו׳ת, ׳ס׳י׳כ׳ו׳מ׳י׳ם ׳ו׳ה׳מ׳ש׳ך ׳ת׳פ׳ע׳ו׳ ׳א׳ם ׳נ׳ד׳ר׳ש.", sellerBoard.closed, "׳׳™׳ן ׳¢׳¡׳§׳׳•׳ת ׳ס׳ג׳ו׳ר׳ו׳ת", "׳כ׳ש׳ע׳ס׳ק׳ה ׳ת׳ס׳ת׳י׳י׳ם, ׳ה׳י׳א ׳ת׳ע׳ב׳ו׳ר ׳ל׳כ׳א׳ן ׳ע׳ם ׳ת׳מ׳ו׳נ׳ת ׳מ׳צ׳ב ׳מ׳ל׳א׳ה.")} 
      ` : `
        <div class="empty-surface stack">
          <strong>׳¢׳“׳™׳™׳ ׳׳ ׳ ׳₪׳×׳—׳” ׳׳£ ׳¢׳¡׳§׳” ׳×׳—׳× ׳”׳–׳”׳•׳× ׳”׳–׳•</strong>
          <p class="small muted">׳›׳“׳׳™ ׳׳”׳×׳—׳™׳ ׳׳˜׳™׳•׳˜׳” ׳׳—׳× ׳—׳“׳”, ׳׳₪׳¨׳¡׳ ׳׳•׳×׳”, ׳•׳׳”׳₪׳™׳¥ ׳׳™׳ ׳§ ׳׳™׳©׳™ ׳¨׳׳©׳•׳ ׳׳§׳•׳ ׳™׳.</p>
          <div class="actions">${canOpenNewDeal ? `<a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">׳₪׳×׳™׳—׳× ׳¢׳¡׳§׳” ׳¨׳׳©׳•׳ ׳”</a>` : `<button class="primary" type="button" disabled>פתיחת עסקה חדשה חסומה</button>`}</div>
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
          <div class="table-row"><div class="table-cell"><span class="muted">עמלת סיטון</span><strong>${analyticsValue(overview.platform_fee_total_amount, currency)}</strong></div><div class="table-cell"><span class="muted">נטו למוכר</span><strong>${analyticsValue(overview.seller_net_amount, currency)}</strong></div></div>
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
  const progressPct = sellerDealProgressPct(item.metrics, item.max_units);
  const urgency = sellerDeadlineSignal(item.deadline, item.state);
  const primaryImage = getPrimaryDealImage(item);
  return `
    <article class="summary-item">
      <div class="seller-card-head">
        ${primaryImage?.url ? `<img class="seller-card-thumb" src="${esc(primaryImage.url)}" alt="תמונת מוצר עבור ${esc(item.title)}" />` : `<div class="seller-card-thumb placeholder" aria-hidden="true">${esc(([...String(item.title || "")][0] || "ס"))}</div>`}
        <div class="seller-card-meta">
          <span class="muted">׳¢׳¡׳§׳” ${esc(getDealCopy(item.state).label)}</span>
          <h3>${esc(item.title)}</h3>
          <div class="pill-row">
            <span class="stat-pill"><span>׳׳©׳×׳×׳₪׳™׳</span><strong>${num(item.metrics.participants_count)}</strong></span>
            <span class="stat-pill"><span>׳™׳¢׳“</span><strong>${num(item.threshold_units)}</strong></span>
          </div>
        </div>
        <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(getDealCopy(item.state).label)}</span>
      </div>
      <div class="meter"><span style="width:${Math.max(4, progressPct)}%"></span></div>
      <div class="progress-caption"><strong>${num(progressPct)}%</strong><span class="muted">׳׳×׳§׳¨׳× ׳”׳¢׳¡׳§׳” ׳›׳‘׳¨ ׳ ׳¡׳’׳¨׳”</span></div>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">׳™׳—׳™׳“׳•׳× ׳©׳ ׳¨׳©׳׳•</span><strong>${num(item.metrics.joined_units)}</strong></div>
        <div class="summary-item"><span class="muted">׳™׳×׳¨׳” ׳₪׳ ׳•׳™׳”</span><strong>${num(item.metrics.remaining_units)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת סיטון</span><strong>8%</strong></div>
        <div class="summary-item"><span class="muted">׳׳•׳¢׳“ ׳¡׳’׳™׳¨׳”</span><strong>${dt(item.deadline)}</strong></div>
      </div>
      <div class="urgency-panel ${urgency.tone}">
        <strong>${esc(urgency.title)}</strong>
        <p class="small muted">${esc(urgency.detail)}</p>
      </div>
      <div class="seller-card-footer">
        <div class="surface-note">
          <strong>׳”׳₪׳¢׳•׳׳” ׳”׳‘׳׳”</strong>
          <p class="small muted">${esc(urgency.tone === "danger" ? "׳›׳“׳׳™ ׳׳‘׳“׳•׳§ ׳¢׳›׳©׳™׳• ׳׳ ׳”׳¢׳¡׳§׳” ׳¦׳¨׳™׳›׳” ׳“׳—׳™׳₪׳” ׳׳—׳¨׳•׳ ׳” ׳׳• ׳׳¢׳‘׳¨ ׳׳‘׳§׳¨׳” ׳×׳₪׳¢׳•׳׳™׳×." : urgency.tone === "warning" ? "׳”׳¢׳¡׳§׳” ׳ ׳›׳ ׳¡׳× ׳׳—׳׳•׳ ׳¨׳’׳™׳©. ׳©׳•׳•׳” ׳׳•׳•׳“׳ ׳©׳”׳׳™׳ ׳§ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳—׳“ ׳•׳‘׳¨׳•׳¨." : "׳”׳¢׳¡׳§׳” ׳₪׳×׳•׳—׳” ׳•׳×׳—׳× ׳©׳׳™׳˜׳”. ׳׳₪׳©׳¨ ׳׳”׳׳©׳™׳ ׳׳¢׳§׳•׳‘ ׳׳—׳¨׳™ ׳”׳§׳¦׳‘ ׳•׳”׳§׳™׳‘׳•׳׳×.")}</p>
        </div>
        <div class="actions seller-card-actions">
          <a class="button primary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">׳ ׳™׳”׳•׳ ׳”׳¢׳¡׳§׳”</a>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(item.deal_id)}" data-nav="/app/deal/${encodeURIComponent(item.deal_id)}">׳₪׳×׳™׳—׳× ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™</a>
          <button class="secondary" type="button" data-inline-action="copy-link" data-share-url="/app/deal/${encodeURIComponent(item.deal_id)}">העתקת לינק</button>
          ${["Completed", "Failed", "Cancelled"].includes(item.state) ? `<button class="secondary" type="button" data-inline-action="seller-clone" data-deal-id="${esc(item.deal_id)}">צור עסקה דומה</button>` : ""}
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
  const sellerStatus = sellerContext.seller_status || state.sellerAuth?.seller_context?.seller_status || "Active";
  const sellerNotice = sellerEnforcementNotice(sellerStatus);
  if (sellerStatus === "Suspended" || sellerStatus === "Banned") {
    return `
      <section class="hero">
        <article class="card hero-main stack hero-emphasis">
          <span class="eyebrow">פתיחת עסקה</span>
          <h1>פתיחת עסקה חדשה אינה זמינה כרגע</h1>
          <div class="info-strip tone-warning"><strong>${esc(sellerNotice)}</strong></div>
          <div class="actions"><a class="button secondary" href="/app/seller" data-nav="/app/seller">חזרה לאזור המוכר</a></div>
        </article>
      </section>
    `;
  }
  const price = Math.max(0, Number(state.form.sellerPrice || 0));
  const minUnits = Math.max(0, Number(state.form.sellerMinUnits || 0));
  const maxUnits = Math.max(minUnits, Number(state.form.sellerMaxUnits || 0));
  const deliveryOptionsCount = [1, 2, 3].filter((slot) => String(state.form[`sellerDeliveryLabel${slot}`] || "").trim()).length;
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">׳₪׳×׳™׳—׳× ׳¢׳¡׳§׳”</span>
        <h1>׳™׳•׳¦׳¨׳™׳ ׳׳× ׳“׳£ ׳”׳¢׳¡׳§׳” ׳©׳‘׳׳׳× ׳™׳™׳©׳׳— ׳׳§׳•׳ ׳™׳</h1>
        <p class="muted">׳₪׳•׳×׳—׳™׳ ׳˜׳™׳•׳˜׳”, ׳׳’׳“׳™׳¨׳™׳ ׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳”, ׳•׳׳₪׳¨׳¡׳׳™׳ ׳¨׳§ ׳›׳©׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳׳•׳›׳ ׳׳”׳₪׳¦׳” ׳‘׳׳™׳ ׳§ ׳™׳©׳™׳¨.</p>
        <div class="trust-band">
          <div class="trust-point"><span class="muted">׳©׳׳‘ ׳¨׳׳©׳•׳</span><strong>׳©׳•׳׳¨׳™׳ ׳˜׳™׳•׳˜׳” ׳‘׳¨׳•׳¨׳”</strong></div>
          <div class="trust-point"><span class="muted">׳׳—׳¨׳™ ׳₪׳¨׳¡׳•׳</span><strong>׳ ׳•׳¦׳¨ ׳“׳£ ׳¦׳™׳‘׳•׳¨׳™ ׳—׳™</strong></div>
          <div class="trust-point"><span class="muted">׳”׳₪׳¦׳” ׳׳§׳•׳ ׳™׳</span><strong>׳“׳¨׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳‘׳׳‘׳“</strong></div>
        </div>
        <div class="wizard-steps" aria-label="שלבי יצירת עסקה">
          <span>1. פרטי מוצר</span>
          <span>2. כמויות</span>
          <span>3. אספקה</span>
          <span>4. תנאים</span>
          <span>5. אישור סופי</span>
        </div>
        <form data-action="seller-create" class="form-shell">
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>׳‘׳¡׳™׳¡ ׳”׳¢׳¡׳§׳”</h3>
              <p class="small muted">׳׳›׳׳ ׳ ׳§׳‘׳¢ ׳׳™׳ ׳”׳¢׳¡׳§׳” ׳×׳™׳×׳₪׳¡ ׳‘׳¢׳™׳ ׳™ ׳”׳§׳•׳ ׳”: ׳׳” ׳ ׳׳›׳¨, ׳‘׳›׳׳”, ׳•׳׳” ׳”׳׳¨׳•׳•׳— ׳©׳ ׳”׳₪׳׳˜׳₪׳•׳¨׳׳”.</p>
            </div>
            <div class="field"><label for="sellerTitle">׳›׳•׳×׳¨׳× ׳”׳¢׳¡׳§׳”</label><input id="sellerTitle" name="sellerTitle" type="text" value="${esc(state.form.sellerTitle)}" /></div>
            <div class="field"><label for="sellerDescription">תיאור קצר לקונה</label><textarea id="sellerDescription" name="sellerDescription" rows="4" maxlength="420" placeholder="מה מקבלים, למי זה מתאים, ומה חשוב לדעת לפני הצטרפות">${esc(state.form.sellerDescription)}</textarea></div>
            <div class="product-image-uploader">
              <div class="product-image-preview ${state.form.sellerImageDataUrl ? "has-image" : ""}">
                ${state.form.sellerImageDataUrl ? `<img src="${esc(state.form.sellerImageDataUrl)}" alt="תצוגה מקדימה של תמונת מוצר" />` : `<div class="product-image-placeholder"><strong>תמונת מוצר</strong><span>ניתן להוסיף תמונת מוצר לפני הפרסום</span></div>`}
              </div>
              <div class="stack compact-section">
                <div class="field"><label for="sellerImage">תמונה ראשית לתצוגה מקדימה</label><input id="sellerImage" name="sellerImage" type="file" accept="image/png,image/jpeg,image/webp" /></div>
                <p class="small muted">בחרו תמונת מוצר שתופיע בתצוגת העסקה לפני הפרסום.</p>
                ${state.form.sellerImageName ? `<div class="actions"><span class="stat-pill"><span>נבחרה</span><strong>${esc(state.form.sellerImageName)}</strong></span><button class="secondary" type="button" data-inline-action="clear-product-image">הסרת תמונה</button></div>` : ""}
              </div>
            </div>
            <div class="inline-fields">
              <div class="field"><label for="sellerPrice">׳׳—׳™׳¨ ׳׳™׳—׳™׳“׳”</label><input id="sellerPrice" name="sellerPrice" type="number" step="0.01" value="${esc(state.form.sellerPrice)}" /></div>
              <div class="summary-item"><span class="muted">עמלת סיטון הקבועה</span><strong>8% מהגבייה בפועל לא כולל מע"מ</strong><p class="small muted">העמלה כוללת משלוח, סליקה ותפעול. אין עמלה נוספת מעבר לכך.</p></div>
            </div>
            <div class="form-preview-grid">
              <div class="summary-item"><span class="muted">׳׳—׳–׳•׳¨ ׳׳™׳ ׳™׳׳׳™ ׳׳©׳•׳¢׳¨</span><strong>${currency(price * minUnits)}</strong><p class="small muted">${num(minUnits)} ׳™׳—' ׳׳₪׳™ ׳”׳׳—׳™׳¨ ׳”׳ ׳•׳›׳—׳™.</p></div>
              <div class="summary-item"><span class="muted">׳׳—׳–׳•׳¨ ׳׳§׳¡׳™׳׳׳™ ׳׳©׳•׳¢׳¨</span><strong>${currency(price * maxUnits)}</strong><p class="small muted">${num(maxUnits)} ׳™׳—' ׳׳ ׳›׳ ׳”׳§׳™׳‘׳•׳׳× ׳ ׳¡׳’׳¨׳×.</p></div>
            </div>
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>׳™׳¢׳“, ׳§׳™׳‘׳•׳׳× ׳•׳¡׳’׳™׳¨׳”</h3>
              <p class="small muted">׳”׳—׳׳§ ׳”׳–׳” ׳§׳•׳‘׳¢ ׳׳× ׳×׳—׳•׳©׳× ׳”׳“׳—׳™׳₪׳•׳× ׳•׳”׳׳¡׳’׳¨׳× ׳”׳¢׳¡׳§׳™׳× ׳©׳”׳§׳•׳ ׳” ׳™׳¨׳׳” ׳¢׳ ׳”׳“׳£.</p>
            </div>
            <div class="inline-fields">
              <div class="field"><label for="sellerMinUnits">׳׳™׳ ׳™׳׳•׳ ׳™׳—׳™׳“׳•׳×</label><input id="sellerMinUnits" name="sellerMinUnits" type="number" step="1" value="${esc(state.form.sellerMinUnits)}" /></div>
              <div class="field"><label for="sellerMaxUnits">׳׳§׳¡׳™׳׳•׳ ׳™׳—׳™׳“׳•׳×</label><input id="sellerMaxUnits" name="sellerMaxUnits" type="number" step="1" value="${esc(state.form.sellerMaxUnits)}" /></div>
            </div>
            <div class="field"><label for="sellerDeadline">׳׳•׳¢׳“ ׳¡׳’׳™׳¨׳× ׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×</label><input id="sellerDeadline" name="sellerDeadline" type="datetime-local" value="${esc(state.form.sellerDeadline)}" /></div>
            <div class="surface-note">
              <strong>׳‘׳“׳™׳§׳× ׳©׳₪׳™׳•׳× ׳׳”׳™׳¨׳”</strong>
              <p class="small muted">׳›׳“׳׳™ ׳©׳”׳׳™׳ ׳™׳׳•׳ ׳™׳”׳™׳” ׳™׳¢׳“ ׳©׳׳₪׳©׳¨ ׳׳”׳’׳™׳¢ ׳׳׳™׳•, ׳©׳”׳׳§׳¡׳™׳׳•׳ ׳׳ ׳™׳¨׳’׳™׳© ׳׳ ׳•׳×׳§ ׳׳”׳”׳₪׳¦׳”, ׳•׳©׳”׳“׳“׳׳™׳™׳ ׳™׳™׳¦׳•׳¨ ׳“׳—׳™׳₪׳•׳× ׳‘׳׳™ ׳׳‘׳׳‘׳ ׳׳× ׳”׳§׳•׳ ׳”.</p>
            </div>
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳”</h3>
              <p class="small muted">׳׳₪׳©׳¨׳•׳™׳•׳× ׳”׳§׳‘׳׳” ׳¦׳¨׳™׳›׳•׳× ׳׳”׳™׳•׳× ׳§׳¦׳¨׳•׳×, ׳׳•׳‘׳ ׳•׳×, ׳•׳§׳׳•׳× ׳׳”׳©׳•׳•׳׳” ׳›׳‘׳¨ ׳‘׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™.</p>
            </div>
            <p class="small muted">׳׳•׳¡׳™׳₪׳™׳ ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳” ׳׳—׳× ׳׳• ׳™׳•׳×׳¨. ׳”׳‘׳—׳™׳¨׳” ׳©׳ ׳”׳§׳•׳ ׳” ׳ ׳©׳׳¨׳× ׳¢׳ ׳›׳ ׳”׳¦׳˜׳¨׳₪׳•׳× ׳•׳ ׳›׳ ׳¡׳× ׳’׳ ׳׳¡׳™׳›׳•׳ ׳×׳₪׳™׳¡׳× ׳”׳׳¡׳’׳¨׳×.</p>
            ${[1, 2, 3].map((slot) => `
              <div class="form-option-card stack">
                <div class="inline-fields">
                  <div class="field">
                    <label for="sellerDeliveryType${slot}">׳¡׳•׳’</label>
                    <select id="sellerDeliveryType${slot}" name="sellerDeliveryType${slot}">
                      ${["pickup", "delivery", "distribution_point"].map((option) => `<option value="${option}" ${state.form[`sellerDeliveryType${slot}`] === option ? "selected" : ""}>${formatDeliveryTypeLabel(option)}</option>`).join("")}
                    </select>
                  </div>
                  <div class="field">
                    <label for="sellerDeliveryCost${slot}">׳¢׳׳•׳×</label>
                    <input id="sellerDeliveryCost${slot}" name="sellerDeliveryCost${slot}" type="number" step="0.01" min="0" value="${esc(state.form[`sellerDeliveryCost${slot}`])}" />
                  </div>
                </div>
                <div class="field">
                  <label for="sellerDeliveryLabel${slot}">׳×׳•׳•׳™׳× ׳׳§׳•׳ ׳”</label>
                  <input id="sellerDeliveryLabel${slot}" name="sellerDeliveryLabel${slot}" type="text" value="${esc(state.form[`sellerDeliveryLabel${slot}`])}" placeholder="${slot === 1 ? "׳׳™׳¡׳•׳£ ׳¢׳¦׳׳™" : "׳×׳•׳•׳™׳× ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳”"}" />
                </div>
              </div>
            `).join("")}
          </section>
          <section class="form-section-card stack">
            <div class="form-section-header">
              <h3>סיכום ואישור סופי</h3>
              <p class="small muted">לפני יצירת הטיוטה מאשרים שהפרטים הקריטיים נבדקו. אחרי פרסום אין עריכה שקטה של מחיר, כמויות, דדליין או תנאי אספקה.</p>
            </div>
            <div class="form-preview-grid">
              <div class="summary-item"><span class="muted">כותרת</span><strong>${esc(state.form.sellerTitle || "עדיין חסרה")}</strong></div>
              <div class="summary-item"><span class="muted">מחיר</span><strong>${currency(price)}</strong></div>
              <div class="summary-item"><span class="muted">מינימום / מקסימום</span><strong>${num(minUnits)} / ${num(maxUnits)}</strong></div>
              <div class="summary-item"><span class="muted">אופן קבלה</span><strong>${num(deliveryOptionsCount || 1)} אפשרויות</strong></div>
            </div>
            <label class="check-row"><input type="checkbox" name="sellerFinalTerms" /> <span>קראתי ואישרתי את תנאי הפרסום למוכר, כולל אחריותי לתיאור המוצר, אספקתו ושירות לאחר השלמת העסקה.</span></label>
            <label class="check-row"><input type="checkbox" name="sellerFinalConfirm" /> <span>אני מאשר שהתנאים סופיים.</span></label>
          </section>
          <div class="actions">
            <button class="primary" type="submit">׳™׳¦׳™׳¨׳× ׳˜׳™׳•׳˜׳”</button>
            <a class="button secondary" href="/app/seller" data-nav="/app/seller">׳—׳–׳¨׳” ׳׳׳–׳•׳¨ ׳”׳׳•׳›׳¨</a>
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
        
        <div class="summary-item summary-spotlight"><span class="muted">׳–׳”׳•׳× ׳”׳׳•׳›׳¨ ׳”׳₪׳¢׳™׳׳”</span><strong>${esc(sellerContext.display_name)}</strong><p class="small muted">׳׳–׳”׳” ׳׳•׳›׳¨: <span class="mono">${esc(sellerContext.seller_id)}</span></p></div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">׳׳—׳™׳¨ ׳ ׳•׳›׳—׳™</span><strong>${currency(price)}</strong></div>
          <div class="summary-item"><span class="muted">עמלת סיטון</span><strong>8%</strong><p class="small muted">קבועה לפי המודל הקנוני, כולל משלוח וללא מע"מ.</p></div>
          <div class="summary-item"><span class="muted">׳™׳¢׳“ ׳₪׳×׳™׳—׳”</span><strong>${num(minUnits)} ׳™׳—'</strong></div>
          <div class="summary-item"><span class="muted">׳§׳™׳‘׳•׳׳×</span><strong>${num(maxUnits)} ׳™׳—'</strong></div>
        </div>
        <div class="cta-panel">
          <strong>׳׳” ׳™׳§׳¨׳” ׳׳—׳¨׳™ ׳©׳׳™׳¨׳× ׳”׳˜׳™׳•׳˜׳”</strong>
          <p class="small muted">׳”׳˜׳™׳•׳˜׳” ׳×׳™׳›׳ ׳¡ ׳™׳©׳¨ ׳׳׳–׳•׳¨ ׳”׳׳•׳›׳¨, ׳•׳׳©׳ ׳׳₪׳©׳¨ ׳׳₪׳¨׳¡׳ ׳“׳£ ׳¦׳™׳‘׳•׳¨׳™ ׳—׳™, ׳׳₪׳×׳•׳— ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳•׳׳”׳×׳—׳™׳ ׳׳¢׳§׳•׳‘ ׳׳—׳¨׳™ ׳”׳¦׳˜׳¨׳₪׳•׳™׳•׳×.</p>
        </div>
        <div class="form-checklist">
          <div class="summary-item"><span class="muted">׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳” ׳׳•׳›׳ ׳•׳×</span><strong>${num(deliveryOptionsCount || 1)}</strong><p class="small muted">׳׳₪׳—׳•׳× ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳” ׳׳—׳× ׳¦׳¨׳™׳›׳” ׳׳”׳™׳¨׳׳•׳× ׳›׳׳• ׳‘׳—׳™׳¨׳” ׳׳׳™׳×׳™׳× ׳׳§׳•׳ ׳”.</p></div>
          <div class="summary-item"><span class="muted">׳׳” ׳‘׳•׳“׳§׳™׳ ׳׳₪׳ ׳™ ׳₪׳¨׳¡׳•׳</span><strong>׳›׳•׳×׳¨׳×, ׳™׳¢׳“ ׳•׳“׳“׳׳™׳™׳</strong><p class="small muted">׳׳׳” ׳©׳׳•׳©׳× ׳”׳׳§׳•׳׳•׳× ׳©׳”׳›׳™ ׳׳©׳₪׳™׳¢׳™׳ ׳¢׳ ׳‘׳”׳™׳¨׳•׳×, ׳׳׳•׳ ׳•׳“׳—׳™׳₪׳•׳× ׳‘׳׳¡׳ ׳”׳¦׳™׳‘׳•׳¨׳™.</p></div>
        </div>
        <div class="info-strip trust-box">
          <strong>׳›׳׳ ׳”׳¢׳‘׳•׳“׳” ׳‘׳׳¡׳ ׳”׳–׳”</strong>
          <p class="small">׳›׳׳ ׳׳’׳“׳™׳¨׳™׳ ׳₪׳¢׳ ׳׳—׳× ׳׳× ׳”׳׳¡׳’׳¨׳× ׳”׳¢׳¡׳§׳™׳×: ׳׳—׳™׳¨, ׳™׳¢׳“, ׳—׳׳•׳ ׳–׳׳ ׳•׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳”. ׳¨׳§ ׳׳—׳¨׳™ ׳©׳˜׳™׳•׳˜׳” ׳ ׳¨׳׳™׳× ׳—׳“׳”, ׳׳₪׳¨׳¡׳׳™׳ ׳׳•׳×׳” ׳׳“׳£ ׳—׳™.</p>
        </div>
        <div class="surface-note">
          <strong>׳׳¢׳˜׳₪׳× trust ׳‘׳₪׳¨׳¡׳•׳</strong>
          <p class="small muted">׳׳—׳¨׳™ ׳₪׳¨׳¡׳•׳, ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳•׳”׳׳¡׳›׳™׳ ׳©׳׳—׳¨׳™׳• ׳׳¦׳™׳’׳™׳ footer ׳׳©׳₪׳˜׳™ ׳§׳‘׳•׳¢ ׳•׳§׳™׳©׳•׳¨׳™׳ ׳‘׳¨׳•׳¨׳™׳ ׳׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘. ׳׳ ׳ ׳•׳¡׳£ ׳›׳׳ ׳׳™׳©׳•׳¨ ׳׳©׳₪׳˜׳™ ׳׳—׳™׳™׳‘ ׳‘׳×׳•׳ ׳”׳˜׳•׳₪׳¡ ׳›׳“׳™ ׳׳ ׳׳₪׳×׳•׳— ׳׳•׳’׳™׳§׳” ׳—׳“׳©׳” ׳׳• state ׳—׳“׳©.</p>
        </div>
      </aside>
    </section>
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
          <p class="muted section-intro">סיטון מציגה כאן את פרטי הקונים שחויבו וזכאים למוצר. <strong>האספקה עצמה מתבצעת באחריות המוכר ומחוץ למערכת.</strong></p>
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
        <p class="small">${esc(handoff.disclaimer || "האספקה מתבצעת באחריות המוכר ומחוץ למערכת סיטון.")}</p>
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
  if (!payload) return renderEmptyState("׳ ׳™׳”׳•׳ ׳”׳¢׳¡׳§׳” ׳׳ ׳–׳׳™׳", "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳˜׳¢׳•׳ ׳¢׳›׳©׳™׳• ׳׳× ׳׳¡׳ ׳ ׳™׳”׳•׳ ׳”׳¢׳¡׳§׳”.");
  const deal = payload.deal;
  const receipts = payload.receipts_surface;
  const progressPct = sellerDealProgressPct(deal.metrics, deal.max_units);
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
  return `
    <section class="hero">
      <article class="card hero-main stack hero-emphasis">
        <span class="eyebrow">׳ ׳™׳”׳•׳ ׳¢׳¡׳§׳”</span>
        <span class="badge ${DEAL_TONE[deal.state] || "warning"}">${esc(getDealCopy(deal.state).label)}</span>
        ${primaryImage?.url ? `<img class="seller-deal-hero-image" src="${esc(primaryImage.url)}" alt="תמונת מוצר עבור ${esc(deal.title)}" />` : ""}
        <h1>${esc(deal.title)}</h1>
        <p class="muted">׳–׳”׳• ׳—׳“׳¨ ׳”׳‘׳§׳¨׳” ׳©׳ ׳”׳׳•׳›׳¨ ׳׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™, ׳׳׳™׳ ׳§ ׳”׳™׳©׳™׳¨ ׳׳§׳•׳ ׳™׳, ׳׳¨׳©׳™׳׳× ׳”׳׳©׳×׳×׳₪׳™׳ ׳•׳׳¢׳“׳›׳•׳ ׳™ ׳”׳§׳‘׳׳” ׳•׳”׳׳¡׳™׳¨׳”.</p>
        ${sellerNotice ? `<div class="info-strip tone-warning"><strong>${esc(sellerNotice)}</strong></div>` : ""}
        <div class="trust-band">
          <div class="trust-point"><span class="muted">׳׳¦׳‘ ׳¢׳¨׳™׳›׳”</span><strong>${payload.seller_actions.edit_locked ? "׳ ׳¢׳•׳ ׳׳—׳¨׳™ ׳₪׳¨׳¡׳•׳" : "׳¢׳“׳™׳™׳ ׳‘׳˜׳™׳•׳˜׳”"}</strong></div>
          <div class="trust-point"><span class="muted">׳“׳£ ׳¦׳™׳‘׳•׳¨׳™</span><strong>${payload.seller_actions.can_publish ? "׳׳•׳›׳ ׳׳₪׳¨׳¡׳•׳" : "׳›׳‘׳¨ ׳₪׳•׳¨׳¡׳ ׳׳• ׳ ׳¡׳’׳¨"}</strong></div>
          <div class="trust-point"><span class="muted">׳§׳™׳©׳•׳¨ ׳§׳•׳ ׳”</span><strong>׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳—׳“ ׳׳¢׳¡׳§׳”</strong></div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">׳׳—׳™׳¨ ׳׳™׳—׳™׳“׳”</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="summary-item"><span class="muted">׳™׳—׳™׳“׳•׳× ׳©׳ ׳¨׳©׳׳•</span><strong>${num(deal.metrics.joined_units)}</strong></div>
          <div class="summary-item"><span class="muted">׳׳©׳×׳×׳₪׳™׳</span><strong>${num(deal.metrics.participants_count)}</strong></div>
        <div class="summary-item"><span class="muted">עמלת סיטון</span><strong>8%</strong></div>
        </div>
        <div class="live-summary-grid">
          <div class="summary-item summary-spotlight"><span class="muted">׳ ׳•׳×׳¨ ׳׳׳׳</span><strong>${num(Math.max(0, deal.max_units - deal.metrics.joined_units))} ׳™׳—'</strong><p class="small muted">׳׳×׳•׳ ׳§׳™׳‘׳•׳׳× ׳›׳•׳׳׳× ׳©׳ ${num(deal.max_units)} ׳™׳—'.</p></div>
          <div class="summary-item"><span class="muted">׳¡׳£ ׳₪׳×׳™׳—׳”</span><strong>${num(deal.threshold_units)} ׳™׳—'</strong><p class="small muted">׳™׳¢׳“ ׳”׳‘׳¡׳™׳¡ ׳׳₪׳ ׳™ ׳¡׳’׳™׳¨׳× ׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×.</p></div>
          <div class="summary-item"><span class="muted">׳”׳§׳™׳©׳•׳¨ ׳”׳₪׳¢׳™׳</span><strong class="mono">${esc(payload.seller_profile?.direct_link || `/app/deal/${deal.deal_id}`)}</strong><p class="small muted">׳–׳”׳• ׳”׳׳™׳ ׳§ ׳©׳”׳§׳•׳ ׳™׳ ׳¦׳¨׳™׳›׳™׳ ׳׳¨׳׳•׳× ׳•׳׳”׳‘׳™׳ ׳‘׳׳”׳™׳¨׳•׳×.</p></div>
        </div>
        <div class="seller-deal-control-grid">
          <div class="summary-item summary-spotlight">
            <span class="muted">׳—׳•׳™׳‘׳• ׳‘׳”׳¦׳׳—׳”</span>
            <strong>${num(participantSnapshot.charged)}</strong>
            <p class="small muted">׳׳©׳×׳×׳₪׳™׳ ׳©׳”׳׳¢׳¨׳›׳× ׳׳‘׳¨ ׳¡׳™׳׳ ׳” ׳›׳׳•׳©׳׳׳™ ׳—׳™׳•׳‘.</p>
          </div>
          <div class="summary-item">
            <span class="muted">׳‘׳”׳׳×׳ ׳” ׳׳”׳©׳׳׳”</span>
            <strong>${num(participantSnapshot.pending)}</strong>
            <p class="small muted">׳”׳¦׳˜׳¨׳₪׳•׳™׳•׳× ׳©׳¢׳•׳“ ׳ ׳׳ª׳ ׳׳ע׳§׳ו׳ב ׳׳—׳¨׳׳”׳ ׳‘׳׳¡׳׳•׳ ׳׳׳¢׳¨׳׳ª.</p>
          </div>
          <div class="summary-item">
            <span class="muted">׳“׳•׳¨׳© ׳׳§׳¨׳”</span>
            <strong>${num(participantSnapshot.unresolved)}</strong>
            <p class="small muted">׳׳¡׳¤׳¨ ׳׳©׳×׳×׳₪׳™׳ ׳©׳ ׳©׳׳¨׳• ׳‘׳׳¦׳‘ ׳׳ ׳¡׳’׳•׳¨ ׳׳׳™׳ש ׳׳‘׳¨׳¨ ׳¢׳‘׳•׳¨׳.</p>
          </div>
        </div>
        <div class="meter"><span style="width:${Math.max(4, progressPct)}%"></span></div>
        <div class="progress-caption"><strong>${num(progressPct)}%</strong><span class="muted">׳ת׳מ׳ו׳ ׳ת ׳ה׳§׳¦׳‘ ׳מ׳ו׳ ׳ה׳ק׳י׳ב׳ו׳׳× ׳ה׳כ׳ו׳ל׳׳ת</span></div>
        <div class="actions">
          ${payload.seller_actions.can_publish && !publishBlockedByStatus ? `<form data-action="seller-publish" data-deal-id="${esc(deal.deal_id)}"><button class="primary" type="submit">׳₪׳¨׳¡׳•׳ ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™</button></form>` : payload.seller_actions.can_publish && publishBlockedByStatus ? `<button class="primary" type="button" disabled>פרסום חסום זמנית</button>` : ""}
          <button class="secondary" type="button" ${cloneBlockedByStatus ? "disabled" : `data-inline-action="seller-clone" data-deal-id="${esc(deal.deal_id)}"`}>צור עסקה דומה</button>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(deal.deal_id)}" data-nav="/app/deal/${encodeURIComponent(deal.deal_id)}">׳₪׳×׳™׳—׳× ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™</a>
        </div>
        <div class="info-strip">
          <strong>׳׳” ׳ ׳—׳©׳£ ׳׳¦׳™׳‘׳•׳¨ ׳׳—׳¨׳™ ׳₪׳¨׳¡׳•׳</strong>
          <p class="small">׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳•׳”׳׳¡׳›׳™׳ ׳©׳׳—׳¨׳™׳• ׳׳¦׳™׳’׳™׳ ׳›׳¢׳× footer ׳׳©׳₪׳˜׳™ ׳§׳‘׳•׳¢, ׳׳¡׳¨׳™ trust ׳¡׳‘׳™׳‘ ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“, ׳•׳’׳™׳©׳” ׳‘׳¨׳•׳¨׳” ׳׳™׳¦׳™׳¨׳× ׳§׳©׳¨ ׳•׳׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item summary-spotlight"><span class="muted">׳×׳׳•׳ ׳× ׳׳¦׳‘ ׳¢׳“׳›׳ ׳™׳×</span><strong>${esc(getDealCopy(deal.state).label)}</strong><p class="small muted">${num(deal.metrics.joined_units)} ׳™׳—' ׳׳×׳•׳ ${num(deal.max_units)} ֲ· ${num(progressPct)}% ׳¡׳’׳™׳¨׳”</p></div>
        <div class="urgency-panel ${urgency.tone}">
          <strong>${esc(urgency.title)}</strong>
          <p class="small muted">${esc(urgency.detail)}</p>
        </div>
        <div class="countdown-chip"><span>׳“׳“׳׳™׳™׳</span><strong>${dt(deal.deadline)}</strong></div>
        <div class="cta-panel">
          <strong>${esc(focus.title)}</strong>
          <p class="small muted">${esc(focus.detail)}</p>
        </div>
        <div class="surface-note">
          <strong>׳׳” ׳—׳©׳•׳‘ ׳¢׳›׳©׳™׳•</strong>
          <p class="small muted">${esc(payload.seller_actions.can_publish ? "׳׳ ׳”׳˜׳™׳•׳˜׳” ׳ ׳¨׳׳™׳× ׳—׳“׳”, ׳–׳” ׳”׳׳§׳•׳ ׳׳₪׳¨׳¡׳ ׳•׳׳ ׳׳”׳©׳׳™׳¨ ׳׳× ׳”׳¢׳¡׳§׳” ׳‘׳׳™ ׳“׳£ ׳—׳™." : urgency.tone === "danger" ? "׳–׳” ׳—׳׳•׳ ׳©׳¦׳¨׳™׳ ׳‘׳§׳¨׳” ׳׳”׳™׳¨׳”: ׳§׳¦׳‘, ׳§׳™׳©׳•׳¨ ׳¦׳™׳‘׳•׳¨׳™, ׳•׳׳©׳×׳×׳₪׳™׳ ׳©׳›׳‘׳¨ ׳‘׳₪׳ ׳™׳." : "׳”׳׳¡׳ ׳”׳–׳” ׳ ׳•׳¢׳“ ׳׳”׳—׳–׳™׳§ ׳×׳׳•׳ ׳× ׳׳¦׳‘ ׳×׳₪׳¢׳•׳׳™׳× ׳׳—׳×, ׳‘׳׳™ ׳׳—׳₪׳© ׳׳™׳“׳¢ ׳‘׳›׳׳” ׳׳§׳•׳׳•׳×.")}</p>
        </div>
        <div class="summary-item"><span class="muted">׳׳¦׳‘ ׳¢׳¨׳™׳›׳”</span><strong>${payload.seller_actions.edit_locked ? "׳ ׳¢׳•׳ ׳׳—׳¨׳™ ׳₪׳¨׳¡׳•׳" : "׳˜׳™׳•׳˜׳” ׳ ׳™׳×׳ ׳× ׳׳¢׳¨׳™׳›׳”"}</strong></div>
        <div class="summary-item"><span class="muted">׳–׳”׳•׳× ׳”׳׳•׳›׳¨ ׳”׳₪׳¢׳™׳׳”</span><strong>${esc(activeSellerDisplayName)}</strong><p class="small muted"><span class="mono">${esc(activeSellerId)}</span></p></div>
        <div class="summary-item"><span class="muted">׳”׳׳™׳ ׳§ ׳”׳™׳©׳™׳¨</span><strong class="mono">${esc(payload.seller_profile?.direct_link || `/app/deal/${deal.deal_id}`)}</strong></div>
        <div class="summary-item"><span class="muted">׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳”</span><strong>${num((payload.delivery_options || []).length)}</strong></div>
        <div class="summary-item"><span class="muted">׳ ׳•׳¦׳¨׳” ׳‘-</span><strong>${dt(deal.created_at)}</strong></div>
        <div class="summary-item"><span class="muted">׳׳•׳¢׳“ ׳¡׳’׳™׳¨׳”</span><strong>${dt(deal.deadline)}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳”</h2>
          <p class="muted section-intro">׳׳׳” ׳”׳׳₪׳©׳¨׳•׳™׳•׳× ׳©׳™׳¨׳׳• ׳׳§׳•׳ ׳” ׳‘׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳•׳©׳™׳™׳©׳׳¨׳• ׳¢׳ ׳›׳ ׳”׳¦׳˜׳¨׳₪׳•׳×.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>׳׳₪׳©׳¨׳•׳™׳•׳×</span><strong>${num((payload.delivery_options || []).length)}</strong></span>
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
      ` : `<p class="muted">׳׳ ׳”׳•׳’׳“׳¨׳• ׳¢׳“׳™׳™׳ ׳׳₪׳©׳¨׳•׳™׳•׳× ׳§׳‘׳׳” ׳׳¢׳¡׳§׳” ׳”׳–׳׳×.</p>`}
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>׳׳©׳×׳×׳₪׳™׳</h2>
          <p class="muted section-intro">׳›׳׳ ׳¨׳•׳׳™׳ ׳׳™ ׳›׳‘׳¨ ׳ ׳¨׳©׳, ׳׳™׳–׳” ׳׳•׳₪׳ ׳§׳‘׳׳” ׳ ׳‘׳—׳¨, ׳•׳׳” ׳׳¦׳‘ ׳”׳”׳©׳×׳×׳₪׳•׳× ׳•׳”׳×׳₪׳™׳¡׳” ׳”׳›׳¡׳₪׳™׳×.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>׳׳©׳×׳×׳₪׳™׳</span><strong>${num(payload.participants.length)}</strong></span>
        </div>
      </div>
      ${payload.participants.length ? renderTablePanel("׳¨׳©׳™׳׳× ׳׳©׳×׳×׳₪׳™׳", "׳–׳” ׳”׳׳§׳•׳ ׳׳–׳”׳•׳× ׳׳”׳¨ ׳׳™ ׳‘׳₪׳ ׳™׳, ׳‘׳׳™׳–׳” ׳¡׳˜׳˜׳•׳¡, ׳•׳׳™׳₪׳” ׳™׳© ׳—׳¨׳™׳’׳•׳× ׳©׳¦׳¨׳™׳ ׳׳”׳¡׳‘׳™׳¨.", payload.participants, ["participant_id", "buyer_id", "qty", "delivery_method_label", "delivery_cost", "buyer_state", "money_state", "created_at"]) : `<div class="empty-surface"><p class="muted">׳¢׳“׳™׳™׳ ׳׳™׳ ׳׳¦׳˜׳¨׳₪׳™׳ ׳׳¢׳¡׳§׳” ׳”׳–׳׳×.</p></div>`}
    </section>
    <section class="card section stack">
      <div class="section-header">
        <div class="stack compact compact-section">
          <h2>׳ ׳™׳¡׳™׳•׳ ׳•׳× ׳—׳™׳•׳‘</h2>
          <p class="muted section-intro">׳”׳׳–׳•׳¨ ׳”׳–׳” ׳ ׳›׳ ׳¡ ׳׳₪׳¢׳•׳׳” ׳›׳©׳”׳¢׳¡׳§׳” ׳׳’׳™׳¢׳” ׳׳©׳׳‘ ׳”׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳׳• ׳׳׳¡׳׳•׳ ׳”׳©׳׳׳”.</p>
        </div>
        <div class="pill-row">
          <span class="stat-pill"><span>׳ ׳™׳¡׳™׳•׳ ׳•׳×</span><strong>${num(payload.payment_attempts.length)}</strong></span>
        </div>
      </div>
      ${payload.payment_attempts.length ? renderTablePanel("׳ ׳™׳¡׳™׳•׳ ׳•׳× ׳—׳™׳•׳‘ ׳׳—׳¨׳•׳ ׳™׳", "׳›׳׳ ׳‘׳•׳“׳§׳™׳ ׳׳ ׳™׳© ׳׳¢׳‘׳¨ ׳×׳§׳™׳ ׳‘׳™׳ ׳ ׳™׳¡׳™׳•׳, ׳×׳•׳¦׳׳”, ׳•׳–׳׳ ׳”׳₪׳¢׳•׳׳” ׳”׳׳—׳¨׳•׳.", payload.payment_attempts, ["attempt_type", "correlation_id", "result_class", "created_at"]) : `<div class="empty-surface"><p class="muted">׳¢׳“׳™׳™׳ ׳׳ ׳ ׳¨׳©׳׳• ׳ ׳™׳¡׳™׳•׳ ׳•׳× ׳—׳™׳•׳‘.</p></div>`}
    </section>
    <section class="card section stack">
      <h2>׳§׳‘׳׳•׳× ׳•׳¡׳™׳›׳•׳ ׳¢׳¡׳§׳” ׳©׳”׳•׳©׳׳׳”</h2>
      <p class="muted">${esc(receiptsNote)}</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">׳׳¦׳‘ ׳׳¡׳׳›׳™׳</span><strong>${esc(receipts.status)}</strong></div>
        <div class="summary-item"><span class="muted">׳‘׳¨׳•׳˜׳•</span><strong>${currency(receipts.summary.gross_amount)}</strong></div>
        <div class="summary-item"><span class="muted">׳¢׳׳׳× ׳¡׳™׳˜׳•׳</span><strong>${currency(receipts.summary.siton_fee_amount)}</strong></div>
        <div class="summary-item summary-spotlight"><span class="muted">׳ ׳˜׳• ׳׳׳•׳›׳¨</span><strong>${currency(receipts.summary.seller_net_amount)}</strong></div>
        <div class="summary-item"><span class="muted">׳׳¡׳׳›׳™׳</span><strong>${num(receipts.summary.receipt_document_count)}</strong></div>
      </div>
      ${deal.state === "Completed" ? `
        <div class="summary-item stack">
          <div class="actions spread">
            <div>
              <strong>ייצוא עסקה</strong>
              <p class="small muted">כולל קונים זכאים, פרטי אספקה, כמויות, גבייה, עמלת סיטון ונטו למוכר.</p>
            </div>
            <button class="primary" type="button" data-inline-action="seller-excel-export" data-deal-id="${esc(deal.deal_id)}">הורד Excel עסקה</button>
          </div>
        </div>
      ` : ""}
      ${receipts.documents.length ? renderTablePanel("מסמכי עסקה לפי רישום אמיתי", "הטבלה נשענת רק על רשומות invoice_documents אמיתיות. אם עדיין לא נוצרה רשומה, יוצג במפורש שאין מסמך מונפק.", receipts.documents, ["document_id", "document_status", "issued_at", "participant_id", "buyer_id", "qty", "gross_amount", "share_code", "affiliate_name"]) : `<div class="empty-surface"><p class="muted">׳¢׳“׳™׳™׳ ׳׳™׳ ׳¨׳©׳•׳׳•׳× ׳׳¡׳׳ ׳׳׳™׳×׳™׳•׳× ׳׳¢׳¡׳§׳” ׳”׳–׳׳×.</p></div>`}
      <p class="small muted">׳–׳”׳• ׳׳©׳˜׳— ׳₪׳ ׳™׳׳™ ׳׳׳•׳›׳ ׳•׳× ׳—׳©׳‘׳•׳ ׳׳™׳×, ׳׳ ׳׳¡׳׳ ׳—׳™׳¦׳•׳ ׳™ ׳©׳”׳•׳₪׳§ ׳‘׳₪׳•׳¢׳.</p>
    </section>
    ${deal.state === "Completed" ? renderDeliveryHandoffSection(deal.deal_id) : ""}
  `;
}

function renderAffiliatePage() {
  const payload = state.affiliatePayload?.affiliate_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("מרכז ההפצה לא זמין", "לא הצלחנו לטעון עכשיו את מרכז ההפצה.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="badge warning">גישה תפעולית</span>
        <span class="eyebrow">הפצה וייחוס</span>
        <h1>מרכז הפצה למדידה, ייחוס ושיתוף לינקים</h1>
        <p class="muted">המשטח הזה מרכז את מצב הייחוס, הקמפיינים והאימות של המפיץ. המפיץ הוא ערוץ מדידה והפצה בלבד — אין כאן עמלה, יתרה, התחשבנות או תשלום, לא כעת ולא בעתיד.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">שם תצוגה</span><strong>${esc(payload.display_name || "לא זמין")}</strong></div>
          <div class="summary-item"><span class="muted">מצב ייחוס</span><strong>${esc(payload.attribution_status)}</strong></div>
          <div class="summary-item"><span class="muted">מצב אימות</span><strong>${esc(payload.verification_status)}</strong></div>
          <div class="summary-item"><span class="muted">קמפיינים פעילים</span><strong>${num(payload.totals.active_campaigns)}</strong></div>
        </div>
        <div class="info-strip tone-info">
          <strong>גבול המודל החי</strong>
          <p>${esc(payload.note)}</p>
        </div>
        <div class="info-strip tone-info">
          <strong>גבולות השטח של המפיץ</strong>
          <p>אין חשיפה של פרטי קונים, אין תזרים כספי ואין פרופיל תשלום. התצוגה מצטברת בלבד — קליקים, ייחוסים, יחידות וקמפיינים.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">קונים משויכים</span><strong>${num(payload.totals.total_attributions)}</strong></div>
        <div class="summary-item"><span class="muted">יחידות משויכות</span><strong>${num(payload.totals.total_units)}</strong></div>
        <div class="summary-item"><span class="muted">הערת אימות</span><strong>${esc(payload.verification_surface.admin_note || "אין הערת אימות פנימית")}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>סיכום ייחוסים</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">קונים משויכים</span><strong>${num(payload.totals.total_attributions)}</strong></div>
        <div class="summary-item"><span class="muted">יחידות משויכות</span><strong>${num(payload.totals.total_units)}</strong></div>
        <div class="summary-item"><span class="muted">קמפיינים פעילים</span><strong>${num(payload.totals.active_campaigns)}</strong></div>
        <div class="summary-item"><span class="muted">אימות</span><strong>${esc(payload.verification_surface.status || payload.verification_status)}</strong></div>
      </div>
      <p class="small muted">המשטח הזה מרכז את ביצועי ההפצה, סטטוס האימות ומוכנות המסלול. הוא לא מציג כסף חי ולא יוצר מצג של תשלום שכבר בוצע.</p>
    </section>
    <section class="card section stack">
      <h2>קמפיינים זמינים למפיץ</h2>
      <div class="card-list">
        ${payload.campaigns.map((campaign) => `
          <article class="summary-item">
            <span class="muted">${esc(campaign.state)}</span>
            <h3>${esc(campaign.title)}</h3>
            <p class="small muted">קונים משויכים: ${num(campaign.attributed_buyers)} · יחידות משויכות: ${num(campaign.attributed_units)}</p>
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
    <section class="hero">
      <article class="card hero-main stack">
        <span class="badge warning">גישה תפעולית</span>
        <span class="eyebrow">ניהול, תמיכה ובקרה</span>
        <h1>מרכז התפעול של סיטון</h1>
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
    <section class="card section stack">
      <h2>עסקאות חריגות</h2>
      ${payload.exceptional_deals.length ? `<div class="card-list">${payload.exceptional_deals.map(renderAdminDealCard).join("")}</div>` : `<div class="empty-surface"><p class="muted">לא חזרו עסקאות חריגות כרגע.</p></div>`}
    </section>
    ${renderSellerEnforcementAdminSection(sellerRisk)}
    <section class="card section stack">
      <h2>תוצאות חיפוש תפעולי</h2>
      <p class="small muted">החיפוש מפנה ישירות לפרופיל העסקה, המשתתף או המשתמש. אין כאן dump טכני של מזהים בלי מסלול המשך.</p>
      ${renderAdminSearchResults(payload.search_results)}
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
    <section class="card section stack">
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
        </div>
      </div>
      <p class="small muted">עודכן לאחרונה: ${dt(mission.generated_at)} · רענון אוטומטי מתבצע כל ${num(Math.round(POLL_INTERVAL_MS / 1000))} שניות.</p>
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
  entity_type: "׳¡׳•׳’ ׳™׳©׳•׳×",
  entity_id: "׳׳–׳”׳” ׳™׳©׳•׳×",
  headline: "׳›׳•׳×׳¨׳×",
  state: "׳׳¦׳‘",
  detail: "׳₪׳™׳¨׳•׳˜",
  deal_id: "׳׳–׳”׳” ׳¢׳¡׳§׳”",
  price_per_unit: "׳׳—׳™׳¨ ׳׳™׳—׳™׳“׳”",
  min_units: "׳׳™׳ ׳™׳׳•׳ ׳™׳—׳™׳“׳•׳×",
  max_units: "׳׳§׳¡׳™׳׳•׳ ׳™׳—׳™׳“׳•׳×",
  threshold_units: "׳™׳¢׳“ ׳‘׳¡׳™׳¡",
  deadline: "׳׳•׳¢׳“ ׳¡׳’׳™׳¨׳”",
  platform_fee_rate: "עמלת סיטון",
  participant_id: "׳׳–׳”׳” ׳׳©׳×׳×׳£",
  buyer_id: "׳׳–׳”׳” ׳§׳•׳ ׳”",
  qty: "׳›׳׳•׳×",
  buyer_state: "׳׳¦׳‘ ׳׳©׳×׳×׳£",
  money_state: "׳׳¦׳‘ ׳›׳¡׳₪׳™",
  created_at: "׳ ׳•׳¦׳¨ ׳‘-",
  event_type: "׳¡׳•׳’ ׳׳™׳¨׳•׳¢",
  status: "׳¡׳˜׳˜׳•׳¡",
  available_at: "׳–׳׳™׳ ׳-",
  attempt_type: "׳¡׳•׳’ ׳ ׳™׳¡׳™׳•׳",
  correlation_id: "׳׳–׳”׳” ׳§׳•׳¨׳׳¦׳™׳”",
  result_class: "׳¡׳™׳•׳•׳’ ׳×׳•׳¦׳׳”",
  delivery_method_label: "׳׳•׳₪׳ ׳§׳‘׳׳”",
  delivery_cost: "׳¢׳׳•׳× ׳§׳‘׳׳”",
  receipt_id: "׳׳–׳”׳” ׳§׳‘׳׳”",
  document_id: "׳׳–׳”׳” ׳׳¡׳׳",
  document_status: "׳׳¦׳‘ ׳׳¡׳׳",
  notification_status: "סטטוס התראה",
  outbox_status: "סטטוס תור",
  support_status: "סטטוס פנייה",
  provider_document_id: "׳׳–׳”׳” ׳¡׳₪׳§",
  share_code: "׳§׳•׳“ ׳©׳™׳×׳•׳£",
  display_name: "׳©׳ ׳×׳¦׳•׳’׳”",
  issue_note: "׳”׳¢׳¨׳× ׳×׳§׳׳”",
  updated_at: "׳¢׳•׳“׳›׳ ׳‘-",
  ticket_id: "׳׳–׳”׳” ׳₪׳ ׳™׳™׳”",
  scope_type: "׳¡׳•׳’ ׳™׳©׳•׳×",
  scope_key: "׳׳–׳”׳” ׳™׳©׳•׳×",
  title: "׳›׳•׳×׳¨׳×",
  priority: "׳¢׳“׳™׳₪׳•׳×",
  state_type: "׳¡׳•׳’ ׳׳¦׳‘",
  from_state: "׳׳׳¦׳‘",
  to_state: "׳׳׳¦׳‘",
  action_name: "׳₪׳¢׳•׳׳”",
  deal_state: "׳׳¦׳‘ ׳¢׳¡׳§׳”",
  gross_amount: "׳¡׳›׳•׳ ׳‘׳¨׳•׳˜׳•",
  affiliate_name: "׳©׳ ׳©׳•׳×׳£"
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
  if (normalized === "internal" || normalized === "internal-runtime") return "׳¡׳‘׳™׳‘׳× ׳¢׳‘׳•׳“׳” ׳₪׳ ׳™׳׳™׳×";
  if (normalized === "production") return "׳¡׳‘׳™׳‘׳× ׳™׳™׳¦׳•׳¨";
  if (normalized === "staging") return "׳¡׳‘׳™׳‘׳× ׳‘׳“׳™׳§׳•׳×";
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
    return { tone: "warning", title: "׳׳•׳¢׳“ ׳”׳¡׳’׳™׳¨׳” ׳׳ ׳–׳׳™׳", detail: "׳›׳“׳׳™ ׳׳‘׳“׳•׳§ ׳©׳”׳¢׳¡׳§׳” ׳ ׳©׳׳¨׳” ׳¢׳ ׳—׳׳•׳ ׳”׳¦׳˜׳¨׳₪׳•׳× ׳×׳§׳™׳." };
  }
  if (["Completed", "Failed", "Cancelled"].includes(String(stateName || ""))) {
    return { tone: stateName === "Completed" ? "success" : "danger", title: stateName === "Completed" ? "׳”׳¢׳¡׳§׳” ׳›׳‘׳¨ ׳ ׳¡׳’׳¨׳” ׳‘׳”׳¦׳׳—׳”" : "׳”׳¢׳¡׳§׳” ׳ ׳¡׳’׳¨׳” ׳׳׳ ׳”׳׳©׳", detail: "׳׳™׳ ׳¢׳•׳“ ׳—׳׳•׳ ׳”׳¦׳˜׳¨׳₪׳•׳× ׳₪׳×׳•׳—, ׳•׳”׳׳¡׳ ׳ ׳©׳׳¨ ׳›׳›׳׳™ ׳‘׳§׳¨׳” ׳•׳׳¢׳§׳‘." };
  }
  if (diff <= 0) {
    return { tone: "danger", title: "׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳›׳‘׳¨ ׳ ׳¡׳’׳¨", detail: "׳›׳“׳׳™ ׳׳”׳×׳׳§׳“ ׳¢׳›׳©׳™׳• ׳¨׳§ ׳‘׳׳¢׳§׳‘, ׳‘׳—׳™׳•׳‘ ׳׳• ׳‘׳¡׳’׳™׳¨׳” ׳”׳×׳₪׳¢׳•׳׳™׳× ׳©׳ ׳”׳¢׳¡׳§׳”." };
  }
  const hours = diff / 3_600_000;
  if (hours <= 6) {
    return { tone: "danger", title: "׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳§׳¨׳•׳‘ ׳׳¡׳™׳•׳", detail: `׳ ׳•׳×׳¨׳• ׳‘׳¢׳¨׳ ${Math.max(1, Math.round(hours))} ׳©׳¢׳•׳× ׳׳¡׳’׳™׳¨׳× ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™.` };
  }
  if (hours <= 24) {
    return { tone: "warning", title: "׳”׳¢׳¡׳§׳” ׳ ׳›׳ ׳¡׳× ׳׳™׳•׳ ׳”׳׳—׳¨׳•׳ ׳©׳׳”", detail: "׳–׳” ׳”׳–׳׳ ׳׳—׳–׳§ ׳”׳₪׳¦׳”, ׳׳¢׳§׳•׳‘ ׳׳—׳¨׳™ ׳§׳¦׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳•׳׳•׳•׳“׳ ׳©׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳—׳“ ׳•׳‘׳¨׳•׳¨." };
  }
  return { tone: "success", title: "׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳¢׳“׳™׳™׳ ׳₪׳×׳•׳—", detail: "׳™׳© ׳¢׳“׳™׳™׳ ׳–׳׳ ׳׳”׳₪׳¦׳” ׳•׳׳¦׳‘׳™׳¨׳× ׳”׳¦׳˜׳¨׳₪׳•׳™׳•׳× ׳׳₪׳ ׳™ ׳”׳¡׳’׳™׳¨׳”." };
}

function sellerNextFocus(deal, totals) {
  if (deal?.state === "Draft") {
    return { title: "׳׳”׳©׳׳™׳ ׳˜׳™׳•׳˜׳” ׳•׳׳₪׳¨׳¡׳ ׳“׳£ ׳—׳™", detail: "׳׳₪׳ ׳™ ׳₪׳¨׳¡׳•׳ ׳›׳“׳׳™ ׳׳¢׳‘׳•׳¨ ׳©׳•׳‘ ׳¢׳ ׳׳—׳™׳¨, ׳“׳“׳׳™׳™׳ ׳•׳׳₪׳©׳¨׳•׳™׳•׳× ׳”׳§׳‘׳׳”, ׳•׳׳– ׳׳”׳•׳¦׳™׳ ׳׳™׳ ׳§ ׳׳™׳©׳™ ׳׳”׳₪׳¦׳”." };
  }
  if (deal?.state === "PendingTarget" || deal?.state === "TargetReached") {
    return { title: "׳׳”׳׳©׳™׳ ׳”׳₪׳¦׳” ׳•׳׳¢׳§׳•׳‘ ׳׳—׳¨׳™ ׳”׳§׳¦׳‘", detail: "׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳›׳‘׳¨ ׳—׳™. ׳¢׳›׳©׳™׳• ׳—׳©׳•׳‘ ׳׳¨׳׳•׳× ׳§׳¦׳‘ ׳”׳¦׳˜׳¨׳₪׳•׳×, ׳—׳׳•׳ ׳–׳׳ ׳•׳§׳™׳‘׳•׳׳× ׳©׳ ׳•׳×׳¨׳”." };
  }
  if (deal?.state === "ReadyForCharging" || deal?.state === "Charging" || deal?.state === "CompletionWindow") {
    return { title: "׳׳”׳×׳׳§׳“ ׳‘׳‘׳§׳¨׳” ׳×׳₪׳¢׳•׳׳™׳×", detail: "׳›׳׳ ׳‘׳•׳“׳§׳™׳ ׳—׳™׳•׳‘׳™׳, ׳׳¡׳׳›׳™׳ ׳•׳׳¡׳™׳¨׳”, ׳•׳׳ ׳₪׳•׳×׳—׳™׳ ׳¢׳•׳“ ׳¢׳¨׳™׳›׳” ׳¢׳ ׳”׳¢׳¡׳§׳” ׳¢׳¦׳׳”." };
  }
  if ((totals?.live_deals || 0) > 0) {
    return { title: "׳™׳© ׳›׳‘׳¨ ׳¢׳¡׳§׳׳•׳× ׳—׳™׳•׳× ׳©׳“׳•׳¨׳©׳•׳× ׳×׳©׳•׳׳× ׳׳‘", detail: "׳”׳“׳©׳‘׳•׳¨׳“ ׳ ׳•׳¢׳“ ׳׳¢׳–׳•׳¨ ׳׳ ׳׳–׳”׳•׳× ׳׳” ׳“׳•׳¨׳© ׳”׳₪׳¦׳”, ׳׳” ׳׳×׳§׳“׳, ׳•׳׳” ׳›׳‘׳¨ ׳ ׳¡׳’׳¨." };
  }
  return { title: "׳׳‘׳ ׳•׳× ׳׳× ׳”׳“׳£ ׳”׳¨׳׳©׳•׳ ׳©׳׳ ׳‘׳¦׳•׳¨׳” ׳—׳“׳”", detail: "׳₪׳×׳™׳—׳× ׳¢׳¡׳§׳” ׳˜׳•׳‘׳” ׳׳×׳—׳™׳׳” ׳‘׳›׳•׳×׳¨׳× ׳‘׳¨׳•׳¨׳”, ׳׳—׳™׳¨ ׳׳“׳•׳™׳§, ׳—׳׳•׳ ׳–׳׳ ׳ ׳›׳•׳ ׳•׳׳•׳₪׳ ׳§׳‘׳׳” ׳₪׳©׳•׳˜ ׳׳”׳‘׳ ׳”." };
}

function normalizeSurfaceNote(note, kind) {
  const value = String(note || "").trim();
  if (!value) return "";
  if (kind === "receipts") {
    if (value.includes("Receipt visibility relies on actual invoice_documents rows")) {
      return "׳׳¡׳׳›׳™ ׳¢׳¡׳§׳” ׳׳•׳¦׳’׳™׳ ׳¨׳§ ׳׳ ׳§׳™׳™׳׳× ׳¨׳©׳•׳׳” ׳׳׳™׳×׳™׳× ׳‘-invoice_documents. ׳׳©׳׳™׳ ׳¢׳“׳™׳™׳ ׳¨׳©׳•׳׳” ׳›׳–׳׳×, ׳׳•׳¦׳’ ׳‘׳׳₪׳•׳¨׳© ׳©׳˜׳¨׳ ׳”׳•׳ ׳₪׳§ ׳׳¡׳׳.";
    }
    if (value.includes("Receipts are generated only")) {
      return "׳§׳‘׳׳•׳× ׳ ׳•׳¦׳¨׳•׳× ׳¨׳§ ׳¢׳‘׳•׳¨ ׳׳©׳×׳×׳₪׳™׳ ׳©׳—׳•׳™׳‘׳• ׳‘׳”׳¦׳׳—׳” ׳׳• ׳”׳•׳©׳׳׳• ׳‘׳׳¡׳׳•׳ ׳©׳—׳–׳•׳¨, ׳•׳¨׳§ ׳׳—׳¨׳™ ׳©׳”׳¢׳¡׳§׳” ׳׳’׳™׳¢׳” ׳׳”׳©׳׳׳” ׳׳׳׳”.";
    }
    if (value.includes("Receipts stay blocked until")) {
      return "׳§׳‘׳׳•׳× ׳ ׳©׳׳¨׳•׳× ׳—׳¡׳•׳׳•׳× ׳¢׳“ ׳©׳”׳¢׳¡׳§׳” ׳׳’׳™׳¢׳” ׳׳׳¦׳‘ ׳”׳•׳©׳׳׳”. ׳¢׳¡׳§׳׳•׳× ׳©׳ ׳›׳©׳׳• ׳׳• ׳‘׳•׳˜׳׳• ׳׳™׳ ׳ ׳׳™׳™׳¦׳¨׳•׳× ׳׳¡׳׳›׳™ ׳׳•׳›׳¨.";
    }
  }
  if (kind === "delivery") {
    if (value.includes("Only successfully charged or recovered buyers")) {
      return "׳ ׳™׳”׳•׳ ׳׳¡׳™׳¨׳” ׳ ׳₪׳×׳— ׳¨׳§ ׳׳§׳•׳ ׳™׳ ׳©׳—׳•׳™׳‘׳• ׳‘׳”׳¦׳׳—׳” ׳׳• ׳”׳•׳©׳׳׳• ׳‘׳׳¡׳׳•׳ ׳©׳—׳–׳•׳¨. ׳‘׳¡׳‘׳™׳‘׳× ׳”׳“׳’׳׳” ׳–׳”׳• ׳׳©׳˜׳— ׳‘׳§׳¨׳” ׳₪׳ ׳™׳׳™ ׳•׳׳ ׳—׳™׳‘׳•׳¨ ׳—׳™ ׳׳—׳‘׳¨׳× ׳©׳™׳׳•׳—.";
    }
    if (value.includes("Delivery operations become active only")) {
      return "׳ ׳™׳”׳•׳ ׳”׳׳¡׳™׳¨׳” ׳”׳•׳₪׳ ׳׳₪׳¢׳™׳ ׳¨׳§ ׳׳—׳¨׳™ ׳©׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳” ׳‘׳”׳¦׳׳—׳”.";
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
        <span class="badge">${num(rows.length)} ׳©׳•׳¨׳•׳×</span>
      </div>
      ${renderRowsTable(rows, columns)}
    </div>
  `;
}

function renderRowsTable(rows, columns) {
  return `
    <div class="table-like">
      <div class="table-row table-head">${columns.map((column) => `<div class="table-cell"><span class="table-cell-label">׳©׳“׳”</span><span class="table-cell-value">${esc(formatInternalTableHeader(column))}</span></div>`).join("")}</div>
      ${rows.map((row) => `<div class="table-row">${columns.map((column) => `<div class="table-cell"><span class="table-cell-label">${esc(formatInternalTableHeader(column))}</span><span class="table-cell-value">${esc(formatCell(row[column], column))}</span></div>`).join("")}</div>`).join("")}
    </div>
  `;
}

function formatCell(value, column = "") {
  if (value === null || value === undefined || value === "") return "׳׳ ׳–׳׳™׳";
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
    pending: "׳׳׳×׳™׳ ׳׳”׳ ׳₪׳§׳”",
    processing: "׳‘׳¢׳™׳‘׳•׳“",
    issued: "׳”׳•׳ ׳₪׳§",
    failed: "׳ ׳›׳©׳",
    skipped: "׳ ׳“׳׳’"
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
        <a class="button primary" href="${href}" data-nav="${href}">׳—׳–׳¨׳” ׳׳׳¡׳׳•׳ ׳”׳ ׳›׳•׳</a>
        <a class="button secondary" href="/app" data-nav="/app">׳׳¢׳׳•׳“ ׳”׳‘׳™׳×</a>
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
        <a class="button secondary" href="/app" data-nav="/app">׳—׳–׳¨׳” ׳׳׳¡׳ ׳”׳‘׳™׳×</a>
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
      ${!isInternalSurface ? `<div class="route-chip">׳׳•׳›׳¨ ׳₪׳¢׳™׳: ${esc(sellerContext.display_name)}</div>` : ""}
      ${isInternalSurface ? `<div class="route-chip">׳׳¡׳ ׳₪׳ ׳™׳׳™</div>` : ""}
      <a href="/app" data-nav="/app" class="button secondary">׳¡׳™׳˜׳•׳</a>
      <div class="route-chip">${ROUTE_LABELS[state.route.name] || "׳׳¡׳׳•׳ ׳§׳•׳ ׳”"}</div>
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
          <span class="eyebrow">׳׳¢׳˜׳₪׳× ׳׳׳•׳ ׳¦׳™׳‘׳•׳¨׳™׳×</span>
          <h2>׳׳™׳“׳¢ ׳׳—׳™׳™׳‘ ׳‘׳¨׳•׳¨, ׳‘׳׳™ ׳׳”׳¢׳׳™׳¡ ׳¢׳ ׳”׳׳¡׳׳•׳</h2>
          <p class="muted">׳‘׳¡׳™׳˜׳•׳ ׳”׳§׳•׳ ׳” ׳׳×׳§׳“׳ ׳“׳¨׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳¢׳¡׳§׳”. ׳‘׳©׳׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳× ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“, ׳•׳”׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳׳×׳‘׳¦׳¢ ׳¨׳§ ׳׳ ׳”׳¢׳¡׳§׳” ׳ ׳¡׳’׳¨׳× ׳‘׳”׳¦׳׳—׳”. ׳׳ ׳”׳¢׳¡׳§׳” ׳׳ ׳ ׳¡׳’׳¨׳×, ׳”׳׳¡׳’׳¨׳× ׳׳©׳×׳—׳¨׳¨׳×, ׳׳×׳‘׳˜׳׳× ׳׳• ׳׳ ׳”׳•׳₪׳›׳× ׳׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳׳₪׳™ ׳׳¦׳‘ ׳”׳¢׳¡׳§׳”.</p>
        </div>
        <div class="trust-footer-panel">
          <div class="summary-item summary-spotlight">
            <span class="muted">׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘</span>
            <strong>׳×׳ ׳׳™ ׳©׳™׳׳•׳©, ׳₪׳¨׳˜׳™׳•׳×, ׳‘׳™׳˜׳•׳׳™׳ ׳•׳”׳—׳–׳¨׳™׳, ׳™׳¦׳™׳¨׳× ׳§׳©׳¨</strong>
            <p class="small muted">׳”׳¢׳׳•׳“׳™׳ ׳”׳׳׳” ׳–׳׳™׳ ׳™׳ ׳׳›׳ ׳׳©׳˜׳— ׳¦׳™׳‘׳•׳¨׳™ ׳¨׳׳•׳•׳ ׳˜׳™ ׳›׳“׳™ ׳©׳׳ ׳™׳”׳™׳” ׳₪׳¢׳¨ ׳‘׳™׳ ׳”׳”׳‘׳˜׳—׳” ׳׳‘׳™׳ ׳׳” ׳©׳”׳§׳•׳ ׳” ׳¨׳•׳׳” ׳‘׳₪׳•׳¢׳.</p>
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
      <a href="/app/terms" data-nav="/app/terms">׳×׳ ׳׳™ ׳©׳™׳׳•׳©</a>
      <a href="/app/privacy" data-nav="/app/privacy">׳׳“׳™׳ ׳™׳•׳× ׳₪׳¨׳˜׳™׳•׳×</a>
      <a href="/app/refunds" data-nav="/app/refunds">׳‘׳™׳˜׳•׳׳™׳ ׳•׳”׳—׳–׳¨׳™׳</a>
      <a href="/app/contact" data-nav="/app/contact">׳™׳¦׳™׳¨׳× ׳§׳©׳¨</a>
    </div>
  `;
}

function renderLegalReferenceStrip(context) {
  const detail = context === "payment"
    ? "׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳׳₪׳©׳¨ ׳׳¨׳׳•׳× ׳›׳׳ ׳‘׳“׳™׳•׳§ ׳׳” ׳׳—׳™׳™׳‘, ׳׳™׳ ׳ ׳©׳׳¨׳× ׳”׳₪׳¨׳˜׳™׳•׳×, ׳•׳׳” ׳§׳•׳¨׳” ׳׳ ׳”׳¢׳¡׳§׳” ׳׳ ׳ ׳¡׳’׳¨׳×."
    : context === "tracking"
      ? "׳’׳ ׳׳—׳¨׳™ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳ ׳©׳׳¨ ׳–׳׳™׳, ׳›׳•׳׳ ׳׳™׳ ׳₪׳•׳ ׳™׳ ׳•׳׳™׳₪׳” ׳¨׳•׳׳™׳ ׳׳” ׳§׳•׳¨׳” ׳¢׳ ׳”׳׳¡׳’׳¨׳×."
      : context === "confirmation"
        ? "׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳”, ׳׳‘׳ ׳’׳ ׳›׳׳ ׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳ ׳©׳׳¨ ׳ ׳’׳™׳© ׳•׳‘׳¨׳•׳¨."
        : "׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳ ׳’׳™׳© ׳›׳‘׳¨ ׳׳©׳׳‘ ׳”׳“׳£ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳›׳“׳™ ׳׳™׳¦׳•׳¨ ׳׳׳•׳ ׳¢׳•׳“ ׳׳₪׳ ׳™ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×.";
  return `
    <div class="info-strip legal-strip">
      <strong>׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳•׳”׳§׳©׳¨</strong>
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
          <div class="summary-item"><span class="muted">׳›׳ ׳™׳¡׳” ׳׳׳¡׳׳•׳</span><strong>׳“׳¨׳ ׳׳™׳ ׳§ ׳™׳©׳™׳¨ ׳׳¢׳¡׳§׳”</strong></div>
          <div class="summary-item"><span class="muted">׳‘׳©׳׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×</span><strong>׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“</strong></div>
          <div class="summary-item"><span class="muted">׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳</span><strong>׳¨׳§ ׳׳ ׳”׳¢׳¡׳§׳” ׳ ׳¡׳’׳¨׳× ׳‘׳”׳¦׳׳—׳”</strong></div>
          <div class="summary-item"><span class="muted">׳׳™׳₪׳” ׳¨׳•׳׳™׳ ׳”׳›׳•׳</span><strong>׳‘׳“׳£ ׳”׳¢׳¡׳§׳”, ׳‘׳׳¢׳§׳‘ ׳•׳‘׳¢׳׳•׳“׳™׳ ׳”׳׳׳”</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack legal-side">
        <div class="summary-item summary-spotlight">
          <span class="muted">׳ ׳™׳•׳•׳˜ ׳׳”׳™׳¨</span>
          <strong>׳¢׳׳•׳“׳™ trust ׳¦׳™׳‘׳•׳¨׳™׳™׳</strong>
          <p class="small muted">׳”׳¢׳׳•׳“׳™׳ ׳”׳׳׳” ׳”׳ ׳©׳›׳‘׳× ׳”׳׳׳•׳ ׳”׳‘׳¡׳™׳¡׳™׳× ׳©׳ ׳”׳׳•׳¦׳¨ ׳”׳¦׳™׳‘׳•׳¨׳™, ׳•׳׳ placeholder ׳₪׳ ׳™׳׳™.</p>
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
    "׳×׳ ׳׳™ ׳©׳™׳׳•׳©",
    "׳©׳™׳׳•׳© ׳‘׳₪׳׳˜׳₪׳•׳¨׳׳”",
    "׳×׳ ׳׳™ ׳”׳©׳™׳׳•׳© ׳׳’׳“׳™׳¨׳™׳ ׳׳™׳ ׳׳©׳×׳׳©׳™׳ ׳‘׳׳©׳˜׳—׳™׳ ׳”׳¦׳™׳‘׳•׳¨׳™׳™׳ ׳©׳ ׳¡׳™׳˜׳•׳, ׳׳”׳• ׳׳•׳₪׳™ ׳”׳¢׳¡׳§׳” ׳”׳§׳‘׳•׳¦׳×׳™׳×, ׳•׳׳™׳₪׳” ׳¢׳•׳‘׳¨׳× ׳”׳׳—׳¨׳™׳•׳× ׳‘׳™׳ ׳”׳₪׳׳˜׳₪׳•׳¨׳׳”, ׳”׳׳•׳›׳¨ ׳•׳”׳§׳•׳ ׳”.",
    [
      { title: "׳׳”׳• ׳”׳©׳™׳¨׳•׳×", body: "׳¡׳™׳˜׳•׳ ׳”׳™׳ ׳₪׳׳˜׳₪׳•׳¨׳׳” ׳׳ ׳™׳”׳•׳ ׳¢׳¡׳§׳׳•׳× ׳§׳‘׳•׳¦׳×׳™׳•׳× ׳׳‘׳•׳¡׳¡׳•׳× ׳׳™׳ ׳§. ׳”׳׳•׳›׳¨ ׳₪׳•׳×׳— ׳¢׳¡׳§׳”, ׳׳₪׳¨׳¡׳ ׳“׳£ ׳¢׳¡׳§׳” ׳¦׳™׳‘׳•׳¨׳™, ׳•׳”׳§׳•׳ ׳” ׳׳¦׳˜׳¨׳£ ׳“׳¨׳ ׳§׳™׳©׳•׳¨ ׳™׳©׳™׳¨ ׳•׳׳ ׳“׳¨׳ ׳§׳˜׳׳•׳’ ׳¦׳™׳‘׳•׳¨׳™ ׳₪׳×׳•׳—." },
      { title: "׳׳” ׳§׳•׳¨׳” ׳‘׳©׳׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×", body: "׳‘׳©׳׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳™׳ ׳₪׳¨׳˜׳™ ׳”׳׳¡׳׳•׳, ׳›׳•׳׳ ׳›׳׳•׳×, ׳׳•׳₪׳ ׳§׳‘׳׳” ׳•׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×. ׳׳™׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳¨׳§ ׳׳¢׳¦׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×. ׳”׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳׳×׳‘׳¦׳¢ ׳¨׳§ ׳׳ ׳”׳¢׳¡׳§׳” ׳ ׳¡׳’׳¨׳× ׳‘׳”׳¦׳׳—׳” ׳•׳‘׳”׳×׳׳ ׳׳׳¦׳‘ ׳”׳¢׳¡׳§׳”." },
      { title: "׳׳—׳¨׳™׳•׳× ׳”׳׳•׳›׳¨", body: "׳”׳׳•׳›׳¨ ׳׳—׳¨׳׳™ ׳׳ ׳›׳•׳ ׳•׳× ׳₪׳¨׳˜׳™ ׳”׳¢׳¡׳§׳”, ׳׳׳—׳™׳¨, ׳׳—׳׳•׳ ׳”׳–׳׳ ׳™׳, ׳׳׳₪׳©׳¨׳•׳™׳•׳× ׳”׳§׳‘׳׳”, ׳•׳׳×׳§׳©׳•׳¨׳× ׳”׳™׳©׳™׳¨׳” ׳”׳ ׳“׳¨׳©׳× ׳׳•׳ ׳”׳§׳•׳ ׳™׳ ׳‘׳׳¡׳’׳¨׳× ׳”׳¢׳¡׳§׳” ׳©׳₪׳¨׳¡׳." },
      { title: "אחריות סיטון והמוכר", body: "המוצר והאספקה באחריות המוכר. סיטון מספקת את מערכת העסקה, התיעוד, ניהול ההתחייבויות והעברת נתוני הזכאים למוכר; סיטון אינה מספקת את המוצר בעצמה." },
      { title: "כלל 90%", body: "עסקה תיחשב מוצלחת רק אם חויבו בפועל לפחות 90% מהמינימום שהוגדר. אם פחות מכך חויב בפועל, העסקה נכשלת לפי מנגנון המערכת." },
      { title: "לינקי הפצה", body: "לינקי הפצה הם ייחוס ומדידה בלבד. סיטון אינה מחשבת עמלה למפיצים ואינה משלמת למפיצים; כל הסכמה אחרת בין מוכר למפיץ נמצאת מחוץ למערכת." },
      { title: "׳׳—׳¨׳™׳•׳× ׳”׳§׳•׳ ׳”", body: "׳”׳§׳•׳ ׳” ׳׳—׳¨׳׳™ ׳׳׳¡׳•׳¨ ׳₪׳¨׳˜׳™׳ ׳ ׳›׳•׳ ׳™׳, ׳׳¢׳§׳•׳‘ ׳׳—׳¨ ׳׳¦׳‘ ׳”׳”׳©׳×׳×׳₪׳•׳× ׳‘׳׳¡׳ ׳”׳׳¢׳§׳‘, ׳•׳׳•׳•׳“׳ ׳©׳”׳›׳׳•׳× ׳•׳׳•׳₪׳ ׳”׳§׳‘׳׳” ׳©׳ ׳©׳׳¨׳• ׳׳›׳ ׳×׳•׳׳׳™׳ ׳׳× ׳¨׳¦׳•׳ ׳• ׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×." },
      { title: "׳”׳™׳§׳£ ׳”׳©׳™׳¨׳•׳×", body: "׳”׳₪׳׳˜׳₪׳•׳¨׳׳” ׳׳¡׳₪׳§׳× ׳׳× ׳׳©׳˜׳—׳™ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×, ׳”׳׳™׳©׳•׳¨ ׳•׳”׳׳¢׳§׳‘. ׳”׳™׳ ׳׳™׳ ׳” ׳׳¨׳—׳™׳‘׳” ׳›׳׳ ׳׳× ׳”׳”׳×׳—׳™׳™׳‘׳•׳™׳•׳× ׳׳¢׳‘׳¨ ׳׳׳” ׳©׳׳•׳₪׳™׳¢ ׳‘׳׳₪׳•׳¨׳© ׳‘׳׳¡׳׳•׳ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳•׳‘׳׳¦׳‘׳™ ׳”׳¢׳¡׳§׳” ׳‘׳₪׳•׳¢׳." }
    ]
  );
}

function renderPrivacyPage() {
  return renderLegalPage(
    "׳׳“׳™׳ ׳™׳•׳× ׳₪׳¨׳˜׳™׳•׳×",
    "׳₪׳¨׳˜׳™׳•׳× ׳•׳©׳׳™׳¨׳× ׳׳™׳“׳¢",
    "׳”׳׳“׳™׳ ׳™׳•׳× ׳”׳–׳• ׳׳¡׳‘׳™׳¨׳” ׳׳™׳–׳” ׳׳™׳“׳¢ ׳ ׳©׳׳¨ ׳׳׳•׳¨׳ ׳׳¡׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×, ׳׳׳” ׳”׳•׳ ׳ ׳©׳׳¨, ׳•׳׳™׳ ׳”׳§׳•׳ ׳” ׳¨׳•׳׳” ׳׳× ׳”׳׳™׳“׳¢ ׳”׳׳—׳™׳™׳‘ ׳‘׳׳™ ׳׳”׳¨׳’׳™׳© ׳©׳”׳•׳ ׳ ׳›׳ ׳¡ ׳׳׳¡׳׳•׳ ׳¢׳׳•׳.",
    [
      { title: "׳׳™׳–׳” ׳׳™׳“׳¢ ׳ ׳׳¡׳£", body: "׳‘׳׳”׳׳ ׳”׳©׳™׳׳•׳© ׳‘׳׳¡׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳™׳ ׳₪׳¨׳˜׳™׳ ׳×׳₪׳¢׳•׳׳™׳™׳ ׳›׳׳• ׳›׳׳•׳×, ׳‘׳—׳™׳¨׳× ׳׳•׳₪׳ ׳§׳‘׳׳”, ׳׳¡׳₪׳¨ ׳˜׳׳₪׳•׳ ׳׳¦׳•׳¨׳ ׳׳™׳׳•׳×, ׳•׳׳–׳”׳™ ׳”׳©׳×׳×׳₪׳•׳× ׳”׳ ׳“׳¨׳©׳™׳ ׳׳”׳¦׳’׳× ׳¡׳˜׳˜׳•׳¡ ׳•׳׳¢׳§׳‘." },
      { title: "׳׳׳” ׳©׳•׳׳¨׳™׳ ׳׳× ׳”׳׳™׳“׳¢", body: "׳”׳׳™׳“׳¢ ׳ ׳©׳׳¨ ׳›׳“׳™ ׳׳׳׳× ׳׳× ׳”׳§׳•׳ ׳”, ׳׳™׳™׳¦׳‘ ׳׳× ׳׳¡׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×, ׳׳”׳¦׳™׳’ ׳׳¦׳‘ ׳¢׳¡׳§׳” ׳¢׳“׳›׳ ׳™, ׳•׳׳׳₪׳©׳¨ ׳”׳׳©׳ ׳׳׳¡׳ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳•׳׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳©׳ ׳”׳”׳©׳×׳×׳₪׳•׳×." },
      { title: "׳׳™׳“׳¢ ׳×׳©׳׳•׳׳™", body: "׳‘׳©׳׳‘ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳”׳׳×׳•׳׳¨ ׳›׳׳ ׳ ׳©׳׳¨׳× ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“. ׳”׳׳¢׳¨׳›׳× ׳׳™׳ ׳” ׳׳¦׳™׳’׳” ׳–׳׳× ׳›׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳, ׳•׳”׳׳™׳“׳¢ ׳”׳×׳₪׳¢׳•׳׳™ ׳׳©׳׳© ׳׳× ׳׳¡׳׳•׳ ׳”׳׳™׳©׳•׳¨ ׳‘׳”׳×׳׳ ׳׳׳¦׳‘ ׳”׳¢׳¡׳§׳”." },
      { title: "׳©׳™׳×׳•׳£ ׳׳™׳“׳¢", body: "׳”׳׳™׳“׳¢ ׳׳•׳¦׳’ ׳‘׳׳©׳˜׳—׳™׳ ׳”׳ ׳“׳¨׳©׳™׳ ׳׳×׳₪׳¢׳•׳ ׳”׳¢׳¡׳§׳” ׳•׳׳ ׳™׳”׳•׳ ׳”׳׳•׳›׳¨, ׳‘׳׳™׳“׳” ׳”׳“׳¨׳•׳©׳” ׳׳׳¡׳׳•׳ ׳¢׳¦׳׳•. ׳׳™׳ ׳›׳׳ ׳”׳×׳—׳™׳™׳‘׳•׳× ׳׳©׳™׳׳•׳©׳™׳ ׳—׳™׳¦׳•׳ ׳™׳™׳ ׳©׳׳ ׳”׳•׳¦׳’׳• ׳׳׳©׳×׳׳© ׳‘׳׳₪׳•׳¨׳©." },
      { title: "׳©׳׳™׳˜׳” ׳•׳ ׳’׳™׳©׳•׳×", body: "׳”׳§׳•׳ ׳” ׳™׳›׳•׳ ׳׳—׳–׳•׳¨ ׳׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳“׳¨׳ ׳”׳§׳™׳©׳•׳¨ ׳”׳™׳™׳¢׳•׳“׳™ ׳©׳ ׳©׳׳¨ ׳׳•, ׳•׳”׳׳•׳›׳¨ ׳¨׳•׳׳” ׳׳× ׳”׳׳™׳“׳¢ ׳”׳ ׳—׳•׳¥ ׳׳ ׳™׳”׳•׳ ׳”׳¢׳¡׳§׳” ׳׳×׳•׳ ׳׳©׳˜׳—׳™ ׳”׳׳•׳›׳¨ ׳”׳¨׳׳•׳•׳ ׳˜׳™׳™׳." }
    ]
  );
}

function renderRefundsPage() {
  return renderLegalPage(
    "׳׳“׳™׳ ׳™׳•׳× ׳‘׳™׳˜׳•׳׳™׳ ׳•׳”׳—׳–׳¨׳™׳",
    "׳‘׳™׳˜׳•׳׳™׳, ׳©׳—׳¨׳•׳¨ ׳׳¡׳’׳¨׳× ׳•׳”׳—׳–׳¨׳™׳",
    "׳”׳¢׳׳•׳“ ׳”׳–׳” ׳׳‘׳”׳™׳¨ ׳׳× ׳”׳ ׳§׳•׳“׳” ׳”׳›׳™ ׳¨׳’׳™׳©׳” ׳‘׳׳¡׳׳•׳: ׳׳” ׳”׳”׳‘׳“׳ ׳‘׳™׳ ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳׳‘׳™׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳, ׳•׳׳” ׳§׳•׳¨׳” ׳׳ ׳”׳¢׳¡׳§׳” ׳׳ ׳׳’׳™׳¢׳” ׳׳¡׳’׳™׳¨׳” ׳׳•׳¦׳׳—׳×.",
    [
      { title: "׳׳₪׳ ׳™ ׳¡׳’׳™׳¨׳× ׳¢׳¡׳§׳”", body: "׳‘׳©׳׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳•׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳׳ ׳ ׳•׳¦׳¨ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳¨׳§ ׳׳¢׳¦׳ ׳”׳›׳ ׳™׳¡׳” ׳׳׳¡׳׳•׳. ׳”׳׳¢׳¨׳›׳× ׳©׳•׳׳¨׳× ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳× ׳‘׳׳‘׳“ ׳¢׳“ ׳׳”׳›׳¨׳¢׳× ׳׳¦׳‘ ׳”׳¢׳¡׳§׳”." },
      { title: "תפיסת מסגרת מול חיוב", body: "בזמן הצטרפות לא מתבצע חיוב בפועל. הסכום יתפוס מסגרת אשראי בלבד, והחיוב יתבצע רק אם העסקה תיסגר בהצלחה. אם העסקה לא תיסגר, המסגרת תשוחרר לפי כללי ספק האשראי." },
      { title: "ביטול לפני ואחרי נעילה", body: "לפני נעילת העסקה, ביטול אפשרי רק אם מצב העסקה והמערכת מאפשרים זאת. אחרי שלבי ReadyForCharging או נעילה תפעולית, אין ביטול מצד קונה מתוך המערכת." },
      { title: "עסקה שהושלמה", body: "לאחר עסקה Completed, בקשות שירות, אספקה או תיאום המשך הן מול המוכר, לפי פרטי הקשר ותנאי העסקה שהוצגו." },
      { title: "׳׳ ׳”׳¢׳¡׳§׳” ׳׳ ׳ ׳¡׳’׳¨׳×", body: "׳׳ ׳”׳¢׳¡׳§׳” ׳׳ ׳׳’׳™׳¢׳” ׳׳”׳©׳׳׳”, ׳”׳׳¡׳’׳¨׳× ׳׳׳•׳¨׳” ׳׳”׳©׳×׳—׳¨׳¨, ׳׳”׳×׳‘׳˜׳ ׳׳• ׳׳ ׳׳”׳₪׳•׳ ׳׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳, ׳‘׳”׳×׳׳ ׳׳׳¦׳‘ ׳”׳¡׳•׳₪׳™ ׳©׳ ׳”׳¢׳¡׳§׳” ׳•׳׳©׳›׳‘׳× ׳”׳׳™׳©׳•׳¨ ׳”׳¨׳׳•׳•׳ ׳˜׳™׳×." },
      { title: "׳׳ ׳‘׳•׳¦׳¢ ׳—׳™׳•׳‘ ׳•׳”׳¢׳¡׳§׳” ׳©׳•׳ ׳×׳” ׳׳׳—׳¨ ׳׳›׳", body: "׳‘׳׳§׳¨׳” ׳©׳‘׳• ׳”׳•׳©׳׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳ ׳•׳‘׳”׳׳©׳ ׳ ׳“׳¨׳© ׳‘׳™׳˜׳•׳ ׳׳• ׳”׳—׳–׳¨, ׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳•׳”׳¡׳˜׳˜׳•׳¡׳™׳ ׳‘׳׳¢׳¨׳›׳× ׳”׳ ׳׳§׳•׳¨ ׳”׳׳׳× ׳׳’׳‘׳™ ׳”׳׳¦׳‘ ׳”׳×׳₪׳¢׳•׳׳™ ׳©׳”׳§׳•׳ ׳” ׳¨׳•׳׳”." },
      { title: "׳׳—׳¨׳™׳•׳× ׳׳”׳¡׳‘׳¨ ׳׳§׳•׳ ׳”", body: "׳”׳׳•׳›׳¨ ׳ ׳“׳¨׳© ׳׳”׳¦׳™׳’ ׳¢׳¡׳§׳” ׳‘׳¨׳•׳¨׳” ׳•׳׳”׳™׳׳ ׳¢ ׳׳™׳¦׳™׳¨׳× ׳₪׳¢׳¨ ׳‘׳™׳ ׳׳” ׳©׳”׳§׳•׳ ׳” ׳׳‘׳™׳ ׳‘׳“׳£ ׳”׳¢׳¡׳§׳” ׳׳‘׳™׳ ׳”׳”׳×׳ ׳”׳’׳•׳× ׳”׳×׳₪׳¢׳•׳׳™׳× ׳©׳ ׳”׳¢׳¡׳§׳” ׳‘׳₪׳•׳¢׳." },
      { title: "׳׳™׳₪׳” ׳¨׳•׳׳™׳ ׳¡׳˜׳˜׳•׳¡", body: "׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳ ׳©׳׳¨ ׳”׳ ׳§׳•׳“׳” ׳”׳₪׳¢׳™׳׳” ׳‘׳™׳•׳×׳¨ ׳׳§׳•׳ ׳” ׳׳—׳¨׳™ ׳”׳¦׳˜׳¨׳₪׳•׳×, ׳•׳‘׳• ׳¨׳•׳׳™׳ ׳”׳׳ ׳ ׳©׳׳¨׳” ׳׳¡׳’׳¨׳×, ׳”׳׳ ׳©׳•׳—׳¨׳¨׳”, ׳•׳”׳׳ ׳—׳ ׳©׳™׳ ׳•׳™ ׳©׳׳¦׳¨׳™׳ ׳׳¢׳§׳‘ ׳ ׳•׳¡׳£." }
    ]
  );
}

function renderContactPage() {
  return renderLegalPage(
    "׳™׳¦׳™׳¨׳× ׳§׳©׳¨",
    "׳§׳©׳¨ ׳•׳×׳׳™׳›׳”",
    "׳™׳¦׳™׳¨׳× ׳”׳§׳©׳¨ ׳‘׳¡׳™׳˜׳•׳ ׳‘׳ ׳•׳™׳” ׳¡׳‘׳™׳‘ ׳”׳¢׳¡׳§׳” ׳¢׳¦׳׳”: ׳”׳™׳›׳ ׳”׳§׳•׳ ׳” ׳ ׳׳¦׳ ׳‘׳׳¡׳׳•׳, ׳׳” ׳”׳׳•׳›׳¨ ׳₪׳¨׳¡׳, ׳•׳׳”׳• ׳”׳׳¡׳ ׳©׳׳׳ ׳• ׳‘׳¨׳•׳¨ ׳‘׳™׳•׳×׳¨ ׳׳”׳׳©׳™׳ ׳˜׳™׳₪׳•׳.",
    [
      { title: "׳₪׳ ׳™׳™׳” ׳׳’׳‘׳™ ׳¢׳¡׳§׳” ׳₪׳¢׳™׳׳”", body: "׳‘׳׳§׳¨׳” ׳©׳ ׳©׳׳׳” ׳¢׳ ׳¢׳¡׳§׳”, ׳›׳׳•׳×, ׳׳•׳₪׳ ׳§׳‘׳׳” ׳׳• ׳׳¦׳‘ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×, ׳™׳© ׳׳₪׳¢׳•׳ ׳“׳¨׳ ׳“׳£ ׳”׳¢׳¡׳§׳” ׳”׳¦׳™׳‘׳•׳¨׳™ ׳•׳”׳׳™׳“׳¢ ׳©׳׳•׳₪׳™׳¢ ׳‘׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳©׳ ׳׳•׳×׳” ׳”׳©׳×׳×׳₪׳•׳×." },
      { title: "׳₪׳ ׳™׳™׳” ׳׳׳•׳›׳¨", body: "׳”׳׳•׳›׳¨ ׳”׳•׳ ׳”׳’׳•׳¨׳ ׳”׳¨׳׳©׳•׳ ׳©׳׳—׳¨׳׳™ ׳׳₪׳¨׳˜׳™ ׳”׳¢׳¡׳§׳” ׳©׳₪׳•׳¨׳¡׳׳”, ׳׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳×, ׳׳׳₪׳©׳¨׳•׳™׳•׳× ׳”׳§׳‘׳׳” ׳•׳׳׳™׳“׳¢ ׳”׳׳¡׳—׳¨׳™ ׳©׳ ׳—׳©׳£ ׳׳§׳•׳ ׳™׳." },
      { title: "׳׳™׳“׳¢ ׳׳—׳™׳™׳‘ ׳׳₪׳ ׳™ ׳₪׳¢׳•׳׳”", body: "׳׳₪׳ ׳™ ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳׳• ׳”׳׳©׳ ׳‘׳׳¡׳׳•׳, ׳›׳“׳׳™ ׳׳¢׳‘׳•׳¨ ׳¢׳ ׳×׳ ׳׳™ ׳”׳©׳™׳׳•׳©, ׳׳“׳™׳ ׳™׳•׳× ׳”׳₪׳¨׳˜׳™׳•׳× ׳•׳׳“׳™׳ ׳™׳•׳× ׳”׳‘׳™׳˜׳•׳׳™׳ ׳•׳”׳”׳—׳–׳¨׳™׳ ׳›׳“׳™ ׳׳”׳‘׳™׳ ׳׳× ׳׳‘׳ ׳” ׳”׳׳—׳¨׳™׳•׳× ׳•׳׳× ׳׳•׳₪׳™ ׳”׳¢׳¡׳§׳”." },
      { title: "׳׳” ׳׳™׳ ׳‘׳©׳׳‘ ׳”׳–׳”", body: "׳‘׳©׳׳‘ ׳”׳¦׳™׳‘׳•׳¨׳™ ׳”׳ ׳•׳›׳—׳™ ׳׳ ׳ ׳₪׳×׳— ׳›׳׳ ׳׳•׳§׳“ ׳—׳“׳© ׳׳• ׳׳•׳’׳™׳§׳× ׳₪׳ ׳™׳™׳” ׳׳¢׳¨׳›׳×׳™׳× ׳—׳“׳©׳”. ׳©׳›׳‘׳× ׳”׳§׳©׳¨ ׳ ׳©׳׳¨׳× ׳׳™׳ ׳™׳׳׳™׳×, ׳‘׳¨׳•׳¨׳”, ׳•׳׳‘׳•׳¡׳¡׳× ׳¢׳ ׳”׳׳©׳˜׳—׳™׳ ׳©׳›׳‘׳¨ ׳§׳™׳™׳׳™׳ ׳‘׳׳•׳¦׳¨." }
    ]
  );
}

function renderNav() {
  const isInternalSurface = INTERNAL_SURFACE_ROUTES.has(state.route.name);
  return `
      <nav class="shell-surface page-nav" aria-label="ניווט ראשי">
        <div class="actions">
          <a href="/app" data-nav="/app" class="button secondary">סיטון</a>
          <a href="/app/seller" data-nav="/app/seller" class="button secondary">אזור מוכר</a>
        </div>
        <div class="shell-meta">
          ${isInternalSurface ? `<div class="route-chip">גישה פנימית</div>` : `<div class="route-chip">פתוח להצגה</div>`}
          <div class="route-chip">${getRouteLabel()}</div>
        </div>
    </nav>
  `;
}

function getPrimaryDealImage(deal) {
  const images = Array.isArray(deal?.images) ? deal.images : [];
  return images.find((image) => image?.is_primary) || images[0] || null;
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
  const text = encodeURIComponent(title || "עסקה בסיטון");
  const encodedUrl = encodeURIComponent(shareUrl);
  return `
    <div class="share-panel" aria-label="שיתוף לינק">
      <button class="secondary share-native" type="button" data-inline-action="share-link" data-share-url="${esc(shareUrl)}" data-share-title="${esc(title || "עסקה בסיטון")}">שיתוף</button>
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
      title: "׳׳” ׳§׳¨׳” ׳¢׳“ ׳¢׳›׳©׳™׳•",
      value: "׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳ ׳©׳׳¨׳” ׳•׳ ׳×׳₪׳¡׳” ׳׳¡׳’׳¨׳×",
      detail: "׳¢׳“׳™׳™׳ ׳׳ ׳‘׳•׳¦׳¢ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳. ׳”׳׳¡׳ ׳”׳–׳” ׳™׳¢׳“׳›׳ ׳׳ ׳”׳¢׳¡׳§׳” ׳×׳¢׳‘׳•׳¨ ׳׳—׳™׳•׳‘."
    });
  }
  if (tracking?.buyer_state === "ChargeFailedCompletion" || tracking?.money_state === "ChargeFailedRecovery") {
    cards.push({
      title: "׳ ׳“׳¨׳© ׳©׳™׳ ׳׳‘",
      value: "׳”׳׳¢׳¨׳›׳× ׳׳˜׳₪׳׳× ׳‘׳׳©׳׳׳×",
      detail: tracking?.completion_window_until
        ? `׳™׳© ׳—׳׳•׳ ׳”׳©׳׳׳” ׳¢׳“ ${dt(tracking.completion_window_until)}. ׳׳ ׳™׳¢׳“׳›׳ ׳¤׳¢׳•׳׳” ׳ ׳•׳¡׳₪׳×, ׳”׳”׳•׳“׳¢׳” ׳×׳•׳₪׳™׳¢ ׳›׳׳.`
        : "׳׳© ׳כ׳©׳ ׳©׳ ׳ד׳¨׳© ׳ל׳׳¤׳, ׳׳ה׳׳¢׳¨׳כ׳ת ׳ע׳ד׳™׳™׳ן ׳מ׳נ׳ס׳ה ׳ל׳ס׳ג׳•׳ר ׳א׳ת ׳ה׳׳ס׳ל׳ו׳ל."
    });
  }
  if (tracking?.deal_state === "Completed") {
    cards.push({
      title: "׳ª׳•׳¦׳׳” ׳¡׳•׳₪׳™׳×",
      value: "׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳”",
      detail: "׳׳׳£׳ק׳ח ׳ה׳ע׳י׳ק׳¨׳י ׳ע׳כ׳ש׳יו ׳ה׳•׳א ׳מ׳¢׳ק׳ב ׳א׳ח׳ר ׳א׳ס׳פ׳ק׳ה ׳א׳ו ׳א׳י׳©׳•׳ר ׳ס׳ו׳פ׳י, ׳א׳ם ׳ה׳ם ׳ר׳ל׳ו׳ו׳נ׳ט׳י׳י׳ם."
    });
  }
  if (tracking?.deal_state === "Failed" || tracking?.deal_state === "Cancelled") {
    cards.push({
      title: "׳ª׳•׳¦׳׳” ׳¡׳•׳₪׳™׳×",
      value: tracking.deal_state === "Cancelled" ? "׳”׳¢׳¡׳§׳” ׳‘׳•׳˜׳׳”" : "׳”׳¢׳¡׳§׳” ׳׳ ׳”׳•׳©׳׳׳”",
      detail: "׳׳׳¡׳ ׳מ׳ר׳כ׳– ׳א׳ת ׳ה׳ת׳ו׳צ׳א׳ה ׳ה׳ס׳ו׳פ׳י׳ת ׳ל׳ק׳ו׳נ׳ה, ׳ו׳א׳י׳ן ׳צ׳ו׳ר׳ך ׳ל׳ח׳פ׳ש ׳מ׳י׳ד׳ע ׳ב׳מ׳ס׳כ׳י׳ם ׳א׳ח׳ר׳י׳ם."
    });
  }
  if (!cards.length) {
    cards.push({
      title: "׳׳” ׳§׳•׳¨׳” ׳¢׳›׳©׳™׳•",
      value: "׳”׳׳¡׳׳•׳ ׳‘׳ª׳ ׳•׳ע׳”",
      detail: "׳׳¡׳ ׳”׳׳¢׳§׳‘ ׳י׳מ׳ש׳י׳ך ׳ל׳ה׳ת׳ע׳ד׳כ׳ן ׳ע׳ם ׳כ׳ל ׳ש׳י׳נ׳ו׳י ׳ב׳מ׳¦׳ב ׳ה׳ע׳ס׳ק׳” ׳ו׳ה׳ה׳ש׳ת׳ת׳₪׳•׳ת."
    });
  }
  return cards;
}

function buildTrackingTimeline(tracking) {
  const rows = [];
  rows.push({
    label: "׳׳¦׳׳¨׳₪׳•׳×",
    value: "׳ ׳§׳׳˜׳” ׳‘׳”׳¦׳׳—׳”",
    detail: `${num(tracking.qty)} ׳™׳—' ֲ· ${dt(tracking.created_at)}`
  });
  rows.push({
    label: "׳׳¦׳‘ ׳¢׳¡׳§׳”",
    value: getDealCopy(tracking.deal_state).label,
    detail: getDealCopy(tracking.deal_state).description
  });
  rows.push({
    label: "׳׳¦׳‘ ׳›׳¡׳£",
    value: getLabel(MONEY_COPY, tracking.money_state)[0],
    detail: getLabel(MONEY_COPY, tracking.money_state)[1]
  });
  if (tracking.completion_window_until) {
    rows.push({
      label: "׳—׳׳•׳ ׳”׳©׳׳׳”",
      value: dt(tracking.completion_window_until),
      detail: "׳׳ ׳™׳”׳™׳” ׳¦׳•׳¨׳ ׳‘׳₪׳¢׳•׳׳” ׳ ׳•׳¡׳₪׳×, ׳ה׳י׳א ׳ת׳ו׳פ׳™׳ע ׳ב׳מ׳¡׳ ׳ה׳–׳ה."
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
    return "׳ל׳ש׳א׳ל׳ו׳ת ׳ע׳ל ׳א׳ס׳פ׳ק׳ה ׳א׳ו ׳ס׳ט׳ט׳ו׳ס ׳ס׳ו׳פ׳י, ׳כ׳ד׳א׳י ׳ל׳ה׳ת׳י׳ח׳ס ׳ל׳מ׳¡׳ך ׳ה׳מ׳¢׳ק׳‘ ׳כ׳מ׳ק׳ו׳¨ ׳ה׳א׳מ׳ת.";
  }
  if (["Failed", "Cancelled"].includes(String(tracking?.deal_state || ""))) {
    return "׳א׳ם ׳נ׳ד׳ר׳ש ׳ב׳י׳ר׳ו׳ר, ׳מ׳ס׳ך ׳ה׳מ׳¢׳ק׳‘ ׳ה׳ז׳ה ׳ה׳ו׳א ׳ה׳מ׳ק׳ו׳ם ׳ה׳נ׳כ׳ו׳ן ׳ל׳ה׳ב׳נ׳ת ׳ה׳ת׳ו׳צ׳א׳ה.";
  }
  return "׳כ׳ל ׳ע׳ד׳כ׳ו׳ן ׳מ׳ש׳מ׳ע׳ו׳ת׳י ׳י׳ו׳פ׳™׳ע ׳כ׳א׳ן. ׳ה׳ו׳ד׳ע׳ו׳ת ׳א׳ח׳ר׳ו׳ת ׳ה׳ן ׳ת׳ו׳מ׳כ׳ו׳ת ׳ב׳ל׳ב׳ד.";
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
    <section class="error-card" role="alert">
      <strong>${esc(error.title || "׳׳™׳¨׳¢׳” ׳©׳’׳™׳׳”")}</strong>
      <p>${esc(error.message || "׳ ׳¡׳” ׳©׳•׳‘ ׳‘׳¢׳•׳“ ׳¨׳’׳¢.")}</p>
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
  authorize(paymentDetails) {
    return api("/api/payments/authorize", {
      method: "POST",
      body: json(paymentDetails)
    });
  }
};

const buyerFlowService = {
  joinDeal(dealId, { buyerId, qty, affiliateRef, deliveryOptionId, buyerName, deliveryAddress, deliveryCity, deliveryNote, otpToken, otpChallengeId, authorizationId, authorizationProvider, authorizationCorrelationId, buyerTermsAccepted, paymentDisclosureAccepted }) {
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
        buyer_terms_accepted: buyerTermsAccepted === true,
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
    return { title: "׳”׳¢׳¡׳§׳” ׳׳ ׳ ׳׳¦׳׳”", message: "׳”׳§׳™׳©׳•׳¨ ׳”׳–׳” ׳׳ ׳׳¦׳‘׳™׳¢ ׳׳¢׳¡׳§׳” ׳§׳™׳™׳׳×. ׳›׳“׳׳™ ׳׳•׳•׳“׳ ׳©׳§׳™׳‘׳׳× ׳׳–׳”׳” ׳¢׳¡׳§׳” ׳×׳§׳™׳." };
  }
  if (status === 404 && lower.includes("participant not found")) {
    return { title: "׳׳ ׳׳¦׳׳ ׳• ׳׳× ׳”׳”׳©׳×׳×׳₪׳•׳×", message: "׳§׳™׳©׳•׳¨ ׳”׳׳¢׳§׳‘ ׳”׳–׳” ׳›׳‘׳¨ ׳׳ ׳×׳§׳™׳ ׳׳• ׳©׳׳™׳ ׳• ׳©׳™׳™׳ ׳׳”׳©׳×׳×׳₪׳•׳× ׳§׳™׳™׳׳×." };
  }
  if (status === 401 && lower.includes("seller session is required")) {
    return { title: "נדרשת כניסת מוכר", message: "המשך העבודה באזור המוכר מחייב כניסה מחדש עם פרטי הגישה של המוכר." };
  }
  if (status === 401 && lower.includes("seller id or access code is invalid")) {
    return { title: "׳₪׳¨׳˜׳™ ׳”׳’׳™׳©׳” ׳׳ ׳ ׳›׳•׳ ׳™׳", message: "׳׳–׳”׳” ׳”׳׳•׳›׳¨ ׳׳• ׳§׳•׳“ ׳”׳’׳™׳©׳” ׳׳ ׳×׳•׳׳׳™׳ ׳׳¨׳©׳™׳׳× ׳”׳׳•׳›׳¨׳™׳ ׳”׳׳•׳¨׳©׳™׳ ׳©׳ ׳¡׳‘׳™׳‘׳× ׳”-launch." };
  }
  if (status === 403 && lower.includes("manual seller context switching is disabled")) {
    return { title: "החלפת זהות ידנית חסומה", message: "בסביבה הזו זהות המוכר נקבעת דרך מנגנון הכניסה הפעיל, ולכן אי אפשר להחליף אותה ידנית מתוך הטופס." };
  }
  if (status === 503 && lower.includes("seller auth is not configured")) {
    return { title: "גישה למוכר עדיין לא הוגדרה", message: "סביבת העבודה עדיין לא קיבלה את כל פרטי הגישה למוכר, ולכן האזור נשאר חסום עד להשלמת ההגדרה." };
  }
  if (lower.includes("join not allowed")) {
    return { title: "׳—׳׳•׳ ׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳›׳‘׳¨ ׳¡׳’׳•׳¨", message: "׳׳™ ׳׳₪׳©׳¨ ׳׳”׳¦׳˜׳¨׳£ ׳׳¢׳¡׳§׳” ׳‘׳׳¦׳‘ ׳”׳ ׳•׳›׳—׳™ ׳©׳׳”. ׳׳ ׳›׳‘׳¨ ׳ ׳¨׳©׳׳×, ׳׳₪׳©׳¨ ׳׳¢׳‘׳•׳¨ ׳׳׳¢׳§׳‘." };
  }
  if (lower.includes("max_units exceeded")) {
    return { title: "׳׳™׳ ׳׳¡׳₪׳™׳§ ׳§׳™׳‘׳•׳׳× ׳₪׳ ׳•׳™׳”", message: "׳”׳›׳׳•׳× ׳©׳‘׳™׳§׳©׳× ׳›׳‘׳¨ ׳׳ ׳–׳׳™׳ ׳”. ׳›׳“׳׳™ ׳׳—׳–׳•׳¨ ׳׳“׳£ ׳”׳¢׳¡׳§׳” ׳•׳׳¢׳“׳›׳ ׳׳× ׳”׳›׳׳•׳×." };
  }
  if (lower.includes("invalid otp")) {
    return { title: "׳§׳•׳“ ׳”׳׳™׳׳•׳× ׳©׳’׳•׳™", message: "׳”׳§׳•׳“ ׳׳ ׳×׳•׳׳ ׳׳¡׳©׳ ׳”׳₪׳¢׳™׳. ׳׳₪׳©׳¨ ׳׳ ׳¡׳•׳× ׳©׳•׳‘ ׳׳• ׳׳‘׳§׳© ׳§׳•׳“ ׳—׳“׳©." };
  }
  if (lower.includes("otp expired")) {
    return { title: "׳×׳•׳§׳£ ׳”׳§׳•׳“ ׳₪׳’", message: "׳¦׳¨׳™׳ ׳׳‘׳§׳© ׳§׳•׳“ ׳—׳“׳© ׳›׳“׳™ ׳׳”׳׳©׳™׳ ׳‘׳׳¡׳׳•׳." };
  }
  if (lower.includes("otp session not found")) {
    return { title: "׳׳™׳ ׳¡׳©׳ ׳׳™׳׳•׳× ׳₪׳¢׳™׳", message: "׳ ׳¨׳׳” ׳©׳”׳¡׳©׳ ׳”׳§׳•׳“׳ ׳›׳‘׳¨ ׳׳ ׳–׳׳™׳. ׳׳₪׳©׳¨ ׳׳‘׳§׳© ׳§׳•׳“ ׳—׳“׳© ׳•׳׳—׳“׳© ׳׳× ׳”׳–׳¨׳™׳׳”." };
  }
  if (lower.includes("authorization failed")) {
    return { title: "׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳ ׳›׳©׳", message: "׳׳׳¦׳¢׳™ ׳”׳×׳©׳׳•׳ ׳ ׳“׳—׳” ׳¢׳ ׳™׳“׳™ ׳©׳›׳‘׳× ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳× ׳”׳§׳™׳™׳׳×. ׳׳₪׳©׳¨ ׳׳ ׳¡׳•׳× ׳׳׳¦׳¢׳™ ׳׳—׳¨." };
  }
  if (status >= 500) {
    return { title: "׳”׳׳¢׳¨׳›׳× ׳›׳¨׳’׳¢ ׳׳ ׳–׳׳™׳ ׳”", message: "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳”׳©׳׳™׳ ׳׳× ׳”׳₪׳¢׳•׳׳” ׳‘׳’׳׳ ׳‘׳¢׳™׳™׳× ׳©׳¨׳×. ׳›׳“׳׳™ ׳׳ ׳¡׳•׳× ׳©׳•׳‘ ׳‘׳¢׳•׳“ ׳¨׳’׳¢." };
  }
  if (lower.includes("networkerror") || lower.includes("failed to fetch") || lower.includes("load failed")) {
    return { title: "׳‘׳¢׳™׳™׳× ׳—׳™׳‘׳•׳¨", message: "׳׳ ׳”׳¦׳׳—׳ ׳• ׳׳”׳’׳™׳¢ ׳׳©׳¨׳×. ׳‘׳“׳•׳§ ׳׳× ׳”׳—׳™׳‘׳•׳¨ ׳׳׳™׳ ׳˜׳¨׳ ׳˜ ׳•׳ ׳¡׳” ׳©׳•׳‘." };
  }
  return {
    title: "׳׳™׳¨׳¢׳” ׳©׳’׳™׳׳”",
    message: fallback || message || "׳ ׳¡׳” ׳©׳•׳‘ ׳‘׳¢׳•׳“ ׳¨׳’׳¢."
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
  if (!Number.isInteger(qty) || qty < 1) return "׳™׳© ׳׳”׳–׳™׳ ׳›׳׳•׳× ׳©׳׳׳” ׳•׳—׳™׳•׳‘׳™׳×.";
  const left = Number(payload?.metrics?.remaining_units ?? 0);
  if (qty > left) return `׳›׳¨׳’׳¢ ׳ ׳•׳×׳¨׳• ׳¨׳§ ${left} ׳™׳—׳™׳“׳•׳× ׳₪׳ ׳•׳™׳•׳× ׳׳¢׳¡׳§׳” ׳”׳–׳•.`;
  return "";
}

function getDeliveryOptions(payload) {
  return payload?.deal?.delivery_options || [];
}

function formatDeliveryTypeLabel(type) {
  if (type === "pickup") return "׳׳™׳¡׳•׳£ ׳¢׳¦׳׳™";
  if (type === "delivery") return "׳׳©׳׳•׳—";
  if (type === "distribution_point") return "׳ ׳§׳•׳“׳× ׳—׳׳•׳§׳”";
  return type || "׳׳ ׳¦׳•׳™׳";
}

function getSelectedDeliveryOption(payload, selectedId) {
  const options = getDeliveryOptions(payload);
  if (!options.length) return null;
  if (selectedId) return options.find((option) => option.option_id === selectedId) || null;
  return options.length === 1 ? options[0] : null;
}

function validateDeliveryChoice(payload, selectedId) {
  const options = getDeliveryOptions(payload);
  if (!options.length) return "׳׳ ׳”׳•׳’׳“׳¨׳” ׳׳₪׳©׳¨׳•׳× ׳§׳‘׳׳” ׳׳¢׳¡׳§׳” ׳”׳–׳•.";
  if (options.length === 1) return "";
  return getSelectedDeliveryOption(payload, selectedId) ? "" : "׳¦׳¨׳™׳ ׳׳‘׳—׳•׳¨ ׳׳•׳₪׳ ׳§׳‘׳׳” ׳׳₪׳ ׳™ ׳”׳”׳׳©׳.";
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
    return "׳™׳© ׳׳׳׳ ׳©׳ ׳‘׳¢׳ ׳›׳¨׳˜׳™׳¡, ׳׳¡׳₪׳¨ ׳›׳¨׳˜׳™׳¡, ׳×׳•׳§׳£ ׳•-CVV.";
  }
  if (!/^\d{12,19}$/.test(payload.card_number)) {
    return "׳׳¡׳₪׳¨ ׳”׳›׳¨׳˜׳™׳¡ ׳¦׳¨׳™׳ ׳׳”׳›׳™׳ ׳‘׳™׳ 12 ׳-19 ׳¡׳₪׳¨׳•׳×.";
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
    display_name: "׳׳–׳•׳¨ ׳׳•׳›׳¨ ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳",
    verification_status: "approved",
    settlement_status: "active",
    is_default_context: true,
    context_source: "default_fallback"
  };
}

function lockedSellerContext() {
  return {
    seller_id: "",
    display_name: "׳ ׳“׳¨׳©׳× ׳”׳×׳—׳‘׳¨׳•׳× ׳׳•׳›׳¨",
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
    return "׳׳–׳•׳¨ ׳׳•׳›׳¨ ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳";
  }
  return displayName || "";
}

function syncSellerContext(next) {
  const normalized = { ...defaultSellerContext(), ...(next || {}) };
  if (
    normalized.seller_id === "seller-default" &&
    (!normalized.display_name || normalized.display_name === "Default Seller Workspace")
  ) {
    normalized.display_name = "׳׳–׳•׳¨ ׳׳•׳›׳¨ ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳";
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
        <span class="eyebrow">׳׳–׳•׳¨ ׳”׳׳•׳›׳¨</span>
        <h1>${configured ? "נדרשת כניסת מוכר" : "אזור המוכר עדיין לא זמין בסביבה הזו"}</h1>
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
        <p class="small muted">${auth.authenticated ? `הגישה של המוכר מזוהה כעת כ-<span class="mono">${esc(sellerContext.seller_id)}</span>, וכל העסקאות שמוצגות כאן שייכות לזהות הזו.` : auth.configured === false ? "הסביבה הזו עדיין לא קיבלה את כל פרטי הגישה הנדרשים למוכר, ולכן המשטח נשאר חסום בצורה מכוונת." : "כדי להיכנס לאזור המוכר צריך להזין מזהה מוכר וקוד גישה שהוגדרו מראש לסביבת העבודה."}</p>
        ${auth.authenticated ? `
          <form data-action="seller-logout" class="stack">
            <div class="actions">
              <button class="secondary" type="submit">יציאה מאזור המוכר</button>
            </div>
          </form>
        ` : auth.configured === false ? "" : `
          <form data-action="seller-login" class="stack">
            <div class="inline-fields">
              <div class="field">
                <label for="sellerContextId">׳׳–׳”׳” ׳׳•׳›׳¨</label>
                <input id="sellerContextId" name="sellerContextId" type="text" data-dir="ltr" autocomplete="username" value="${esc(state.form.sellerContextId || "")}" placeholder="seller-north" />
              </div>
              <div class="field">
                <label for="sellerAccessCode">׳§׳•׳“ ׳’׳™׳©׳”</label>
                <input id="sellerAccessCode" name="sellerAccessCode" type="password" data-dir="ltr" autocomplete="current-password" value="${esc(state.form.sellerAccessCode || "")}" placeholder="קוד גישה" />
              </div>
            </div>
            <div class="actions">
              <button class="primary" type="submit">כניסה לאזור המוכר</button>
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
    sellerContext.display_name = "׳׳–׳•׳¨ ׳׳•׳›׳¨ ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳";
  }
  sellerContext.display_name = normalizeSellerDisplayName(sellerContext.seller_id, sellerContext.display_name);
  return `
    <section class="summary-item stack">
      <div class="actions spread">
        <div>
          <span class="muted">׳–׳”׳•׳× ׳”׳׳•׳›׳¨ ׳”׳₪׳¢׳™׳׳”</span>
          <strong>${esc(sellerContext.display_name)}</strong>
        </div>
        <span class="badge ${sellerContext.is_default_context ? "warning" : "success"}">${sellerContext.is_default_context ? "׳‘׳¨׳™׳¨׳× ׳׳—׳“׳ ׳₪׳ ׳™׳׳™׳×" : "׳׳•׳›׳¨ ׳₪׳¢׳™׳"}</span>
      </div>
      <p class="small muted">׳›׳ ׳¢׳¡׳§׳” ׳—׳“׳©׳” ׳×׳™׳•׳•׳¦׳¨ ׳×׳—׳× <span class="mono">${esc(sellerContext.seller_id)}</span>. ׳׳–׳•׳¨ ׳”׳׳•׳›׳¨ ׳׳¦׳™׳’ ׳¨׳§ ׳׳× ׳”׳¢׳¡׳§׳׳•׳× ׳©׳ ׳”׳–׳”׳•׳× ׳”׳₪׳¢׳™׳׳”.</p>
      ${sellerContext.is_default_context ? `<p class="small muted">׳›׳“׳׳™ ׳׳©׳׳•׳¨ ׳׳–׳”׳” ׳׳•׳›׳¨ ׳‘׳¨׳•׳¨ ׳›׳“׳™ ׳׳ ׳׳¢׳‘׳•׳“ ׳×׳—׳× ׳‘׳¨׳™׳¨׳× ׳׳—׳“׳ ׳¢׳׳•׳׳”.</p>` : ""}
      <form data-action="seller-context" class="stack">
        <div class="inline-fields">
          <div class="field">
            <label for="sellerContextId">׳׳–׳”׳” ׳׳•׳›׳¨</label>
            <input id="sellerContextId" name="sellerContextId" type="text" data-dir="ltr" value="${esc(state.form.sellerContextId || sellerContext.seller_id)}" placeholder="seller-north" />
          </div>
          <div class="field">
            <label for="sellerContextName">׳©׳ ׳׳•׳›׳¨ ׳׳×׳¦׳•׳’׳”</label>
            <input id="sellerContextName" name="sellerContextName" type="text" data-dir="rtl" value="${esc(state.form.sellerContextName || sellerContext.display_name)}" placeholder="׳¡׳™׳˜׳•׳ ׳¦׳₪׳•׳" />
          </div>
        </div>
        <div class="actions">
          <button class="secondary" type="submit">׳©׳׳™׳¨׳× ׳–׳”׳•׳× ׳׳•׳›׳¨ ׳₪׳¢׳™׳׳”</button>
        </div>
      </form>
    </section>
  `;
}

function getFlowStatus(flow) {
  if (!flow.otpSessionId) {
    return { title: "׳¢׳“׳™׳™׳ ׳׳ ׳ ׳©׳׳— ׳§׳•׳“ ׳׳™׳׳•׳×", message: "׳”׳©׳׳‘ ׳”׳‘׳ ׳”׳•׳ ׳©׳׳™׳—׳× ׳§׳•׳“ ׳׳˜׳׳₪׳•׳ ׳©׳ ׳”׳§׳•׳ ׳”." };
  }
  if (flow.otpVerified) {
    return { title: "׳”׳˜׳׳₪׳•׳ ׳›׳‘׳¨ ׳׳•׳׳×", message: "׳׳₪׳©׳¨ ׳׳¢׳‘׳•׳¨ ׳™׳©׳™׳¨׳•׳× ׳׳©׳׳‘ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×." };
  }
  if (flow.otpExpiresAt && Date.now() > new Date(flow.otpExpiresAt).getTime()) {
    return { title: "׳§׳•׳“ ׳”׳׳™׳׳•׳× ׳₪׳’", message: "׳¦׳¨׳™׳ ׳׳‘׳§׳© ׳§׳•׳“ ׳—׳“׳© ׳›׳“׳™ ׳׳”׳׳©׳™׳." };
  }
  return { title: "׳׳׳×׳™׳ ׳׳”׳–׳ ׳× ׳”׳§׳•׳“", message: "׳”׳§׳•׳“ ׳ ׳©׳׳—. ׳׳” ׳©׳ ׳©׳׳¨ ׳”׳•׳ ׳׳”׳–׳™׳ ׳׳•׳×׳• ׳•׳׳”׳׳©׳™׳." };
}

function getDealCopy(stateName) {
  const item = DEAL_COPY[stateName];
  if (!item) {
    return { label: stateName, title: "׳׳¦׳‘ ׳¢׳¡׳§׳” ׳׳ ׳׳׳•׳₪׳”", description: "׳ ׳׳¦׳ ׳¡׳˜׳˜׳•׳¡ ׳¢׳¡׳§׳” ׳©׳׳ ׳§׳™׳‘׳ ׳ ׳™׳¡׳•׳— ׳™׳™׳¢׳•׳“׳™.", badgeTone: "warning" };
  }
  return { label: item[0], title: item[0], description: item[1], badgeTone: stateName === "PendingTarget" || stateName === "TargetReached" || stateName === "Completed" ? "success" : stateName === "Failed" || stateName === "Cancelled" ? "danger" : "warning" };
}

function getLabel(map, key) {
  return map[key] || [key, "׳ ׳׳¦׳ ׳׳¦׳‘ ׳©׳׳ ׳§׳™׳‘׳ ׳ ׳™׳¡׳•׳— ׳™׳™׳¢׳•׳“׳™."];
}

function nextDealAction(stateName, canJoin) {
  if (canJoin) {
    return {
      cta: stateName === "TargetReached" ? "הצטרפו ליחידות האחרונות" : "הצטרפו לעסקה",
      description: "׳”׳׳¡׳׳•׳ ׳™׳™׳§׳— ׳׳•׳×׳ ׳“׳¨׳ ׳׳™׳׳•׳× ׳˜׳׳₪׳•׳, ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳× ׳•׳©׳׳™׳¨׳× ׳”׳”׳©׳×׳×׳₪׳•׳×."
    };
  }
  if (stateName === "Draft") return { cta: "׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳¢׳“׳™׳™׳ ׳׳ ׳–׳׳™׳ ׳”", description: "׳׳₪׳©׳¨ ׳׳©׳׳•׳¨ ׳׳× ׳”׳§׳™׳©׳•׳¨ ׳•׳׳—׳–׳•׳¨ ׳׳׳•׳—׳¨ ׳™׳•׳×׳¨." };
  if (stateName === "Cancelled" || stateName === "Failed") return { cta: "׳”׳¢׳¡׳§׳” ׳›׳‘׳¨ ׳¡׳’׳•׳¨׳”", description: "׳›׳׳ ׳›׳‘׳¨ ׳׳™ ׳׳₪׳©׳¨ ׳׳”׳¦׳˜׳¨׳£. ׳׳ ׳”׳©׳×׳×׳₪׳×, ׳”׳©׳×׳׳© ׳‘׳׳¡׳ ׳”׳׳¢׳§׳‘." };
  return { cta: "׳”׳”׳¦׳˜׳¨׳₪׳•׳× ׳¡׳’׳•׳¨׳”", description: "׳׳™׳ ׳›׳¨׳’׳¢ ׳׳¡׳׳•׳ ׳”׳¦׳˜׳¨׳₪׳•׳× ׳₪׳¢׳™׳ ׳׳¢׳¡׳§׳” ׳”׳–׳•." };
}

function buildJourney(tracking) {
  const authorizationDone = ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargedSuccess", "ChargeFailedRecovery", "RecoveredCharge", "AuthReleased", "Refunded"].includes(tracking.money_state);
  const chargingDone = ["Charging", "CompletionWindow", "Completed", "Failed"].includes(tracking.deal_state) || ["ChargeAttempt", "ChargedSuccess", "RecoveredCharge"].includes(tracking.money_state);
  const finalDone = ["Completed", "Failed", "Cancelled"].includes(tracking.deal_state) || ["DealCompleted", "DealFailed", "Dropped", "Recovered"].includes(tracking.buyer_state);
  return [
    { title: "׳ ׳¨׳©׳׳× ׳׳¢׳¡׳§׳”", done: true, current: tracking.buyer_state === "JoinedAuthorized" },
    { title: "׳™׳© ׳׳™׳©׳•׳¨ ׳׳¡׳’׳¨׳×", done: authorizationDone, current: tracking.money_state === "AuthHeld" || tracking.money_state === "AuthLocked" },
    { title: "׳”׳¢׳¡׳§׳” ׳”׳×׳§׳“׳׳” ׳׳—׳™׳•׳‘", done: chargingDone, current: tracking.money_state === "ChargeAttempt" || tracking.buyer_state === "ChargingAttempt" },
    { title: "׳ ׳¡׳’׳¨׳” ׳×׳•׳¦׳׳” ׳¡׳•׳₪׳™׳×", done: finalDone, current: !finalDone && tracking.deal_state === "CompletionWindow" }
  ];
}

function nextTrackingStep(tracking) {
  if (tracking.deal_state === "Completed") {
    return {
      title: "׳׳™׳ ׳¢׳•׳“ ׳₪׳¢׳•׳׳” ׳ ׳“׳¨׳©׳× ׳׳׳",
      detail: "׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳” ׳•׳”׳׳¡׳ ׳ ׳©׳׳¨ ׳›׳׳¡׳ ׳׳™׳“׳¢ ׳•׳׳¢׳§׳‘ ׳‘׳׳‘׳“.",
      summary: "׳”׳¢׳¡׳§׳” ׳”׳•׳©׳׳׳” ׳•׳”׳”׳©׳×׳×׳₪׳•׳× ׳©׳׳ ׳ ׳¡׳’׳¨׳” ׳‘׳”׳¦׳׳—׳”."
    };
  }
  if (tracking.deal_state === "Failed" || tracking.deal_state === "Cancelled") {
    return {
      title: "׳”׳׳¡׳׳•׳ ׳”׳–׳” ׳ ׳¡׳’׳¨",
      detail: "׳”׳¢׳¡׳§׳” ׳׳ ׳”׳•׳©׳׳׳”. ׳”׳׳¡׳ ׳׳¦׳™׳’ ׳׳× ׳”׳×׳•׳¦׳׳” ׳”׳¡׳•׳₪׳™׳× ׳©׳ ׳”׳”׳©׳×׳×׳₪׳•׳× ׳•׳”׳׳©׳׳¢׳•׳× ׳”׳›׳¡׳₪׳™׳× ׳©׳׳”.",
      summary: "׳”׳¢׳¡׳§׳” ׳׳ ׳”׳•׳©׳׳׳” ׳•׳׳›׳ ׳׳™׳ ׳©׳׳‘ ׳”׳׳©׳ ׳׳׳¡׳׳•׳ ׳”׳–׳”."
    };
  }
  if (tracking.money_state === "AuthHeld" && tracking.buyer_state === "JoinedAuthorized") {
    return {
      title: "׳›׳¨׳’׳¢ ׳׳׳×׳™׳ ׳™׳ ׳׳”׳×׳§׳“׳׳•׳× ׳”׳¢׳¡׳§׳”",
      detail: "׳ ׳¨׳©׳׳× ׳‘׳”׳¦׳׳—׳”, ׳‘׳•׳¦׳¢׳” ׳×׳₪׳™׳¡׳× ׳׳¡׳’׳¨׳×, ׳•׳¢׳›׳©׳™׳• ׳׳׳×׳™׳ ׳™׳ ׳׳©׳׳‘ ׳”׳‘׳ ׳‘׳¢׳¡׳§׳” ׳¢׳¦׳׳”.",
      summary: "׳”׳©׳×׳×׳₪׳× ׳‘׳”׳¦׳׳—׳”. ׳¢׳“׳™׳™׳ ׳׳™׳ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳, ׳•׳¨׳§ ׳ ׳©׳׳¨ ׳׳™׳©׳•׳¨ ׳”׳׳¡׳’׳¨׳×."
    };
  }
  if (tracking.money_state === "ChargeAttempt" || tracking.buyer_state === "ChargingAttempt") {
    return {
      title: "׳”׳׳¢׳¨׳›׳× ׳׳ ׳¡׳” ׳׳—׳™׳™׳‘ ׳›׳¨׳’׳¢",
      detail: "׳–׳”׳• ׳©׳׳‘ ׳×׳₪׳¢׳•׳׳™. ׳׳™׳ ׳¦׳•׳¨׳ ׳‘׳₪׳¢׳•׳׳” ׳׳¦׳“ ׳”׳§׳•׳ ׳” ׳›׳¨׳’׳¢.",
      summary: "׳”׳¢׳¡׳§׳” ׳”׳’׳™׳¢׳” ׳׳©׳׳‘ ׳”׳—׳™׳•׳‘ ׳•׳”׳׳¢׳¨׳›׳× ׳׳ ׳¡׳” ׳׳‘׳¦׳¢ ׳—׳™׳•׳‘ ׳‘׳₪׳•׳¢׳."
    };
  }
  if (tracking.buyer_state === "ChargeFailedCompletion" || tracking.money_state === "ChargeFailedRecovery") {
    return {
      title: "׳”׳׳¢׳¨׳›׳× ׳׳ ׳¡׳” ׳׳”׳©׳׳™׳ ׳׳× ׳”׳”׳©׳×׳×׳₪׳•׳×",
      detail: "׳›׳¨׳’׳¢ ׳׳™׳ ׳¦׳¢׳“ ׳™׳“׳ ׳™ ׳ ׳•׳¡׳£ ׳‘׳׳¡׳ ׳”׳–׳”. ׳”׳×׳•׳¦׳׳” ׳×׳×׳¢׳“׳›׳ ׳׳₪׳™ ׳׳¡׳׳•׳ ׳©׳—׳–׳•׳¨ ׳׳• ׳¡׳’׳™׳¨׳”.",
      summary: "׳ ׳“׳¨׳© ׳׳¡׳׳•׳ ׳”׳©׳׳׳” ׳‘׳¢׳§׳‘׳•׳× ׳›׳©׳ ׳—׳™׳•׳‘, ׳•׳”׳׳¢׳¨׳›׳× ׳¢׳“׳™׳™׳ ׳׳¡׳™׳™׳׳× ׳׳× ׳”׳¡׳’׳™׳¨׳”."
    };
  }
  return {
    title: "׳›׳“׳׳™ ׳׳”׳׳©׳™׳ ׳׳¢׳§׳•׳‘ ׳׳”׳׳¡׳ ׳”׳–׳”",
    detail: "׳”׳׳¡׳ ׳™׳¦׳™׳’ ׳׳× ׳׳¦׳‘ ׳”׳¢׳¡׳§׳” ׳•׳”׳”׳©׳×׳×׳₪׳•׳× ׳›׳›׳ ׳©׳”׳‘׳§׳׳ ׳“ ׳™׳×׳§׳“׳ ׳‘׳©׳׳‘׳™׳.",
    summary: "׳”׳”׳©׳×׳×׳₪׳•׳× ׳©׳׳ ׳§׳™׳™׳׳× ׳‘׳׳¢׳¨׳›׳×, ׳•׳”׳׳¡׳ ׳”׳–׳” ׳”׳•׳ ׳׳§׳•׳¨ ׳”׳׳׳× ׳©׳׳”."
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
  return value ? new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "׳׳ ׳–׳׳™׳";
}

function relativeTime(value) {
  if (!value) return "׳׳ ׳–׳׳™׳";
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return "׳׳׳© ׳¢׳›׳©׳™׳•";
  if (minutes < 60) return `׳׳₪׳ ׳™ ${minutes} ׳“׳§׳•׳×`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `׳׳₪׳ ׳™ ${hours} ׳©׳¢׳•׳×`;
  const days = Math.round(hours / 24);
  return `׳׳₪׳ ׳™ ${days} ׳™׳׳™׳`;
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

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


