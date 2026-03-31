const root = document.getElementById("app");
const FLOW_KEY = "siton_flow_v2";
const FLOW_TTL_MS = 1000 * 60 * 60 * 6;
const POLL_INTERVAL_MS = 12000;
let routePollTimer = null;
let routePollKey = "";

const state = {
  loading: false,
  loadingMessage: "",
  route: parseRoute(location.pathname),
  previewMeta: null,
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
    phone: "",
    code: "",
    holderName: "",
    cardNumber: "",
    expiry: "",
    cvv: "",
    sellerTitle: "",
    sellerPrice: "10",
    sellerMinUnits: "10",
    sellerMaxUnits: "20",
    sellerDeadline: "",
    sellerCommissionRate: "0"
  }
};

const DEAL_COPY = {
  Draft: ["העסקה עדיין בטיוטה", "העסקה עוד לא נפתחה לקונים ולכן עדיין אי אפשר להצטרף."],
  PendingTarget: ["פתוחה להצטרפות", "אפשר להצטרף עכשיו. בשלב הזה נשמרים אימות, authorization והרשמה לעסקה."],
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
  JoinedAuthorized: ["נרשמת בהצלחה", "ההשתתפות נקלטה ונשמר authorization."],
  LockedIn: ["ננעלת לעסקה", "ההשתתפות שלך כבר בפנים, לפני שלב החיוב."],
  ChargingAttempt: ["מתבצע ניסיון חיוב", "העסקה הגיעה לשלב שבו המערכת מנסה לחייב."],
  ChargedSuccess: ["החיוב הצליח", "החיוב עבור ההשתתפות שלך עבר בהצלחה."],
  ChargeFailedCompletion: ["נדרש טיפול בהשלמה", "החיוב לא הושלם וההשתתפות נמצאת בחלון השלמה."],
  Recovered: ["הושלמה בשחזור", "המערכת השלימה את ההשתתפות במסלול recovery."],
  Dropped: ["ההשתתפות ירדה", "ההשתתפות שלך לא הושלמה בתוך העסקה."],
  DealCompleted: ["העסקה הושלמה עבורך", "ההשתתפות נסגרה כחלק מעסקה שהושלמה."],
  DealFailed: ["העסקה נכשלה עבורך", "ההשתתפות נסגרה כחלק מעסקה שלא הושלמה."]
};

const MONEY_COPY = {
  AuthHeld: ["יש תפיסת מסגרת", "בוצע authorization בלבד. עדיין אין חיוב בפועל."],
  AuthLocked: ["תפיסת המסגרת ננעלה", "האישור נשמר לקראת חיוב אפשרי."],
  ChargeAttempt: ["מתבצע חיוב", "המערכת מנסה לבצע charge בפועל."],
  ChargedSuccess: ["חויבת", "החיוב הושלם בהצלחה."],
  ChargeFailedRecovery: ["החיוב לא הושלם", "המערכת מנסה לסגור את המסלול דרך recovery."],
  RecoveredCharge: ["החיוב הושלם בשחזור", "המערכת הצליחה להשלים את החיוב במסלול recovery."],
  AuthReleased: ["תפיסת המסגרת שוחררה", "לא בוצע חיוב בפועל או שהתפיסה בוטלה."],
  Refunded: ["בוצע זיכוי", "המערכת החזירה את הסכום לאחר חיוב."]
};

const ROUTE_LABELS = {
  marketplace: "Marketplace",
  seller: "Seller",
  "seller-new": "New Deal",
  "seller-deal": "Seller Deal",
  affiliate: "Affiliate",
  admin: "Admin",
  "admin-deal": "Admin Deal",
  "admin-user": "User Profile",
  home: "מסלול קונה",
  deal: "דף עסקה",
  otp: "אימות טלפון",
  payment: "אישור מסגרת",
  confirmation: "אישור הצטרפות",
  tracking: "מעקב השתתפות",
  "not-found": "עמוד לא נמצא"
};

const PAYMENT_READINESS = {
  providerLabel: "Mock authorization provider",
  settlementModel: "authorization קודם, charge מאוחר יותר",
  integrationNote: "נקודת ההחלפה ל-provider אמיתי מרוכזת בתוך paymentService."
};

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
  hydrateForm();
  await loadPreviewMeta();
  render();
  await runRoute();
}

async function loadPreviewMeta() {
  try {
    state.previewMeta = await api("/api/preview/meta");
  } catch {
    state.previewMeta = null;
  }
}

function parseRoute(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/" || normalized === "/app") return { name: "home" };
  const patterns = [
    ["marketplace", /^\/app\/marketplace$/],
    ["deal", /^\/app\/deal\/([^/]+)$/],
    ["otp", /^\/app\/join\/([^/]+)\/otp$/],
    ["payment", /^\/app\/join\/([^/]+)\/payment$/],
    ["confirmation", /^\/app\/join\/([^/]+)\/confirmation$/],
    ["tracking", /^\/app\/track\/([^/]+)$/],
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
    if (name === "seller" || name === "seller-new" || name === "affiliate" || name === "admin" || name === "marketplace") {
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
  if (route.name === "home" || route.name === "marketplace") return loadMarketplace(state.form.marketQuery);
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
        message: "הכמות נשמרה, אבל לפני authorization צריך להשלים OTP."
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
    state.form.qty = String(getFlow(dealId)?.qty || Math.max(1, state.dealPayload.deal.min_units || 1));
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

async function loadMarketplace(query = "") {
  await busy("Loading marketplace...", async () => {
    state.marketplacePayload = await api(`/api/marketplace/deals?q=${encodeURIComponent(query || "")}`);
  }, "Could not load marketplace deals.");
}

async function loadSeller() {
  await busy("Loading seller workspace...", async () => {
    state.sellerPayload = await api("/api/seller/deals");
  }, "Could not load the seller workspace.");
}

async function prepareSellerNew() {
  if (!state.form.sellerDeadline) {
    state.form.sellerDeadline = toDatetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  }
  render();
}

async function loadSellerDeal(dealId) {
  await busy("Loading seller deal...", async () => {
    state.sellerDealPayload = await api(`/api/seller/deals/${encodeURIComponent(dealId)}`);
  }, "Could not load the seller deal view.");
}

async function loadAffiliate() {
  await busy("Loading affiliate surface...", async () => {
    state.affiliatePayload = await api("/api/affiliate/overview");
  }, "Could not load the affiliate surface.");
}

async function loadAdmin(query = "") {
  await busy("Loading admin surface...", async () => {
    const [overview, systemStatus] = await Promise.all([
      api(`/api/admin/overview?q=${encodeURIComponent(query || "")}`),
      api("/api/admin/system-status")
    ]);
    state.adminPayload = overview;
    state.adminSystemStatusPayload = systemStatus;
  }, "Could not load the admin surface.");
}

async function loadAdminDeal(dealId) {
  await busy("Loading admin deal profile...", async () => {
    state.adminDealPayload = await api(`/api/admin/deals/${encodeURIComponent(dealId)}/profile`);
  }, "Could not load the admin deal profile.");
}

async function loadAdminUser(buyerId) {
  await busy("Loading admin user profile...", async () => {
    state.adminUserPayload = await api(`/api/admin/users/${encodeURIComponent(buyerId)}/profile`);
  }, "Could not load the user profile.");
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
  if (route.name === "home" || route.name === "marketplace") return "marketplace";
  if (route.name === "deal") return `deal:${route.dealId}`;
  if (route.name === "tracking") return `tracking:${route.participantId}`;
  if (route.name === "seller") return "seller";
  if (route.name === "admin") return "admin";
  return "";
}

async function runRouteSilently() {
  const route = state.route;
  if (document.hidden) return;
  if (route.name === "home" || route.name === "marketplace") {
    await refreshMarketplaceSilently();
    return;
  }
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

async function refreshMarketplaceSilently() {
  try {
    const next = await api(`/api/marketplace/deals?q=${encodeURIComponent(state.form.marketQuery || "")}`);
    if (!state.marketplacePayload || JSON.stringify(state.marketplacePayload.deals) !== JSON.stringify(next.deals)) {
      state.marketplacePayload = next;
      render();
    }
  } catch {}
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
  if (action === "marketplace-search") return loadMarketplace(state.form.marketQuery);
  if (action === "start-join") return startJoin();
  if (action === "otp-start") return otpStart(form);
  if (action === "otp-verify") return otpVerify(form);
  if (action === "pay") return payAndJoin(form);
  if (action === "seller-create") return createDeal(form);
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

  const flow = saveFlow(payload.deal.deal_id, {
    dealId: payload.deal.deal_id,
    dealTitle: payload.deal.title,
    qty,
    affiliateRef: currentAffiliateRef() || getFlow(payload.deal.deal_id)?.affiliateRef || "",
    estimatedTotal: qty * payload.deal.price_per_unit,
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
  if (!code) return fail("חסר קוד אימות", "יש להזין את קוד ה-OTP שנשלח אליך.");

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
    title: "שלב ה-OTP אופס",
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
      message: "צריך להשלים OTP לפני אישור המסגרת."
    };
    render();
    return;
  }

  const formData = new FormData(form);
  const payload = {
    holder_name: String(formData.get("holderName") || "").trim(),
    card_number: String(formData.get("cardNumber") || "").replace(/\s+/g, ""),
    expiry: String(formData.get("expiry") || "").trim(),
    cvv: String(formData.get("cvv") || "").trim()
  };
  const issue = validatePayment(payload);
  if (issue) return fail("פרטי האשראי לא מלאים", issue);

  await busy("מאשר את המסגרת ושומר את ההצטרפות...", async () => {
    const authorization = await paymentService.authorize(payload);
    const join = await buyerFlowService.joinDeal(route.dealId, {
      buyerId: flow.buyerId,
      qty: flow.qty,
      affiliateRef: flow.affiliateRef || ""
    });
    saveFlow(route.dealId, {
      paymentAuthorized: true,
      paymentAuthorizedAt: new Date().toISOString(),
      authorizationId: authorization.authorization_id,
      authorizationMessage: authorization.hold_message || "",
      participantId: join.participant_id
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
  if (!title) return fail("Title is required", "Enter a title before creating the deal.");
  if (!deadline) return fail("Deadline is required", "Select a deadline before creating the deal.");

  await busy("Creating seller deal...", async () => {
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
        commission_rate: Number(formData.get("sellerCommissionRate") || 0)
      })
    });
    state.banner = {
      tone: "success",
      title: "Draft deal created",
      message: "The seller draft is ready for review and publish."
    };
    navigate(`/app/seller/deals/${encodeURIComponent(response.deal_id)}`);
  }, "Seller deal creation failed.");
}

async function publishDeal(dealId) {
  if (!dealId) return;
  await busy("Publishing seller deal...", async () => {
    await api(`/deals/${encodeURIComponent(dealId)}/publish`, {
      method: "POST",
      headers: {
        "x-request-id": `seller-publish:${Date.now()}`,
        "idempotency-key": `seller-publish:${dealId}`
      }
    });
    state.banner = {
      tone: "success",
      title: "Deal published",
      message: "The deal is now public and available for sharing."
    };
    await loadSellerDeal(dealId);
  }, "Deal publish failed.");
}

function cloneSellerDeal(dealId) {
  const deal = state.sellerDealPayload?.deal;
  if (!deal || deal.deal_id !== dealId) return;
  state.form.sellerTitle = `${deal.title} (copy)`;
  state.form.sellerPrice = String(deal.price_per_unit);
  state.form.sellerMinUnits = String(deal.min_units);
  state.form.sellerMaxUnits = String(deal.max_units);
  state.form.sellerCommissionRate = String(deal.commission_rate || 0);
  state.form.sellerDeadline = toDatetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  navigate("/app/seller/new");
}

async function updateDelivery(form) {
  const dealId = form.dataset.dealId;
  const participantId = form.dataset.participantId;
  if (!dealId || !participantId) return;
  const formData = new FormData(form);
  await busy("Updating delivery status...", async () => {
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
      message: "The seller delivery surface was refreshed with the latest fulfillment status."
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
    phone: "",
    code: "",
    holderName: "",
    cardNumber: "",
    expiry: "",
    cvv: "",
    sellerTitle: state.form.sellerTitle,
    sellerPrice: state.form.sellerPrice,
    sellerMinUnits: state.form.sellerMinUnits,
    sellerMaxUnits: state.form.sellerMaxUnits,
    sellerDeadline: state.form.sellerDeadline,
    sellerCommissionRate: state.form.sellerCommissionRate
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
    </main>
  `;
}

function renderPreviewStrip() {
  const preview = state.previewMeta?.preview;
  if (!preview?.is_demo_preview) return "";
  return `
    <section class="info-strip tone-warning">
      <strong>${esc(preview.public_label)} deployment</strong>
      <p>This environment is for showcase and preview only. Payment, receipts, shipping, payouts, KYC, and notifications are displayed with internal-ready semantics only and are not live external rails.</p>
    </section>
  `;
}

function renderCurrentRoute() {
  const route = state.route;
  if (route.name === "home" || route.name === "marketplace") return renderHome();
  if (route.name === "deal") return renderDealPage();
  if (route.name === "otp") return renderOtpPage(route.dealId);
  if (route.name === "payment") return renderPaymentPage(route.dealId);
  if (route.name === "confirmation") return renderConfirmationPage(route.dealId);
  if (route.name === "tracking") return renderTrackingPage();
  if (route.name === "seller") return renderSellerPage();
  if (route.name === "seller-new") return renderSellerNewPage();
  if (route.name === "seller-deal") return renderSellerDealPage();
  if (route.name === "affiliate") return renderAffiliatePage();
  if (route.name === "admin") return renderAdminPage();
  if (route.name === "admin-deal") return renderAdminDealPage();
  if (route.name === "admin-user") return renderAdminUserPage();
  return renderEmptyState("העמוד לא נמצא", "הקישור הזה לא קיים או שכבר אינו זמין.");
}

function renderHome() {
  const payload = state.marketplacePayload;
  const deals = payload?.deals || [];
  const preview = state.previewMeta?.preview;
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">${esc(preview?.public_label || "Preview product surface")}</span>
        <h1>Public product preview with buyer, seller, affiliate, and admin surfaces</h1>
        <p class="muted">
          This preview environment lets you open public deals, walk the buyer journey, and inspect seller, affiliate, and admin workspaces without pretending that live payment or external operational rails are already active.
        </p>
        <div class="actions">
          <a class="button secondary" href="/app/seller" data-nav="/app/seller">Seller workspace</a>
          <a class="button secondary" href="/app/affiliate" data-nav="/app/affiliate">Affiliate workspace</a>
          <a class="button secondary" href="/app/admin" data-nav="/app/admin">Admin workspace</a>
        </div>
        <form class="stack" data-action="marketplace-search">
          <div class="field">
            <label for="marketQuery">Search public deals</label>
            <input id="marketQuery" name="marketQuery" type="search" value="${esc(state.form.marketQuery)}" placeholder="Search by title or deal id" />
          </div>
          <div class="actions">
            <button class="primary" type="submit">Search deals</button>
            <a class="button secondary" href="/app" data-nav="/app">Reset</a>
          </div>
        </form>
        <div class="summary-item">
          <span class="muted">Preview scope</span>
          <strong>${payload?.discovery_mode || "public marketplace preview"}</strong>
          <p class="small muted">${payload?.note || "Public searchable discovery is available in preview, but this environment still stops short of live commercial activation."}</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">Public deals loaded</span><strong>${num(deals.length)}</strong></div>
        <div class="summary-item"><span class="muted">Deployment mode</span><strong>${esc(preview?.deployment_mode || "preview")}</strong></div>
        <div class="summary-item"><span class="muted">Commercial rails</span><strong>Disabled in demo</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>Public deals</h2>
      ${deals.length ? `<div class="card-list">${deals.map(renderMarketplaceCard).join("")}</div>` : `<p class="muted">No public deals matched the current query.</p>`}
    </section>
  `;
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Siton Buyer Flow</span>
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
          <strong>דף עסקה, OTP, authorization, אישור ומעקב</strong>
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
  const qty = Number(state.form.qty || deal.min_units || 1);
  const qtyIssue = validateQty(state.dealPayload, qty);
  const nextAction = nextDealAction(deal.state, availability.canJoin);
  const flow = getFlow(deal.deal_id);
  const affiliateRef = currentAffiliateRef() || flow?.affiliateRef || "";

  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">עסקה ציבורית</span>
        <span class="badge ${dealCopy.badgeTone}">${dealCopy.label}</span>
        <h1>${esc(deal.title)}</h1>
        <p class="muted">${availability.message || dealCopy.description}</p>
        <div class="metric-grid">
          <div class="metric"><span class="muted">מחיר ליחידה</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="metric"><span class="muted">כמות שכבר נרשמה</span><strong>${num(metrics.joined_units)} יח'</strong></div>
          <div class="metric"><span class="muted">קיבולת שנותרה</span><strong>${num(metrics.remaining_units)} יח'</strong></div>
        </div>
        <div class="meter"><span style="width:${Math.max(4, metrics.progress_to_capacity_pct)}%"></span></div>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">יעד בסיס לעסקה</span><strong>${num(deal.threshold_units)} יח'</strong></div>
          <div class="summary-item"><span class="muted">מקסימום בעסקה</span><strong>${num(deal.max_units)} יח'</strong></div>
          <div class="summary-item"><span class="muted">סגירת חלון ההצטרפות</span><strong>${dt(deal.deadline)}</strong></div>
          <div class="summary-item"><span class="muted">מספר משתתפים</span><strong>${num(metrics.participants_count)}</strong></div>
        </div>
        ${affiliateRef ? `<div class="info-strip tone-info"><strong>Affiliate attribution active</strong><p class="small">Referral code <span class="mono">${esc(affiliateRef)}</span> will stay attached to this join flow and later appear on the affiliate and admin surfaces.</p></div>` : ""}
        ${flow ? renderExistingFlow(flow, deal.deal_id) : ""}
      </article>
      <aside class="card hero-side stack">
        <h2>${dealCopy.title}</h2>
        <p class="muted">${nextAction.description}</p>
        <form data-action="start-join" class="stack">
          <div class="field">
            <label for="qty">כמה יחידות תרצה להצטרף?</label>
            <input id="qty" name="qty" type="number" min="${deal.min_units}" max="${Math.max(deal.min_units, metrics.remaining_units)}" step="1" value="${qty}" />
          </div>
          ${qtyIssue ? `<div class="error-card compact">${esc(qtyIssue)}</div>` : ""}
          <div class="summary-item">
            <span class="muted">עלות משוערת</span>
            <strong>${currency(Math.max(0, qty) * deal.price_per_unit)}</strong>
            <p class="small muted">בשלב הזה נשמרת תפיסת מסגרת בלבד. חיוב אמיתי יקרה רק אם העסקה תושלם.</p>
          </div>
          <div class="info-strip tone-warning">
            <strong>Demo / preview guardrail</strong>
            <p class="small">This buyer journey is live for showcase purposes, but it must not be described as real charging or commercial checkout.</p>
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
      <article class="card hero-main stack">
        <span class="eyebrow">שלב 1 מתוך 3</span>
        <h1>אימות טלפון לפני הצטרפות</h1>
        <p class="muted">אנחנו מאמתים את הטלפון כדי לשייך את ההשתתפות לקונה הנכון לפני תפיסת מסגרת.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(state.dealPayload?.deal?.title || flow.dealTitle || "עסקה")}</strong></div>
          <div class="summary-item"><span class="muted">כמות שנשמרה</span><strong>${num(flow.qty || 0)} יח'</strong></div>
        </div>
        <div class="status-rail">
          ${renderStep("כמות נשמרה", true)}
          ${renderStep("OTP", Boolean(flow.otpSessionId), flow.otpVerified)}
          ${renderStep("Authorization והצטרפות", Boolean(flow.otpVerified))}
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
          <p class="small muted">אם משהו מרגיש לא עדכני, אפשר לאפס את שלב ה-OTP ולהמשיך מחדש.</p>
        </div>
        <form data-action="otp-start" class="stack">
          <div class="field">
            <label for="phone">מספר טלפון נייד</label>
            <input id="phone" name="phone" type="tel" value="${esc(flow.phone || state.form.phone || "")}" placeholder="0501234567" />
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
              <input id="code" name="code" type="text" inputmode="numeric" value="${esc(state.form.code || "")}" placeholder="123456" />
            </div>
            <div class="actions">
              <button class="primary" type="submit" ${expired ? "disabled" : ""}>אמת והמשך</button>
              <button class="secondary" type="button" data-inline-action="reset-otp">אפס OTP</button>
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
      "הכמות נשמרה, אבל לפני authorization צריך להשלים OTP.",
      `/app/join/${encodeURIComponent(dealId)}/otp`
    );
  }

  const deal = state.dealPayload?.deal;
  const previewPaymentGuardrail = `
    <div class="info-strip tone-warning">
      <strong>Demo payment guardrail</strong>
      <p class="small">This page demonstrates authorization flow only. It must not be presented as live charging, real settlement, or commercial payment processing.</p>
    </div>
  `;
  const previewPaymentNote = `<p class="small muted">Preview mode: this authorization remains mock-backed and never touches a live payment rail.</p>`;
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">שלב 2 מתוך 3</span>
        <h1>אישור מסגרת לפני הצטרפות סופית</h1>
        <p class="muted">זהו שלב authorization בלבד. אין כאן charge מיידי, אלא אישור מסגרת לקראת השלמת העסקה.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(deal?.title || flow.dealTitle || "")}</strong></div>
          <div class="summary-item"><span class="muted">קונה מאומת</span><strong>${esc(flow.buyerId || "")}</strong></div>
          <div class="summary-item"><span class="muted">כמות</span><strong>${num(flow.qty || 0)} יח'</strong></div>
          <div class="summary-item"><span class="muted">עלות משוערת</span><strong>${currency(flow.estimatedTotal || ((flow.qty || 0) * (deal?.price_per_unit || 0)))}</strong></div>
        </div>
        <div class="summary-item">
          <span class="muted">עדכון אחרון למסלול</span>
          <strong>${relativeTime(flow.updatedAt)}</strong>
          <p class="small muted">כך אפשר להבין אם אתה ממשיך מסלול טרי או חוזר אליו אחרי הפסקה.</p>
        </div>
        <div class="info-strip">
          <strong>השלב הזה כבר מוכן יותר לאינטגרציה אמיתית</strong>
          <p class="small">${PAYMENT_READINESS.settlementModel}. כרגע ה-provider הוא <span class="mono">${PAYMENT_READINESS.providerLabel}</span>, אבל ${PAYMENT_READINESS.integrationNote}</p>
        </div>
        <div class="summary-item">
          <span class="muted">מוכנות השלב</span>
          <strong>החוזה מופרד מה-UI</strong>
          <p class="small muted">גם אם שכבת התשלום עדיין mock-backed, הזרימה כבר שומרת גבול ברור בין authorization לבין join.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        ${previewPaymentGuardrail}
        <form data-action="pay" class="stack">
          <div class="field"><label for="holderName">שם בעל הכרטיס</label><input id="holderName" name="holderName" type="text" value="${esc(state.form.holderName)}" autocomplete="cc-name" /></div>
          <div class="field"><label for="cardNumber">מספר כרטיס</label><input id="cardNumber" name="cardNumber" type="text" inputmode="numeric" value="${esc(state.form.cardNumber)}" autocomplete="cc-number" placeholder="4111111111111111" /></div>
          <div class="inline-fields">
            <div class="field"><label for="expiry">תוקף</label><input id="expiry" name="expiry" type="text" value="${esc(state.form.expiry)}" autocomplete="cc-exp" placeholder="12/28" /></div>
            <div class="field"><label for="cvv">CVV</label><input id="cvv" name="cvv" type="password" inputmode="numeric" value="${esc(state.form.cvv)}" autocomplete="cc-csc" placeholder="123" /></div>
          </div>
          <button class="primary" type="submit">אשר מסגרת והשלם הצטרפות</button>
          <p class="small muted">לבדיקת כשל mock אפשר להשתמש בכרטיס שמסתיים ב-0000.</p>
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
      "כדי להגיע למסך האישור צריך לסיים קודם את שלב authorization וההצטרפות.",
      `/app/join/${encodeURIComponent(dealId)}/payment`
    );
  }

  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">שלב 3 מתוך 3</span>
        <span class="badge success">ההצטרפות נשמרה</span>
        <h1>הקונה נרשם לעסקה בהצלחה</h1>
        <p class="muted">השלמנו אימות טלפון, authorization והרשמה לעסקה. מכאן עוברים למעקב עד לסגירת העסקה.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">מזהה השתתפות</span><strong class="mono">${esc(flow.participantId)}</strong></div>
          <div class="summary-item"><span class="muted">מזהה authorization</span><strong class="mono">${esc(flow.authorizationId || "לא זמין")}</strong></div>
          <div class="summary-item"><span class="muted">כמות שנרשמה</span><strong>${num(flow.qty || 0)} יח'</strong></div>
          <div class="summary-item"><span class="muted">מה נשמר עכשיו</span><strong>השתתפות פעילה עם תפיסת מסגרת</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="info-strip tone-success">
          <strong>מה קורה עכשיו?</strong>
          <p class="small">מסך המעקב יראה אם כרגע רק נרשמת, אם החיוב כבר בוצע, ואם העסקה הושלמה או נכשלה.</p>
        </div>
        ${flow.authorizationMessage ? `
          <div class="summary-item">
            <span class="muted">הודעת authorization</span>
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
      <article class="card hero-main stack">
        <span class="eyebrow">מעקב השתתפות</span>
        <span class="badge ${dealState.badgeTone}">${dealState.label}</span>
        <h1>${esc(tracking.deal_title)}</h1>
        <p class="muted">${next.summary}</p>
        <div class="status-grid">
          <div class="status-item"><span class="muted">מצב העסקה</span><strong>${dealState.label}</strong><p class="small muted">${dealState.description}</p></div>
          <div class="status-item"><span class="muted">מצב ההשתתפות</span><strong>${buyerState[0]}</strong><p class="small muted">${buyerState[1]}</p></div>
          <div class="status-item"><span class="muted">מצב כספי</span><strong>${moneyState[0]}</strong><p class="small muted">${moneyState[1]}</p></div>
          <div class="status-item"><span class="muted">עלות משוערת</span><strong>${currency(tracking.estimated_total)}</strong><p class="small muted">${num(tracking.qty)} יח' x ${currency(tracking.price_per_unit)}</p></div>
        </div>
        <div class="stack section compact-section">
          <h3>איפה המסלול שלך עומד?</h3>
          <div class="status-rail tracking-rail">
            ${journey.map((step) => renderStep(step.title, step.done, step.current)).join("")}
          </div>
          <div class="summary-item">
            <span class="muted">מה השלב הבא</span>
            <strong>${next.title}</strong>
            <p class="small muted">${next.detail}</p>
          </div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">מזהה השתתפות</span><strong class="mono">${esc(tracking.participant_id)}</strong></div>
        <div class="summary-item"><span class="muted">מזהה קונה</span><strong>${esc(tracking.buyer_id)}</strong></div>
        ${linkedFlow?.lastTrackingViewedAt ? `<div class="summary-item"><span class="muted">צפייה אחרונה במסלול</span><strong>${dt(linkedFlow.lastTrackingViewedAt)}</strong></div>` : ""}
        ${linkedFlow?.updatedAt ? `<div class="summary-item"><span class="muted">סשן ה-flow עודכן</span><strong>${relativeTime(linkedFlow.updatedAt)}</strong></div>` : ""}
        <div class="summary-item"><span class="muted">חלון ההצטרפות</span><strong>${dt(tracking.deadline)}</strong></div>
        ${tracking.completion_window_until ? `<div class="summary-item"><span class="muted">סיום חלון השלמה</span><strong>${dt(tracking.completion_window_until)}</strong></div>` : ""}
        <div class="actions"><a class="button secondary" href="/app/deal/${encodeURIComponent(tracking.deal_id)}" data-nav="/app/deal/${encodeURIComponent(tracking.deal_id)}">חזרה לעסקה</a></div>
      </aside>
    </section>
  `;
}

function renderMarketplaceCard(item) {
  return `
    <article class="summary-item">
      <div class="actions spread">
        <div>
          <span class="muted">${esc(item.state)}</span>
          <h3>${esc(item.title)}</h3>
        </div>
        <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(item.availability.badge || item.state)}</span>
      </div>
      <p class="small muted">${esc(item.availability.message || "")}</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">Price</span><strong>${currency(item.price_per_unit)}</strong></div>
        <div class="summary-item"><span class="muted">Joined</span><strong>${num(item.metrics.joined_units)}</strong></div>
        <div class="summary-item"><span class="muted">Remaining</span><strong>${num(item.metrics.remaining_units)}</strong></div>
        <div class="summary-item"><span class="muted">Deadline</span><strong>${dt(item.deadline)}</strong></div>
      </div>
      <div class="actions">
        <a class="button primary" href="/app/deal/${encodeURIComponent(item.deal_id)}" data-nav="/app/deal/${encodeURIComponent(item.deal_id)}">Open deal</a>
        <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">Seller view</a>
      </div>
    </article>
  `;
}

function renderSellerPage() {
  const payload = state.sellerPayload?.seller_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("Seller workspace unavailable", "The seller workspace could not be loaded.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Seller surface</span>
        <h1>Seller workspace across all deals</h1>
        <p class="muted">This closes the seller black hole that existed before this task: list, draft, publish, live view, closed view, and create-similar entry are now visible in the product surface.</p>
        <div class="metric-grid">
          <div class="metric"><span class="muted">Total deals</span><strong>${num(payload.totals.total_deals)}</strong></div>
          <div class="metric"><span class="muted">Live deals</span><strong>${num(payload.totals.live_deals)}</strong></div>
          <div class="metric"><span class="muted">Completed deals</span><strong>${num(payload.totals.completed_deals)}</strong></div>
        </div>
        <div class="actions">
          <a class="button primary" href="/app/seller/new" data-nav="/app/seller/new">Create a new deal</a>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">Failed or cancelled</span><strong>${num(payload.totals.failed_or_cancelled)}</strong></div>
        <div class="summary-item"><span class="muted">Editing rule</span><strong>Draft only</strong><p class="small muted">Published deals are locked from editing, matching the current product rule.</p></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>Seller deals</h2>
      <div class="card-list">${payload.deals.map(renderSellerDealCard).join("")}</div>
    </section>
  `;
}

function renderSellerDealCard(item) {
  return `
    <article class="summary-item">
      <div class="actions spread">
        <div>
          <span class="muted">${esc(item.state)}</span>
          <h3>${esc(item.title)}</h3>
        </div>
        <span class="badge ${DEAL_TONE[item.state] || "warning"}">${esc(item.state)}</span>
      </div>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">Joined units</span><strong>${num(item.metrics.joined_units)}</strong></div>
        <div class="summary-item"><span class="muted">Remaining</span><strong>${num(item.metrics.remaining_units)}</strong></div>
        <div class="summary-item"><span class="muted">Commission</span><strong>${num(Math.round((item.commission_rate || 0) * 100))}%</strong></div>
        <div class="summary-item"><span class="muted">Deadline</span><strong>${dt(item.deadline)}</strong></div>
      </div>
      <div class="actions">
        <a class="button primary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">Open seller view</a>
        <a class="button secondary" href="/app/deal/${encodeURIComponent(item.deal_id)}" data-nav="/app/deal/${encodeURIComponent(item.deal_id)}">Open buyer view</a>
      </div>
    </article>
  `;
}

function renderSellerNewPage() {
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Seller creation</span>
        <h1>Create a staged deal</h1>
        <p class="muted">This uses the live backend create endpoint and keeps the current product rule that publish computes the threshold from the minimum quantity.</p>
      </article>
      <aside class="card hero-side stack">
        <form data-action="seller-create" class="stack">
          <div class="field"><label for="sellerTitle">Title</label><input id="sellerTitle" name="sellerTitle" type="text" value="${esc(state.form.sellerTitle)}" /></div>
          <div class="inline-fields">
            <div class="field"><label for="sellerPrice">Price per unit</label><input id="sellerPrice" name="sellerPrice" type="number" step="0.01" value="${esc(state.form.sellerPrice)}" /></div>
            <div class="field"><label for="sellerCommissionRate">Commission rate</label><input id="sellerCommissionRate" name="sellerCommissionRate" type="number" step="0.01" value="${esc(state.form.sellerCommissionRate)}" /></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label for="sellerMinUnits">Minimum units</label><input id="sellerMinUnits" name="sellerMinUnits" type="number" step="1" value="${esc(state.form.sellerMinUnits)}" /></div>
            <div class="field"><label for="sellerMaxUnits">Maximum units</label><input id="sellerMaxUnits" name="sellerMaxUnits" type="number" step="1" value="${esc(state.form.sellerMaxUnits)}" /></div>
          </div>
          <div class="field"><label for="sellerDeadline">Deadline</label><input id="sellerDeadline" name="sellerDeadline" type="datetime-local" value="${esc(state.form.sellerDeadline)}" /></div>
          <button class="primary" type="submit">Create draft deal</button>
        </form>
      </aside>
    </section>
  `;
}

function renderSellerDealPage() {
  const payload = state.sellerDealPayload;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("Seller deal unavailable", "The seller detail view could not be loaded.");
  const deal = payload.deal;
  const receipts = payload.receipts_surface;
  const delivery = payload.delivery_surface;
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Seller detail</span>
        <span class="badge ${DEAL_TONE[deal.state] || "warning"}">${esc(deal.state)}</span>
        <h1>${esc(deal.title)}</h1>
        <p class="muted">Published deals are locked from editing. This seller screen stays aligned to the live backend truth.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">Price per unit</span><strong>${currency(deal.price_per_unit)}</strong></div>
          <div class="summary-item"><span class="muted">Joined units</span><strong>${num(deal.metrics.joined_units)}</strong></div>
          <div class="summary-item"><span class="muted">Participants</span><strong>${num(deal.metrics.participants_count)}</strong></div>
          <div class="summary-item"><span class="muted">Commission</span><strong>${num(Math.round((deal.commission_rate || 0) * 100))}%</strong></div>
        </div>
        <div class="actions">
          ${payload.seller_actions.can_publish ? `<form data-action="seller-publish" data-deal-id="${esc(deal.deal_id)}"><button class="primary" type="submit">Publish deal</button></form>` : ""}
          <button class="secondary" type="button" data-inline-action="seller-clone" data-deal-id="${esc(deal.deal_id)}">Create similar</button>
          <a class="button secondary" href="/app/deal/${encodeURIComponent(deal.deal_id)}" data-nav="/app/deal/${encodeURIComponent(deal.deal_id)}">Public deal page</a>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">Edit status</span><strong>${payload.seller_actions.edit_locked ? "Locked after publish" : "Editable draft"}</strong></div>
        <div class="summary-item"><span class="muted">Created</span><strong>${dt(deal.created_at)}</strong></div>
        <div class="summary-item"><span class="muted">Deadline</span><strong>${dt(deal.deadline)}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>Participants</h2>
      ${payload.participants.length ? renderRowsTable(payload.participants, ["participant_id", "buyer_id", "qty", "buyer_state", "money_state", "created_at"]) : `<p class="muted">No participants joined this deal yet.</p>`}
    </section>
    <section class="card section stack">
      <h2>Payment attempts</h2>
      ${payload.payment_attempts.length ? renderRowsTable(payload.payment_attempts, ["attempt_type", "correlation_id", "result_class", "created_at"]) : `<p class="muted">No payment attempts were recorded yet.</p>`}
    </section>
    <section class="card section stack">
      <h2>Receipts and completed-deal settlement</h2>
      <p class="muted">${esc(receipts.note)}</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">Receipt status</span><strong>${esc(receipts.status)}</strong></div>
        <div class="summary-item"><span class="muted">Gross</span><strong>${currency(receipts.summary.gross_amount)}</strong></div>
        <div class="summary-item"><span class="muted">Siton fee</span><strong>${currency(receipts.summary.siton_fee_amount)}</strong></div>
        <div class="summary-item"><span class="muted">Affiliate allocation</span><strong>${currency(receipts.summary.affiliate_fee_amount)}</strong></div>
        <div class="summary-item"><span class="muted">Seller net</span><strong>${currency(receipts.summary.seller_net_amount)}</strong></div>
        <div class="summary-item"><span class="muted">Documents</span><strong>${num(receipts.summary.receipt_document_count)}</strong></div>
      </div>
      ${receipts.documents.length ? renderRowsTable(receipts.documents, ["receipt_id", "participant_id", "buyer_id", "qty", "gross_amount", "affiliate_name", "affiliate_fee_amount", "payout_status"]) : `<p class="muted">No seller receipts are issuable yet. Only Completed deals with ChargedSuccess or RecoveredCharge buyers generate a receipt surface.</p>`}
      <p class="small muted">Demo note: this is an internal receipt/readiness surface, not an externally issued invoice or accounting document.</p>
    </section>
    <section class="card section stack">
      <h2>Delivery operations</h2>
      <p class="muted">${esc(delivery.note)}</p>
      ${delivery.rows.length ? `<div class="card-list">${delivery.rows.map((row) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(row.status)}</span>
              <h3>${esc(row.buyer_id)}</h3>
            </div>
            <strong>${num(row.qty)} units</strong>
          </div>
          <p class="small muted">Tracking: ${esc(row.tracking_number || "not set")} • Financial state: ${esc(row.money_state)}</p>
          <p class="small muted">Use shipped or delivered only with a tracking number. Use issue only when you also explain the problem.</p>
          <form class="stack" data-action="seller-delivery-update" data-deal-id="${esc(deal.deal_id)}" data-participant-id="${esc(row.participant_id)}">
            <div class="inline-fields">
              <div class="field">
                <label>Status</label>
                <select name="deliveryStatus">
                  ${["ready_to_fulfill","shipped","delivered","issue"].map((option) => `<option value="${option}" ${row.status === option ? "selected" : ""}>${option}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>Tracking number</label>
                <input name="trackingNumber" type="text" value="${esc(row.tracking_number || "")}" />
              </div>
            </div>
            <div class="field">
              <label>Issue note</label>
              <input name="issueNote" type="text" value="${esc(row.issue_note || "")}" placeholder="Optional seller issue note" />
            </div>
            <button class="secondary" type="submit">Save delivery update</button>
          </form>
        </article>
      `).join("")}</div>` : `<p class="muted">Delivery becomes active only for buyers whose payment ended in ChargedSuccess or RecoveredCharge on a Completed deal.</p>`}
      <p class="small muted">Demo note: delivery updates model fulfillment workflow and tracking semantics only. They do not claim live carrier execution.</p>
    </section>
  `;
}

function renderAffiliatePage() {
  const payload = state.affiliatePayload?.affiliate_surface;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("Affiliate workspace unavailable", "The affiliate workspace could not be loaded.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Affiliate / distributor</span>
        <h1>Affiliate share surface</h1>
        <p class="muted">This area now exists in the product, but it also honestly marks the backend gaps that still block full affiliate closure.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">Attribution</span><strong>${esc(payload.attribution_status)}</strong></div>
          <div class="summary-item"><span class="muted">Payout status</span><strong>${esc(payload.payout_status)}</strong></div>
          <div class="summary-item"><span class="muted">Verification</span><strong>${esc(payload.verification_status)}</strong></div>
          <div class="summary-item"><span class="muted">Payout method</span><strong>${esc(payload.payout_method)}</strong></div>
        </div>
        <div class="info-strip tone-info">
          <strong>Internal-ready note</strong>
          <p>${esc(payload.note)}</p>
        </div>
        <div class="info-strip tone-warning">
          <strong>Preview payout boundary</strong>
          <p>Affiliate payout states shown here are readiness and settlement semantics only. No external payout rail is active in demo / preview deployment.</p>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">Campaigns surfaced</span><strong>${num(payload.campaigns.length)}</strong></div>
        <div class="summary-item"><span class="muted">Payout details</span><strong>${esc(payload.payout_details_masked)}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>Affiliate totals</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">Attributed buyers</span><strong>${num(payload.totals.total_attributions)}</strong></div>
        <div class="summary-item"><span class="muted">Pending commissions</span><strong>${currency(payload.totals.pending_commission)}</strong></div>
        <div class="summary-item"><span class="muted">Approved commissions</span><strong>${currency(payload.totals.approved_commission)}</strong></div>
        <div class="summary-item"><span class="muted">Paid commissions</span><strong>${currency(payload.totals.paid_commission)}</strong></div>
      </div>
      <div class="summary-item">
        <span class="muted">Verification admin note</span>
        <strong>${esc(payload.verification_surface.admin_note || "No admin note yet")}</strong>
      </div>
      <form class="stack" data-action="affiliate-save-payout">
        <div class="inline-fields">
          <div class="field">
            <label>Payout method</label>
            <select name="affiliatePayoutMethod">
              ${["bank_transfer","manual_wire"].map((option) => `<option value="${option}" ${payload.payout_method === option ? "selected" : ""}>${option}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Bank / payout details</label>
            <input name="affiliatePayoutDetails" type="text" placeholder="IBAN / account / descriptor" />
          </div>
        </div>
        <button class="primary" type="submit">Save payout readiness profile</button>
      </form>
    </section>
    <section class="card section stack">
      <h2>Available affiliate campaigns</h2>
      <div class="card-list">
        ${payload.campaigns.map((campaign) => `
          <article class="summary-item">
            <span class="muted">${esc(campaign.state)}</span>
            <h3>${esc(campaign.title)}</h3>
            <p class="small muted">Commission: ${num(Math.round((campaign.commission_rate || 0) * 100))}%</p>
            <p class="small muted">Attributed buyers: ${num(campaign.attributed_buyers)} • Pending ${currency(campaign.pending_commission)} • Approved ${currency(campaign.approved_commission)} • Paid ${currency(campaign.paid_commission)}</p>
            <p class="small mono">${esc(campaign.share_link)}</p>
            <div class="actions">
              <a class="button secondary" href="/app/deal/${encodeURIComponent(campaign.deal_id)}" data-nav="/app/deal/${encodeURIComponent(campaign.deal_id)}">Open deal</a>
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
  if (!payload) return renderEmptyState("Admin workspace unavailable", "The admin surface could not be loaded.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Admin surface</span>
        <h1>Operational visibility across the product</h1>
        <p class="muted">This closes the previous gap where product operation existed mostly as raw endpoints rather than an admin-facing surface.</p>
        <form class="stack" data-action="admin-search">
          <div class="field">
            <label for="adminQuery">Omnisearch</label>
            <input id="adminQuery" name="adminQuery" type="search" value="${esc(state.form.adminQuery)}" placeholder="deal id, title, participant id, buyer id" />
          </div>
          <button class="primary" type="submit">Search</button>
        </form>
        <div class="metric-grid">
          <div class="metric"><span class="muted">Deals</span><strong>${num(payload.totals.deals)}</strong></div>
          <div class="metric"><span class="muted">Live deals</span><strong>${num(payload.totals.live)}</strong></div>
          <div class="metric"><span class="muted">Exceptional deals</span><strong>${num(payload.totals.exceptional)}</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="summary-item"><span class="muted">Draft deals</span><strong>${num(payload.totals.draft)}</strong></div>
        <div class="summary-item"><span class="muted">System status</span><strong>${systemStatus?.app_health?.ok ? "Healthy" : "Needs attention"}</strong></div>
        <div class="summary-item"><span class="muted">Runtime mode</span><strong>${esc(systemStatus?.deployment?.mode || state.previewMeta?.preview?.deployment_mode || "preview")}</strong></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>Exceptional deals</h2>
      ${payload.exceptional_deals.length ? `<div class="card-list">${payload.exceptional_deals.map(renderAdminDealCard).join("")}</div>` : `<p class="muted">No exceptional deals were returned.</p>`}
    </section>
    <section class="card section stack">
      <h2>Omnisearch results</h2>
      ${payload.search_results.length ? renderRowsTable(payload.search_results, ["entity_type", "entity_id", "headline", "state", "detail"]) : `<p class="muted">No search results yet. Run omnisearch to inspect deals, participants, or buyers.</p>`}
    </section>
    <section class="card section stack">
      <h2>KYC and verification queue</h2>
      ${payload.kyc_queue.length ? `<div class="card-list">${payload.kyc_queue.map((item) => `
        <article class="summary-item stack">
          <div class="actions spread">
            <div>
              <span class="muted">${esc(item.subject_type)}</span>
              <h3>${esc(item.display_name)}</h3>
            </div>
            <strong>${esc(item.status)}</strong>
          </div>
          <p class="small muted">Detail: ${esc(item.detail || "n/a")} • Updated ${dt(item.updated_at)}</p>
          <div class="actions">
            <form data-action="admin-kyc-decision" data-subject-type="${esc(item.subject_type)}" data-subject-id="${esc(item.subject_id)}" data-decision="approve" class="stack">
              <input type="hidden" name="adminNote" value="Approved during remaining-surface closure pass" />
              <button class="secondary" type="submit">Approve</button>
            </form>
            <form data-action="admin-kyc-decision" data-subject-type="${esc(item.subject_type)}" data-subject-id="${esc(item.subject_id)}" data-decision="reject" class="stack">
              <input type="hidden" name="adminNote" value="Rejected during remaining-surface closure pass" />
              <button class="secondary" type="submit">Reject</button>
            </form>
          </div>
        </article>
      `).join("")}</div>` : `<p class="muted">No KYC items are currently waiting in the queue.</p>`}
    </section>
    <section class="card section stack">
      <h2>Settlements and payouts</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">Seller completed deals</span><strong>${num(payload.settlements.seller_workspace.completed_deals)}</strong></div>
        <div class="summary-item"><span class="muted">Seller gross</span><strong>${currency(payload.settlements.seller_workspace.gross_amount)}</strong></div>
        <div class="summary-item"><span class="muted">Platform fee</span><strong>${currency(payload.settlements.seller_workspace.platform_fee_amount)}</strong></div>
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
          <p class="small muted">Pending ${currency(item.pending_commission)} • Approved ${currency(item.approved_commission)} • Paid ${currency(item.paid_commission)}</p>
          <form data-action="admin-affiliate-payout" data-affiliate-id="${esc(item.affiliate_id)}" class="inline-fields">
            <div class="field">
              <label>Payout status</label>
              <select name="affiliatePayoutStatus">
                ${["pending_review","approved","paid","hold"].map((option) => `<option value="${option}" ${item.payout_status === option ? "selected" : ""}>${option}</option>`).join("")}
              </select>
            </div>
            <button class="secondary" type="submit">Update payout</button>
          </form>
        </article>
      `).join("")}</div>` : `<p class="muted">No affiliate settlement rows are available yet.</p>`}
    </section>
    <section class="card section stack">
      <h2>Support hub</h2>
      <form class="stack" data-action="admin-support-create">
        <div class="inline-fields">
          <div class="field">
            <label>Scope type</label>
            <select name="supportScopeType">
              ${["deal","participant","affiliate","seller","system"].map((option) => `<option value="${option}">${option}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Scope key</label>
            <input name="supportScopeKey" type="text" placeholder="deal id / participant id / seller-default" />
          </div>
        </div>
        <div class="field"><label>Title</label><input name="supportTitle" type="text" placeholder="Support summary" /></div>
        <div class="inline-fields">
          <div class="field">
            <label>Priority</label>
            <select name="supportPriority">
              <option value="normal">normal</option>
              <option value="high">high</option>
            </select>
          </div>
          <div class="field"><label>Summary</label><input name="supportSummary" type="text" placeholder="What needs investigation?" /></div>
        </div>
        <button class="primary" type="submit">Create support ticket</button>
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
          <p class="small muted">${esc(ticket.summary || "No summary")} • ${esc(ticket.priority)}</p>
          <form data-action="admin-support-update" data-ticket-id="${esc(ticket.ticket_id)}" class="inline-fields">
            <div class="field">
              <label>Status</label>
              <select name="supportTicketStatus">
                ${["open","investigating","resolved"].map((option) => `<option value="${option}" ${ticket.status === option ? "selected" : ""}>${option}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Summary</label>
              <input name="supportTicketSummary" type="text" value="${esc(ticket.summary || "")}" />
            </div>
            <button class="secondary" type="submit">Save ticket</button>
          </form>
        </article>
      `).join("")}</div>` : `<p class="muted">No support tickets exist yet.</p>`}
    </section>
    <section class="card section stack">
      <h2>Forensics and system depth</h2>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">DLQ count</span><strong>${num(payload.forensics.dlq_count)}</strong></div>
        <div class="summary-item"><span class="muted">Failed webhooks</span><strong>${num(payload.forensics.failed_webhooks)}</strong></div>
        <div class="summary-item"><span class="muted">Ignored webhooks</span><strong>${num(payload.forensics.ignored_webhooks)}</strong></div>
        <div class="summary-item"><span class="muted">Pending webhooks</span><strong>${num(payload.forensics.pending_webhooks)}</strong></div>
        <div class="summary-item"><span class="muted">Recent audit events</span><strong>${num(payload.forensics.recent_audit_events)}</strong></div>
      </div>
    </section>
    <section class="card section stack">
      <h2>System status</h2>
      ${systemStatus ? `
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">App health</span><strong>${systemStatus.app_health.ok ? "ok" : "degraded"}</strong></div>
          <div class="summary-item"><span class="muted">Payment mode</span><strong>${esc(systemStatus.integrations.payment.mode)}</strong></div>
          <div class="summary-item"><span class="muted">Notifications</span><strong>${esc(systemStatus.integrations.notifications.mode)}</strong></div>
          <div class="summary-item"><span class="muted">Active outbox</span><strong>${num(systemStatus.operational_counts.active_outbox)}</strong></div>
          <div class="summary-item"><span class="muted">DLQ count</span><strong>${num(systemStatus.operational_counts.dlq_count)}</strong></div>
          <div class="summary-item"><span class="muted">Pending webhooks</span><strong>${num(systemStatus.operational_counts.pending_webhooks)}</strong></div>
          <div class="summary-item"><span class="muted">Failed webhooks</span><strong>${num(systemStatus.operational_counts.failed_webhooks)}</strong></div>
          <div class="summary-item"><span class="muted">Open support tickets</span><strong>${num(systemStatus.operational_counts.open_support_tickets)}</strong></div>
        </div>
        <div class="info-strip tone-info">
          <strong>External activation boundary</strong>
          <p>${esc(systemStatus.notes.join(" "))}</p>
        </div>
      ` : `<p class="muted">System status could not be loaded.</p>`}
    </section>
  `;
}

function renderAdminDealCard(item) {
  return `
    <article class="summary-item">
      <span class="muted">${esc(item.state)}</span>
      <h3>${esc(item.title)}</h3>
      <p class="small muted">Joined ${num(item.metrics.joined_units)} / ${num(item.max_units)} units</p>
      <div class="actions">
        <a class="button primary" href="/app/admin/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/admin/deals/${encodeURIComponent(item.deal_id)}">Open admin profile</a>
        <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(item.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(item.deal_id)}">Seller profile</a>
      </div>
    </article>
  `;
}

function renderAdminDealPage() {
  const payload = state.adminDealPayload?.profile;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("Admin deal profile unavailable", "The admin deal profile could not be loaded.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Admin deal profile</span>
        <h1>${esc(payload.deal.title || payload.deal.deal_id)}</h1>
        <p class="muted">Cross-surface truth for deal state, participants, outbox, payment attempts, and audit.</p>
        ${renderRowsTable([payload.deal], ["deal_id", "state", "price_per_unit", "min_units", "max_units", "threshold_units", "deadline", "commission_rate"])}
      </article>
      <aside class="card hero-side stack">
        <div class="actions">
          <a class="button secondary" href="/app/admin" data-nav="/app/admin">Back to admin</a>
          <a class="button secondary" href="/app/seller/deals/${encodeURIComponent(payload.deal.deal_id)}" data-nav="/app/seller/deals/${encodeURIComponent(payload.deal.deal_id)}">Open seller view</a>
        </div>
      </aside>
    </section>
    <section class="card section stack"><h2>Participants</h2>${payload.participants.length ? renderRowsTable(payload.participants, ["participant_id", "buyer_id", "qty", "buyer_state", "money_state", "created_at"]) : `<p class="muted">No participants found.</p>`}</section>
    <section class="card section stack"><h2>Outbox</h2>${payload.outbox.length ? renderRowsTable(payload.outbox, ["event_type", "status", "available_at", "created_at"]) : `<p class="muted">No outbox rows found.</p>`}</section>
    <section class="card section stack"><h2>Payment attempts</h2>${payload.payment_attempts.length ? renderRowsTable(payload.payment_attempts, ["attempt_type", "correlation_id", "result_class", "created_at"]) : `<p class="muted">No payment attempts found.</p>`}</section>
    <section class="card section stack"><h2>Affiliate attributions</h2>${payload.affiliate_attributions.length ? renderRowsTable(payload.affiliate_attributions, ["participant_id", "share_code", "display_name", "commission_amount", "payout_status"]) : `<p class="muted">No affiliate attributions found.</p>`}</section>
    <section class="card section stack"><h2>Delivery records</h2>${payload.delivery.length ? renderRowsTable(payload.delivery, ["participant_id", "status", "tracking_number", "issue_note", "updated_at"]) : `<p class="muted">No delivery rows found.</p>`}</section>
    <section class="card section stack"><h2>Support tickets</h2>${payload.support_tickets.length ? renderRowsTable(payload.support_tickets, ["ticket_id", "scope_type", "scope_key", "title", "priority", "status", "updated_at"]) : `<p class="muted">No support tickets found for this deal.</p>`}</section>
    <section class="card section stack"><h2>Audit</h2>${payload.audit.length ? renderRowsTable(payload.audit, ["entity_type", "state_type", "from_state", "to_state", "action_name", "created_at"]) : `<p class="muted">No audit rows found.</p>`}</section>
  `;
}

function renderAdminUserPage() {
  const payload = state.adminUserPayload?.profile;
  if (!payload && state.loading) return "";
  if (!payload) return renderEmptyState("User profile unavailable", "The admin user profile could not be loaded.");
  return `
    <section class="hero">
      <article class="card hero-main stack">
        <span class="eyebrow">Admin user profile</span>
        <h1>${esc(payload.buyer_id)}</h1>
        <p class="muted">This profile aggregates all joins currently stored for the buyer identifier that came through OTP verification.</p>
        <div class="summary-grid">
          <div class="summary-item"><span class="muted">Total joins</span><strong>${num(payload.totals.total_joins)}</strong></div>
          <div class="summary-item"><span class="muted">Active joins</span><strong>${num(payload.totals.active_joins)}</strong></div>
        </div>
      </article>
      <aside class="card hero-side stack">
        <div class="actions"><a class="button secondary" href="/app/admin" data-nav="/app/admin">Back to admin</a></div>
      </aside>
    </section>
    <section class="card section stack">
      <h2>Join history</h2>
      ${payload.joins.length ? renderRowsTable(payload.joins, ["participant_id", "deal_id", "title", "deal_state", "qty", "buyer_state", "money_state", "created_at"]) : `<p class="muted">No joins were found for this buyer id.</p>`}
    </section>
  `;
}

function renderRowsTable(rows, columns) {
  return `
    <div class="table-like">
      <div class="table-row table-head">${columns.map((column) => `<span>${esc(column)}</span>`).join("")}</div>
      ${rows.map((row) => `<div class="table-row">${columns.map((column) => `<span>${esc(formatCell(row[column]))}</span>`).join("")}</div>`).join("")}
    </div>
  `;
}

function formatCell(value) {
  if (value === null || value === undefined || value === "") return "n/a";
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

function renderNav() {
  return `
      <nav class="page-nav">
        <div class="actions">
          <a href="/app" data-nav="/app" class="button secondary">Siton</a>
          <a href="/app/seller" data-nav="/app/seller" class="button secondary">Seller</a>
          <a href="/app/affiliate" data-nav="/app/affiliate" class="button secondary">Affiliate</a>
          <a href="/app/admin" data-nav="/app/admin" class="button secondary">Admin</a>
        </div>
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
      <span class="journey-bullet">${done ? "✓" : current ? "•" : ""}</span>
      <span>${esc(title)}</span>
    </div>
  `;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (response.ok) return payload;
  const error = new Error(payload?.message || payload?.error || fallbackStatus(response.status) || "request_failed");
  error.status = response.status;
  throw error;
}

const paymentService = {
  authorize(paymentDetails) {
    return api("/api/payments/authorize-mock", {
      method: "POST",
      body: json(paymentDetails)
    });
  }
};

const buyerFlowService = {
  joinDeal(dealId, { buyerId, qty, affiliateRef }) {
    return api(`/deals/${encodeURIComponent(dealId)}/join`, {
      method: "POST",
      headers: {
        "x-request-id": `frontend:${Date.now()}`,
        "idempotency-key": `frontend:${dealId}:${buyerId}:${qty}`
      },
      body: json({ buyer_id: buyerId, qty, affiliate_ref: affiliateRef || undefined })
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
    return { title: "אין סשן OTP פעיל", message: "נראה שהסשן הקודם כבר לא זמין. אפשר לבקש קוד חדש ולחדש את הזרימה." };
  }
  if (lower.includes("authorization failed")) {
    return { title: "אישור המסגרת נכשל", message: "אמצעי התשלום נדחה על ידי שכבת ה-authorization הקיימת. אפשר לנסות אמצעי אחר." };
  }
  if (status >= 500 || lower.includes("fetch")) {
    return { title: "המערכת כרגע לא זמינה", message: "לא הצלחנו להשלים את הפעולה בגלל בעיית שרת או חיבור. כדאי לנסות שוב בעוד רגע." };
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
  if (!Number.isInteger(qty) || qty <= 0) return "יש להזין כמות שלמה וחיובית.";
  const min = Number(payload.deal.min_units || 1);
  const left = Number(payload.metrics.remaining_units || 0);
  if (qty < min) return `כמות ההצטרפות המינימלית היא ${min} יחידות.`;
  if (qty > left) return `כרגע נותרו רק ${left} יחידות פנויות לעסקה הזו.`;
  return "";
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
  if (flow.updatedAt && Date.now() - new Date(flow.updatedAt).getTime() > FLOW_TTL_MS) {
    removeFlow(dealId);
    return null;
  }
  return flow;
}

function saveFlow(dealId, next) {
  const all = readFlow();
  all[dealId] = { ...(all[dealId] || {}), ...next, updatedAt: new Date().toISOString() };
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

function hydrateForm() {
  const routeDealId = state.route.dealId;
  if (!routeDealId) return;
  const flow = getFlow(routeDealId);
  if (!flow) return;
  hydrateFormFromFlow(flow);
}

function hydrateFormFromFlow(flow) {
  state.form.qty = String(flow.qty || state.form.qty);
  state.form.phone = flow.phone || "";
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
      description: "המסלול ייקח אותך דרך OTP, authorization ושמירת ההשתתפות."
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
    { title: "יש authorization", done: authorizationDone, current: tracking.money_state === "AuthHeld" || tracking.money_state === "AuthLocked" },
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
      detail: "נרשמת בהצלחה, בוצע authorization, ועכשיו ממתינים לשלב הבא בעסקה עצמה.",
      summary: "השתתפת בהצלחה. עדיין אין charge, ורק נשמר authorization."
    };
  }
  if (tracking.money_state === "ChargeAttempt" || tracking.buyer_state === "ChargingAttempt") {
    return {
      title: "המערכת מנסה לחייב כרגע",
      detail: "זהו שלב תפעולי. אין צורך בפעולה מצד הקונה כרגע.",
      summary: "העסקה הגיעה לשלב החיוב והמערכת מנסה לבצע charge."
    };
  }
  if (tracking.buyer_state === "ChargeFailedCompletion" || tracking.money_state === "ChargeFailedRecovery") {
    return {
      title: "המערכת מנסה להשלים את ההשתתפות",
      detail: "כרגע אין צעד ידני נוסף במסך הזה. התוצאה תתעדכן לפי recovery או drop.",
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
