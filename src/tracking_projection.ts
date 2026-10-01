// Buyer tracking projection: the pure builders behind the buyer tracking
// payload (personal status, deal status, progress snapshot, chart points,
// activity feed) and the deal / buyer / money state unions they read.
// Moved verbatim out of frontend_runtime.ts (Lean Refactor R5): no I/O, no
// database, no behaviour change. The functions stay plain `function`
// declarations (exported below) because
// tests/frontend_tracking_status_contract_validation.ts slices the source of
// buildTrackingPersonalStatus up to the next "\nfunction ".

export type DealState =
  | "Draft"
  | "PendingTarget"
  | "TargetReached"
  | "ClosedForJoining"
  | "ReadyForCharging"
  | "Charging"
  | "CompletionWindow"
  | "Completed"
  | "Failed"
  | "Cancelled";

export type BuyerState =
  | "JoinedAuthorized"
  | "LockedIn"
  | "ChargingAttempt"
  | "ChargedSuccess"
  | "ChargeFailedCompletion"
  | "Recovered"
  | "Dropped"
  | "DealCompleted"
  | "DealFailed";

export type MoneyState =
  | "AuthHeld"
  | "AuthLocked"
  | "ChargeAttempt"
  | "ChargedSuccess"
  | "ChargeFailedRecovery"
  | "RecoveredCharge"
  | "AuthReleased"
  | "Refunded";

function buildTrackingPersonalStatus(
  dealState: DealState,
  buyerState: BuyerState,
  moneyState: MoneyState,
  args?: { participantId?: string; completionWindowUntil?: string | null }
) {
  const recoveryRequired = buyerState === "ChargeFailedCompletion" || moneyState === "ChargeFailedRecovery";
  if (recoveryRequired) {
    const windowEpoch = args?.completionWindowUntil ? Date.parse(args.completionWindowUntil) : NaN;
    const windowOpen = dealState === "CompletionWindow" && Number.isFinite(windowEpoch) && windowEpoch > Date.now();
    if (windowOpen && args?.participantId) {
      return {
        action_required: true,
        status: "payment_update_required",
        title: "נדרש עדכון אמצעי תשלום",
        detail: "החיוב לא עבר. המקום שלך בעסקה נשמר זמנית, אבל צריך להשלים את התשלום בתוך חלון ההשלמה.",
        cta: {
          label: "עדכון אמצעי תשלום",
          href: `/app/recovery/${encodeURIComponent(args.participantId)}`
        }
      };
    }
    return {
      action_required: false,
      status: "payment_update_window_closed",
      title: "השלמת התשלום אינה זמינה",
      detail: "החיוב לא עבר וחלון ההשלמה אינו פעיל. מסך המעקב יציג את ההמשך לפי חוקי העסקה.",
      cta: null
    };
  }
  if (dealState === "Completed" || buyerState === "DealCompleted" || moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge") {
    return {
      action_required: false,
      status: "completed_or_charged",
      title: dealState === "Completed" ? "העסקה הושלמה עבורך" : "החיוב שלך הצליח",
      detail: "אין פעולה נוספת שנדרשת ממך כרגע. מסך המעקב ימשיך להציג את האמת העדכנית.",
      cta: null
    };
  }
  if (dealState === "Failed" || dealState === "Cancelled" || buyerState === "DealFailed" || buyerState === "Dropped") {
    return {
      action_required: false,
      status: "closed_without_action",
      title: dealState === "Cancelled" ? "העסקה בוטלה" : "העסקה לא הושלמה",
      detail: "אין פעולה נוספת שנדרשת ממך במסלול הזה.",
      cta: null
    };
  }
  if (moneyState === "AuthHeld" || moneyState === "AuthLocked") {
    return {
      action_required: false,
      status: "authorization_saved",
      title: "ההצטרפות שלך נשמרה",
      detail: "נתפסה מסגרת בלבד. חיוב בפועל יתבצע רק אם העסקה תגיע לשלב חיוב תקין.",
      cta: null
    };
  }
  if (moneyState === "ChargeAttempt" || buyerState === "ChargingAttempt") {
    return {
      action_required: false,
      status: "charging_in_progress",
      title: "חיוב ממתין",
      detail: "המערכת מטפלת בעסקה כרגע. אין צורך בפעולה מצדך בשלב הזה.",
      cta: null
    };
  }
  return {
    action_required: false,
    status: "joined",
    title: "אתה בפנים",
    detail: "ההשתתפות שלך קיימת במערכת ומתעדכנת לפי מצב העסקה.",
    cta: null
  };
}

function buildTrackingDealStatus(state: DealState, currentUnits: number, thresholdUnits: number) {
  const remainingToMinimum = Math.max(0, thresholdUnits - currentUnits);
  if (state === "PendingTarget") {
    return {
      kind: "in_progress",
      title: "העסקה עדיין מתקדמת",
      detail: remainingToMinimum > 0
        ? `חסרות עוד ${remainingToMinimum} יחידות למינימום.`
        : "המינימום כבר הושג והעסקה עדיין פתוחה להצטרפות.",
      live: true
    };
  }
  if (state === "TargetReached") {
    return { kind: "target_reached", title: "המינימום הושג", detail: "העסקה התקדמה לשלב הבא ועדיין ניתן לעקוב אחרי הקצב.", live: true };
  }
  if (state === "ClosedForJoining") {
    return { kind: "closed_for_joining", title: "ההצטרפות נסגרה", detail: "העסקה מתכוננת לשלב הבא.", live: true };
  }
  if (state === "ReadyForCharging" || state === "Charging") {
    return { kind: "charging", title: "העסקה עברה למסלול חיוב", detail: "כרגע אי אפשר להצטרף, והמערכת מעבדת את העסקה.", live: true };
  }
  if (state === "CompletionWindow") {
    return { kind: "completion_window", title: "חלק מהחיובים דורשים השלמה", detail: "העסקה עדיין בטיפול והמסך מתעדכן לפי התוצאה.", live: true };
  }
  if (state === "Completed") {
    return { kind: "success", title: "העסקה הושלמה בהצלחה", detail: "העסקה נסגרה כמוצלחת.", live: false };
  }
  if (state === "Failed") {
    return { kind: "failed", title: "העסקה לא הושלמה", detail: "העסקה נסגרה ללא השלמה.", live: false };
  }
  if (state === "Cancelled") {
    return { kind: "cancelled", title: "העסקה בוטלה", detail: "המסלול נסגר ואינו דורש פעולה נוספת.", live: false };
  }
  return { kind: "draft_or_unknown", title: "מצב העסקה לא פעיל", detail: "העסקה אינה במסלול ציבורי פעיל.", live: false };
}

function buildTrackingProgressSnapshot(args: {
  currentUnits: number;
  participantsCount: number;
  minUnits: number;
  maxUnits: number;
  thresholdUnits: number;
}) {
  const thresholdUnits = Math.max(1, Number(args.thresholdUnits || args.minUnits || 1));
  const maxUnits = Math.max(1, Number(args.maxUnits || thresholdUnits));
  return {
    current_units: Number(args.currentUnits || 0),
    participants_count: Number(args.participantsCount || 0),
    min_units: Number(args.minUnits || thresholdUnits),
    target_units: thresholdUnits,
    threshold_units: thresholdUnits,
    max_units: maxUnits,
    remaining_to_minimum: Math.max(0, thresholdUnits - Number(args.currentUnits || 0)),
    remaining_to_capacity: Math.max(0, maxUnits - Number(args.currentUnits || 0)),
    progress_to_minimum_pct: Number(Math.min(100, Math.round((Number(args.currentUnits || 0) / thresholdUnits) * 100))),
    progress_to_capacity_pct: Number(Math.min(100, Math.round((Number(args.currentUnits || 0) / maxUnits) * 100)))
  };
}

function buildTrackingChartPoints(participantRows: Array<{ participant_id: string; qty: number; created_at: string }>) {
  let cumulative = 0;
  return participantRows.map((row) => {
    const addedUnits = Number(row.qty || 0);
    cumulative += addedUnits;
    return {
      at: row.created_at,
      cumulative_units: cumulative,
      added_units: addedUnits
    };
  });
}

function buildTrackingActivityFeed(args: {
  participantRows: Array<{ participant_id: string; qty: number; created_at: string }>;
  chartPoints: Array<{ at: string; cumulative_units: number; added_units: number }>;
  dealState: DealState;
  thresholdUnits: number;
  currentUnits: number;
}) {
  const items: Array<{ type: string; at: string; message: string; added_units?: number; cumulative_units?: number; milestone_pct?: number }> = [];
  for (const row of args.participantRows.slice(-12)) {
    const addedUnits = Number(row.qty || 0);
    items.push({
      type: "join_units",
      at: row.created_at,
      message: addedUnits === 1 ? "נוספה יחידה אחת" : `נוספו ${addedUnits} יחידות`,
      added_units: addedUnits
    });
  }

  const thresholdUnits = Math.max(1, Number(args.thresholdUnits || 1));
  const seenMilestones = new Set<number>();
  for (const point of args.chartPoints) {
    const percent = Math.round((Number(point.cumulative_units || 0) / thresholdUnits) * 100);
    for (const milestone of [50, 75, 100]) {
      if (!seenMilestones.has(milestone) && percent >= milestone) {
        seenMilestones.add(milestone);
        items.push({
          type: milestone === 100 ? "target_reached" : "progress_milestone",
          at: point.at,
          message: milestone === 100 ? "המינימום הושג" : `העסקה חצתה את רף ה-${milestone}%`,
          cumulative_units: Number(point.cumulative_units || 0),
          milestone_pct: milestone
        });
      }
    }
  }

  if (["ReadyForCharging", "Charging", "CompletionWindow"].includes(args.dealState)) {
    items.push({
      type: "deal_charging",
      at: new Date().toISOString(),
      message: "העסקה עברה למסלול חיוב",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }
  if (args.dealState === "Completed") {
    items.push({
      type: "deal_completed",
      at: new Date().toISOString(),
      message: "העסקה הושלמה בהצלחה",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }
  if (args.dealState === "Failed") {
    items.push({
      type: "deal_failed",
      at: new Date().toISOString(),
      message: "העסקה לא הושלמה",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }
  if (args.dealState === "Cancelled") {
    items.push({
      type: "deal_cancelled",
      at: new Date().toISOString(),
      message: "העסקה בוטלה",
      cumulative_units: Number(args.currentUnits || 0)
    });
  }

  return items
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12);
}

export {
  buildTrackingPersonalStatus,
  buildTrackingDealStatus,
  buildTrackingProgressSnapshot,
  buildTrackingChartPoints,
  buildTrackingActivityFeed
};
