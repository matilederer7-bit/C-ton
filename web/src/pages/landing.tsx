import React from "react";
import { getSellerToken } from "../api";
import { BRAND_LOGO_URL } from "../config";

// ── C-ton seller-first landing (current launch root) ────────────────────────
// The public catalog is hidden at this launch stage; the root experience talks
// to sellers. Buyers arrive only through direct deal links they receive.
export function Landing({ navigate }: { navigate: (h: string) => void }) {
  const authed = Boolean(getSellerToken());
  return (
    <div className="landing">
      <section className="landing-hero">
        <img
          className="landing-logo"
          src={BRAND_LOGO_URL}
          alt="C-ton"
          width={340}
          height={227}
          draggable={false}
        />
        <h1 className="landing-title">מוכרים בקבוצה. סוגרים בכמות.</h1>
        <p className="landing-sub">
          C-ton היא פלטפורמה לעסקאות קבוצתיות: פותחים עסקה עם יעד יחידות,
          הקונים מצטרפים ומשתפים, והחיוב מתבצע רק אם הקבוצה מגיעה ליעד.
          לא הגיעה — אף אחד לא משלם.
        </p>
        <div className="landing-actions">
          {authed ? (
            <>
              <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>לדשבורד שלי ←</button>
              <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller/new")}>+ יצירת עסקה חדשה</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>התחברות מוכר</button>
              <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller?signup=1")}>פתיחת חשבון מוכר</button>
            </>
          )}
        </div>
        <p className="landing-note">קיבלתם קישור לעסקה? פתחו אותו ישירות — ההצטרפות לא דורשת חשבון.</p>
      </section>

      <section className="landing-steps" aria-label="איך זה עובד">
        <div className="landing-step">
          <div className="landing-step-bar" aria-hidden="true" />
          <h3>פותחים עסקה</h3>
          <p>מוצר, שובר או כרטיס — קובעים מחיר ליחידה, כמות מינימום ודדליין. פחות מ־5 דקות.</p>
        </div>
        <div className="landing-step">
          <div className="landing-step-bar" aria-hidden="true" />
          <h3>הקבוצה מצטרפת</h3>
          <p>משתפים קישור אחד. כל מצטרף מקבל קישור אישי משלו — וההפצה עובדת בשבילכם.</p>
        </div>
        <div className="landing-step">
          <div className="landing-step-bar" aria-hidden="true" />
          <h3>מגיעים ליעד — סוגרים</h3>
          <p>עד היעד נתפסת מסגרת אשראי בלבד. הגיעה הקבוצה ליעד? החיוב מתבצע והעסקה יוצאת לפועל.</p>
        </div>
      </section>
    </div>
  );
}
