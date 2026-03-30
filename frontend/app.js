const root = document.getElementById("app");
const FLOW_KEY = "siton_flow_v1";
const S = {
  loading: false,
  route: parseRoute(location.pathname),
  deal: null,
  tracking: null,
  error: null,
  form: { qty: "1", phone: "", code: "", holderName: "", cardNumber: "", expiry: "", cvv: "" }
};

const DEAL = {
  Draft: ["טיוטה", "העסקה טרם פורסמה ואינה פתוחה להצטרפות."],
  PendingTarget: ["פתוחה להצטרפות", "העסקה אוספת התחייבויות ועדיין פתוחה לקונים."],
  TargetReached: ["היעד הושג", "היעד הושג אבל חלון ההצטרפות עדיין פתוח."],
  ClosedForJoining: ["סגורה להצטרפות", "אי אפשר יותר להצטרף לעסקה."],
  ReadyForCharging: ["מוכנה לחיוב", "העסקה עברה לשלב ההכנה לחיוב."],
  Charging: ["בחיוב", "המערכת מבצעת ניסיונות חיוב."],
  CompletionWindow: ["חלון השלמה", "יש חיובים שדורשים השלמה."],
  Completed: ["הושלמה", "העסקה הושלמה בהצלחה."],
  Failed: ["נכשלה", "העסקה לא הושלמה."],
  Cancelled: ["בוטלה", "העסקה בוטלה."]
};

const BUYER = {
  JoinedAuthorized: ["הצטרף ואושר", "ההשתתפות נקלטה ויש authorization."],
  LockedIn: ["נעול", "ההשתתפות ננעלה לקראת חיוב."],
  ChargingAttempt: ["בניסיון חיוב", "מתבצע ניסיון חיוב."],
  ChargedSuccess: ["חויב", "החיוב הצליח."],
  ChargeFailedCompletion: ["כשל בחיוב", "החיוב נכשל וההשתתפות בחלון השלמה."],
  Recovered: ["שוחזר", "ההשתתפות הושלמה במסלול recovery."],
  Dropped: ["נשמט", "ההשתתפות ירדה מהעסקה."],
  DealCompleted: ["עסקה הושלמה", "העסקה הושלמה."],
  DealFailed: ["עסקה נכשלה", "העסקה נכשלה."]
};

const MONEY = {
  AuthHeld: ["מסגרת תפוסה", "בוצע authorization בלבד."],
  AuthLocked: ["מסגרת נעולה", "האישור ננעל לקראת חיוב."],
  ChargeAttempt: ["ניסיון חיוב", "המערכת מנסה לבצע charge."],
  ChargedSuccess: ["חויב", "החיוב הושלם."],
  ChargeFailedRecovery: ["כשל בחיוב", "נדרש recovery."],
  RecoveredCharge: ["שוחזר", "החיוב הושלם במסלול recovery."],
  AuthReleased: ["האישור שוחרר", "לא התבצע חיוב בפועל."],
  Refunded: ["זוכה", "בוצע refund."]
};

addEventListener("popstate", () => routeTo(location.pathname, false));
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-nav]");
  if (!a) return;
  e.preventDefault();
  routeTo(a.getAttribute("data-nav"));
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
  if (t.name in S.form) S.form[t.name] = t.value;
});
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.action) return;
  e.preventDefault();
  void submitAction(form.dataset.action, form);
});

boot();

async function boot() {
  hydrateForm();
  render();
  await runRoute();
}

function parseRoute(path) {
  const p = (path.replace(/\/+$/, "") || "/");
  if (p === "/" || p === "/app") return { name: "home" };
  const patterns = [
    ["deal", /^\/app\/deal\/([^/]+)$/],
    ["otp", /^\/app\/join\/([^/]+)\/otp$/],
    ["payment", /^\/app\/join\/([^/]+)\/payment$/],
    ["confirmation", /^\/app\/join\/([^/]+)\/confirmation$/],
    ["tracking", /^\/app\/track\/([^/]+)$/]
  ];
  for (const [name, rx] of patterns) {
    const m = p.match(rx);
    if (!m) continue;
    return name === "tracking" ? { name, participantId: decodeURIComponent(m[1]) } : { name, dealId: decodeURIComponent(m[1]) };
  }
  return { name: "not-found" };
}

function routeTo(path, push = true) {
  if (push) history.pushState({}, "", path);
  S.route = parseRoute(path);
  S.error = null;
  render();
  void runRoute();
}

async function runRoute() {
  const r = S.route;
  if (r.name === "deal") return loadDeal(r.dealId);
  if (r.name === "tracking") return loadTracking(r.participantId);
  if (["otp", "payment", "confirmation"].includes(r.name)) {
    await ensureDeal(r.dealId);
    const flow = getFlow(r.dealId);
    if (r.name === "payment" && !flow?.otpVerified) routeTo(`/app/join/${encodeURIComponent(r.dealId)}/otp`);
    if (r.name === "confirmation" && !flow?.participantId) routeTo(`/app/deal/${encodeURIComponent(r.dealId)}`);
  }
}

async function ensureDeal(dealId) {
  if (S.deal?.deal?.deal_id === dealId) return;
  await loadDeal(dealId);
}

async function loadDeal(dealId) {
  await busy(async () => {
    S.deal = await api(`/api/deals/${encodeURIComponent(dealId)}/public`);
    S.form.qty = String(getFlow(dealId)?.qty || Math.max(1, S.deal.deal.min_units || 1));
  }, "טעינת העסקה נכשלה.");
}

async function loadTracking(id) {
  await busy(async () => {
    S.tracking = await api(`/api/participants/${encodeURIComponent(id)}/tracking`);
  }, "טעינת המעקב נכשלה.");
}

async function submitAction(action, form) {
  if (action === "start-join") return startJoin();
  if (action === "otp-start") return otpStart(form);
  if (action === "otp-verify") return otpVerify(form);
  if (action === "pay") return payAndJoin(form);
}

function startJoin() {
  const d = S.deal;
  if (!d?.deal) return;
  const qty = Number(S.form.qty);
  const issue = validateQty(d, qty);
  if (issue) return fail("צריך לעדכן את הכמות", issue);
  saveFlow(d.deal.deal_id, { dealId: d.deal.deal_id, dealTitle: d.deal.title, qty, estimatedTotal: qty * d.deal.price_per_unit });
  routeTo(`/app/join/${encodeURIComponent(d.deal.deal_id)}/otp`);
}

async function otpStart(form) {
  const r = S.route;
  if (r.name !== "otp") return;
  const phone = String(new FormData(form).get("phone") || "").trim();
  if (!phone) return fail("חסר מספר טלפון", "יש להזין מספר טלפון כדי להמשיך.");
  await busy(async () => {
    const data = await api("/api/otp/start", { method: "POST", body: json({ phone }) });
    saveFlow(r.dealId, { phone, otpSessionId: data.otp_session_id, otpMaskedDestination: data.masked_destination, otpExpiresAt: data.expires_at, developmentCode: data.development_code });
    S.form.phone = phone;
    S.form.code = "";
  }, "שליחת קוד האימות נכשלה.");
}

async function otpVerify(form) {
  const r = S.route;
  const flow = r.name === "otp" ? getFlow(r.dealId) : null;
  if (!flow?.otpSessionId) return fail("אין סשן אימות פעיל", "צריך לבקש קוד חדש לפני אימות.");
  const code = String(new FormData(form).get("code") || "").trim();
  if (!code) return fail("חסר קוד אימות", "יש להזין את קוד ה-OTP.");
  await busy(async () => {
    const data = await api("/api/otp/verify", { method: "POST", body: json({ otp_session_id: flow.otpSessionId, code }) });
    saveFlow(r.dealId, { buyerId: data.buyer_id, otpVerified: true });
    routeTo(`/app/join/${encodeURIComponent(r.dealId)}/payment`);
  }, "אימות הקוד נכשל.");
}

async function payAndJoin(form) {
  const r = S.route;
  const flow = r.name === "payment" ? getFlow(r.dealId) : null;
  if (!flow?.otpVerified || !flow?.buyerId) return routeTo(`/app/join/${encodeURIComponent(r.dealId)}/otp`);
  const fd = new FormData(form);
  const pay = {
    holder_name: String(fd.get("holderName") || "").trim(),
    card_number: String(fd.get("cardNumber") || "").replace(/\s+/g, ""),
    expiry: String(fd.get("expiry") || "").trim(),
    cvv: String(fd.get("cvv") || "").trim()
  };
  const issue = validatePayment(pay);
  if (issue) return fail("פרטי האשראי לא מלאים", issue);
  await busy(async () => {
    const auth = await api("/api/payments/authorize-mock", { method: "POST", body: json(pay) });
    const join = await api(`/deals/${encodeURIComponent(r.dealId)}/join`, {
      method: "POST",
      headers: { "x-request-id": `frontend:${Date.now()}`, "idempotency-key": `frontend:${r.dealId}:${flow.buyerId}:${flow.qty}` },
      body: json({ buyer_id: flow.buyerId, qty: flow.qty })
    });
    saveFlow(r.dealId, { authorizationId: auth.authorization_id, paymentAuthorized: true, participantId: join.participant_id });
    routeTo(`/app/join/${encodeURIComponent(r.dealId)}/confirmation`);
  }, "תפיסת המסגרת או ההצטרפות נכשלו.");
}

async function busy(fn, fallback) {
  S.loading = true;
  S.error = null;
  render();
  try {
    await fn();
  } catch (e) {
    S.error = friendlyError(e, fallback);
  } finally {
    S.loading = false;
    render();
  }
}

function render() {
  root.innerHTML = `<main class="shell">${nav()}${S.error ? errorCard(S.error) : ""}${S.loading ? info("טוען נתונים...") : ""}${view()}</main>`;
}

function view() {
  const r = S.route;
  if (r.name === "home") return homeView();
  if (r.name === "deal") return dealView();
  if (r.name === "otp") return otpView(r.dealId);
  if (r.name === "payment") return paymentView(r.dealId);
  if (r.name === "confirmation") return confirmationView(r.dealId);
  if (r.name === "tracking") return trackingView();
  return empty("העמוד לא נמצא", "בדוק את הקישור או חזור למסך הבית.");
}

function homeView() {
  return `<section class="hero">
    <article class="card hero-main stack">
      <span class="eyebrow">Siton Frontend</span>
      <h1>הזרימה המרכזית של הקונה מחוברת לבקאנד החי</h1>
      <p class="muted">נקודת הכניסה האמיתית היא קישור עסקה ציבורי. משם ממשיכים ל-OTP, לתפיסת מסגרת, לאישור ולמעקב.</p>
      <div class="summary-item"><span class="mono">/app/deal/&lt;dealId&gt;</span></div>
    </article>
    <aside class="card hero-side stack">
      <div class="summary-item"><strong>מוכלל עכשיו</strong><p class="muted">Deal page, join flow, OTP, payment auth mock, confirmation, tracking.</p></div>
    </aside>
  </section>`;
}

function dealView() {
  if (!S.deal && S.loading) return "";
  if (!S.deal) return empty("העסקה לא זמינה", "לא הצלחנו לטעון את העסקה או שהיא לא קיימת.");
  const { deal, metrics, availability } = S.deal;
  const qty = Number(S.form.qty || deal.min_units || 1);
  const issue = validateQty(S.deal, qty);
  return `<section class="hero">
    <article class="card hero-main stack">
      <span class="eyebrow">עסקה ציבורית</span>
      <span class="badge ${availability.canJoin ? "success" : availability.reasonCode === "stock_exhausted" ? "warning" : "danger"}">${availability.badge || dealLabel(deal.state)[0]}</span>
      <h1>${esc(deal.title)}</h1>
      <p class="muted">${availability.message || dealLabel(deal.state)[1]}</p>
      <div class="metric-grid">
        <div class="metric"><span class="muted">מחיר ליחידה</span><strong>${currency(deal.price_per_unit)}</strong></div>
        <div class="metric"><span class="muted">כבר הצטרפו</span><strong>${num(metrics.joined_units)} יח'</strong></div>
        <div class="metric"><span class="muted">נותר פנוי</span><strong>${num(metrics.remaining_units)} יח'</strong></div>
      </div>
      <div class="meter"><span style="width:${Math.max(6, metrics.progress_to_capacity_pct)}%"></span></div>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">יעד סף</span><strong>${num(deal.threshold_units)} יח'</strong></div>
        <div class="summary-item"><span class="muted">מקסימום יחידות</span><strong>${num(deal.max_units)} יח'</strong></div>
        <div class="summary-item"><span class="muted">סגירת חלון</span><strong>${dt(deal.deadline)}</strong></div>
        <div class="summary-item"><span class="muted">משתתפים</span><strong>${num(metrics.participants_count)}</strong></div>
      </div>
    </article>
    <aside class="card hero-side stack">
      <h2>הצטרפות</h2>
      <p class="muted">השלב הבא יבצע אימות קונה, authorization והרשמה לעסקה.</p>
      <form data-action="start-join" class="stack">
        <div class="field">
          <label for="qty">כמות</label>
          <input id="qty" name="qty" type="number" min="${deal.min_units}" max="${Math.max(deal.min_units, metrics.remaining_units)}" step="1" value="${qty}" />
        </div>
        ${issue ? `<div class="error-card compact">${esc(issue)}</div>` : ""}
        <div class="summary-item"><span class="muted">עלות משוערת</span><strong>${currency(Math.max(0, qty) * deal.price_per_unit)}</strong><p class="small muted">זהו authorization בלבד. חיוב בפועל יקרה רק אם העסקה תושלם.</p></div>
        <button class="primary" type="submit" ${availability.canJoin ? "" : "disabled"}>המשך לאימות והצטרפות</button>
      </form>
    </aside>
  </section>`;
}

function otpView(dealId) {
  const flow = getFlow(dealId) || {};
  return `<section class="hero">
    <article class="card hero-main stack">
      <span class="eyebrow">OTP</span>
      <h1>אימות מספר טלפון</h1>
      <p class="muted">לפני ההצטרפות בפועל צריך לאמת קונה.</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(S.deal?.deal?.title || flow.dealTitle || "עסקה")}</strong></div>
        <div class="summary-item"><span class="muted">כמות</span><strong>${num(flow.qty || S.form.qty || 0)} יח'</strong></div>
      </div>
    </article>
    <aside class="card hero-side stack">
      <form data-action="otp-start" class="stack">
        <div class="field"><label for="phone">טלפון</label><input id="phone" name="phone" type="tel" value="${esc(flow.phone || S.form.phone || "")}" placeholder="0501234567" /></div>
        <button class="primary" type="submit">שלח קוד</button>
      </form>
      ${flow.otpSessionId ? `<div class="info-strip"><strong>קוד נשלח ל-${esc(flow.otpMaskedDestination || flow.phone || "")}</strong><p class="small">פג תוקף: ${dt(flow.otpExpiresAt)}</p>${flow.developmentCode ? `<p class="small">קוד פיתוח: <span class="mono">${esc(flow.developmentCode)}</span></p>` : ""}</div>
      <form data-action="otp-verify" class="stack">
        <div class="field"><label for="code">קוד אימות</label><input id="code" name="code" type="text" inputmode="numeric" value="${esc(S.form.code || "")}" placeholder="123456" /></div>
        <button class="primary" type="submit">אמת והמשך</button>
      </form>` : "" }
    </aside>
  </section>`;
}

function paymentView(dealId) {
  const flow = getFlow(dealId);
  if (!flow?.otpVerified) return empty("צריך להשלים אימות", "לפני תפיסת מסגרת צריך להשלים OTP.");
  return `<section class="hero">
    <article class="card hero-main stack">
      <span class="eyebrow">Authorization</span>
      <h1>אישור אמצעי תשלום</h1>
      <p class="muted">זהו authorization בלבד. אין חיוב מיידי במסך הזה.</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">עסקה</span><strong>${esc(S.deal?.deal?.title || flow.dealTitle || "")}</strong></div>
        <div class="summary-item"><span class="muted">קונה מאומת</span><strong>${esc(flow.buyerId || "")}</strong></div>
        <div class="summary-item"><span class="muted">כמות</span><strong>${num(flow.qty || 0)} יח'</strong></div>
        <div class="summary-item"><span class="muted">סכום משוער</span><strong>${currency(flow.estimatedTotal || ((flow.qty || 0) * (S.deal?.deal?.price_per_unit || 0)))}</strong></div>
      </div>
    </article>
    <aside class="card hero-side stack">
      <form data-action="pay" class="stack">
        <div class="field"><label for="holderName">שם בעל הכרטיס</label><input id="holderName" name="holderName" type="text" value="${esc(S.form.holderName)}" /></div>
        <div class="field"><label for="cardNumber">מספר כרטיס</label><input id="cardNumber" name="cardNumber" type="text" inputmode="numeric" value="${esc(S.form.cardNumber)}" placeholder="4111111111111111" /></div>
        <div class="inline-fields">
          <div class="field"><label for="expiry">תוקף</label><input id="expiry" name="expiry" type="text" value="${esc(S.form.expiry)}" placeholder="12/28" /></div>
          <div class="field"><label for="cvv">CVV</label><input id="cvv" name="cvv" type="password" inputmode="numeric" value="${esc(S.form.cvv)}" placeholder="123" /></div>
        </div>
        <button class="primary" type="submit">אשר מסגרת והצטרף</button>
        <p class="small muted">כשל בדיקה: מספר כרטיס שמסתיים ב-0000.</p>
      </form>
    </aside>
  </section>`;
}

function confirmationView(dealId) {
  const flow = getFlow(dealId);
  if (!flow?.participantId) return empty("אין הצטרפות להצגה", "צריך להשלים את המסלול לפני מסך האישור.");
  return `<section class="hero">
    <article class="card hero-main stack">
      <span class="eyebrow">אישור</span>
      <span class="badge success">ההצטרפות נקלטה</span>
      <h1>הקונה נרשם לעסקה</h1>
      <p class="muted">בוצעו OTP, authorization, והרשמה בפועל לעסקה. מכאן ממשיכים למעקב.</p>
      <div class="summary-grid">
        <div class="summary-item"><span class="muted">מזהה השתתפות</span><strong class="mono">${esc(flow.participantId)}</strong></div>
        <div class="summary-item"><span class="muted">מזהה authorization</span><strong class="mono">${esc(flow.authorizationId || "pending")}</strong></div>
      </div>
      <div class="actions">
        <a class="button primary" href="/app/track/${encodeURIComponent(flow.participantId)}" data-nav="/app/track/${encodeURIComponent(flow.participantId)}">למעקב אחר ההצטרפות</a>
        <a class="button secondary" href="/app/deal/${encodeURIComponent(dealId)}" data-nav="/app/deal/${encodeURIComponent(dealId)}">חזרה לעסקה</a>
      </div>
    </article>
  </section>`;
}

function trackingView() {
  if (!S.tracking && S.loading) return "";
  if (!S.tracking) return empty("המעקב לא נמצא", "לא הצלחנו לטעון את נתוני ההשתתפות.");
  const t = S.tracking.tracking, ds = label(DEAL, t.deal_state), bs = label(BUYER, t.buyer_state), ms = label(MONEY, t.money_state);
  return `<section class="hero">
    <article class="card hero-main stack">
      <span class="eyebrow">מעקב קונה</span>
      <span class="badge ${t.deal_state === "Completed" ? "success" : t.deal_state === "Failed" || t.deal_state === "Cancelled" ? "danger" : "warning"}">${ds[0]}</span>
      <h1>${esc(t.deal_title)}</h1>
      <p class="muted">${t.deal_state === "Completed" ? "העסקה הושלמה והמעקב מציג את התוצאה הסופית." : t.deal_state === "Failed" || t.deal_state === "Cancelled" ? "העסקה לא הושלמה. המעקב מציג את מצב ההשתתפות והמשמעות הכספית." : `${ds[0]} / ${bs[0]} / ${ms[0]}`}</p>
      <div class="status-grid">
        <div class="status-item"><span class="muted">מצב העסקה</span><strong>${ds[0]}</strong><p class="small muted">${ds[1]}</p></div>
        <div class="status-item"><span class="muted">מצב הקונה</span><strong>${bs[0]}</strong><p class="small muted">${bs[1]}</p></div>
        <div class="status-item"><span class="muted">מצב כספי</span><strong>${ms[0]}</strong><p class="small muted">${ms[1]}</p></div>
        <div class="status-item"><span class="muted">עלות משוערת</span><strong>${currency(t.estimated_total)}</strong><p class="small muted">${num(t.qty)} יח' x ${currency(t.price_per_unit)}</p></div>
      </div>
    </article>
    <aside class="card hero-side stack">
      <div class="summary-item"><span class="muted">מזהה השתתפות</span><strong class="mono">${esc(t.participant_id)}</strong></div>
      <div class="summary-item"><span class="muted">מזהה קונה</span><strong>${esc(t.buyer_id)}</strong></div>
      <div class="summary-item"><span class="muted">חלון הצטרפות</span><strong>${dt(t.deadline)}</strong></div>
      ${t.completion_window_until ? `<div class="summary-item"><span class="muted">סיום חלון השלמה</span><strong>${dt(t.completion_window_until)}</strong></div>` : ""}
      <div class="actions"><a class="button secondary" href="/app/deal/${encodeURIComponent(t.deal_id)}" data-nav="/app/deal/${encodeURIComponent(t.deal_id)}">חזרה לעסקה</a></div>
    </aside>
  </section>`;
}

function nav() {
  const names = { home: "Frontend Core", deal: "דף עסקה ציבורי", otp: "אימות OTP", payment: "אישור מסגרת", confirmation: "אישור הצטרפות", tracking: "מעקב קונה" };
  return `<nav class="page-nav"><a href="/app" data-nav="/app" class="button secondary">סיטון</a><div class="route-chip">${names[S.route.name] || "Frontend Core"}</div></nav>`;
}

function empty(title, message) {
  return `<section class="card section stack"><h2>${esc(title)}</h2><p class="muted">${esc(message)}</p><div class="actions"><a class="button secondary" href="/app" data-nav="/app">חזרה למסך הבית</a></div></section>`;
}

function errorCard(err) {
  return `<section class="error-card"><strong>${esc(err.title || "אירעה שגיאה")}</strong><p>${esc(err.message || "נסה שוב בעוד רגע.")}</p></section>`;
}

function info(message) {
  return `<div class="info-strip">${esc(message)}</div>`;
}

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const text = await res.text();
  const data = text ? parseJson(text) : null;
  if (res.ok) return data;
  const err = new Error(data?.message || data?.error || fallbackStatus(res.status) || "request_failed");
  err.status = res.status;
  throw err;
}

function friendlyError(err, fallback) {
  const msg = String(err?.message || fallback || "");
  const low = msg.toLowerCase();
  const status = Number(err?.status || 0);
  if (status === 404 && low.includes("deal not found")) return { title: "העסקה לא נמצאה", message: "לא קיים דף עסקה למזהה שסופק." };
  if (status === 404 && low.includes("participant not found")) return { title: "המעקב לא נמצא", message: "לא נמצאה השתתפות עבור המזהה שסופק." };
  if (low.includes("join not allowed")) return { title: "ההצטרפות סגורה", message: "העסקה כבר לא פתוחה להצטרפות בשלב הנוכחי." };
  if (low.includes("max_units exceeded")) return { title: "אין מספיק מלאי פנוי", message: "הכמות שביקשת חורגת מהקיבולת שנותרה." };
  if (low.includes("invalid otp")) return { title: "קוד האימות שגוי", message: "הקוד שהוזן אינו תקין." };
  if (low.includes("otp expired")) return { title: "תוקף הקוד פג", message: "צריך לבקש קוד חדש כדי להמשיך." };
  if (low.includes("otp session not found")) return { title: "אין סשן אימות פעיל", message: "צריך להתחיל את ה-OTP מחדש." };
  if (low.includes("authorization failed")) return { title: "אישור המסגרת נכשל", message: "אמצעי התשלום נדחה ב-provider המדומה." };
  if (status >= 500 || low.includes("fetch")) return { title: "הבקאנד לא זמין", message: "השרת לא זמין כרגע או שהחיבור נכשל." };
  return { title: "אירעה שגיאה", message: fallback || msg || "נסה שוב בעוד רגע." };
}

function fallbackStatus(status) {
  if (status === 400) return "invalid_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server_error";
  return "";
}

function validateQty(dealPayload, qty) {
  if (!Number.isInteger(qty) || qty <= 0) return "יש להזין כמות שלמה וחיובית.";
  const min = Number(dealPayload.deal.min_units || 1), left = Number(dealPayload.metrics.remaining_units || 0);
  if (qty < min) return `כמות מינימלית להצטרפות היא ${min}.`;
  if (qty > left) return `נותרו רק ${left} יחידות פנויות כרגע.`;
  return "";
}

function validatePayment(payload) {
  if (!payload.holder_name || !payload.card_number || !payload.expiry || !payload.cvv) return "יש למלא שם בעל כרטיס, מספר כרטיס, תוקף ו-CVV.";
  if (!/^\d{12,19}$/.test(payload.card_number)) return "מספר הכרטיס חייב להכיל בין 12 ל-19 ספרות.";
  return "";
}

function getFlow(dealId) {
  const all = readFlow();
  return all[dealId] || null;
}

function saveFlow(dealId, next) {
  const all = readFlow();
  all[dealId] = { ...(all[dealId] || {}), ...next, updatedAt: new Date().toISOString() };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(all));
}

function readFlow() {
  try { return JSON.parse(sessionStorage.getItem(FLOW_KEY) || "{}"); } catch { return {}; }
}

function hydrateForm() {
  const flow = S.route.dealId ? getFlow(S.route.dealId) : null;
  if (!flow) return;
  S.form.qty = String(flow.qty || S.form.qty);
  S.form.phone = flow.phone || "";
}

function label(map, key) { return map[key] || [key, "מצב לא ממופה."]; }
function dealLabel(key) { return label(DEAL, key); }
function currency(v) { return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(Number(v || 0)); }
function num(v) { return new Intl.NumberFormat("he-IL").format(Number(v || 0)); }
function dt(v) { return v ? new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(v)) : "לא זמין"; }
function json(v) { return JSON.stringify(v); }
function parseJson(t) { try { return JSON.parse(t); } catch { return null; } }
function fail(title, message) { S.error = { title, message }; render(); }
function esc(v) { return String(v || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
