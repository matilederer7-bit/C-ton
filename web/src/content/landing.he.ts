// ── Canonical Hebrew content for the public landing page ────────────────────
// A section renders ONLY when its content is present — no lorem ipsum, ever.
// The final "About" copy (and any marketing rewrite of other sections) will be
// supplied by the OWNER; inserting it here requires no layout change.
//
// Sections with factual product-mechanics copy (how it works, trust, FAQ) are
// filled with truthful descriptions of the actual canonical behavior.

export interface LandingSectionContent { title: string; body: string }
export interface LandingFaqItem { q: string; a: string }

export const LANDING_HE = {
  hero: {
    title: "מוכרים בקבוצה. סוגרים בכמות.",
    sub: "C-ton היא פלטפורמה לעסקאות קבוצתיות: פותחים עסקה עם יעד יחידות, הקונים מצטרפים ומשתפים, והחיוב מתבצע רק אם הקבוצה מגיעה ליעד. לא הגיעה — אף אחד לא משלם.",
    note: "קיבלתם קישור לעסקה? פתחו אותו ישירות — ההצטרפות לא דורשת חשבון."
  },

  howItWorks: {
    title: "איך זה עובד",
    steps: [
      { title: "פותחים עסקה", body: "מוצר, שובר או כרטיס — קובעים מחיר ליחידה, כמות מינימום ומועד סיום. פחות מ־5 דקות." },
      { title: "הקבוצה מצטרפת", body: "משתפים קישור אחד. כל מצטרף מקבל קישור אישי משלו — וההפצה עובדת בשבילכם." },
      { title: "מגיעים ליעד — סוגרים", body: "עד היעד נתפסת מסגרת אשראי בלבד. הגיעה הקבוצה ליעד? החיוב מתבצע והעסקה יוצאת לפועל." }
    ]
  },

  // OWNER/ChatGPT copy pending — hidden while empty.
  whyGroupBuying: { title: "למה קנייה קבוצתית משתלמת", body: "" } as LandingSectionContent,

  forBuyers: {
    title: "לקונים",
    body: "מצטרפים לעסקה דרך קישור, בוחרים כמות ואופן קבלה — ובשלב הזה נתפסת מסגרת אשראי בלבד, בלי חיוב. מרגע ההצטרפות יש לכם מסך מעקב אישי עם מצב העסקה בזמן אמת, וקישור אישי משלכם: כל מי שמצטרף דרככם נזקף לזכותכם."
  } as LandingSectionContent,

  forSellers: {
    title: "למוכרים",
    body: "פותחים עסקה קבוצתית עם יעד ומועד סיום, מקבלים קישור לשיתוף, ועוקבים אחרי ההצטרפויות בדשבורד ניהול מלא — כמה הצטרפו, כמה נותר ליעד, ומה קורה עם הכסף. החיוב מתבצע רק כשהעסקה נסגרת בהצלחה."
  } as LandingSectionContent,

  trust: {
    title: "מה קורה אם לא מגיעים ליעד?",
    body: "שום דבר — וזה בדיוק העניין. עד סגירת העסקה נתפסת מסגרת אשראי בלבד, ולא מתבצע חיוב. אם העסקה לא מגיעה ליעד עד מועד הסיום, המסגרת של כל המצטרפים משתחררת אוטומטית ואף אחד לא משלם."
  } as LandingSectionContent,

  // OWNER copy pending — hidden while empty (ABOUT_CONTENT_PENDING_OWNER).
  about: { title: "על C-ton", body: "" } as LandingSectionContent,

  faq: {
    title: "שאלות נפוצות",
    items: [
      { q: "האם אני משלם כשאני מצטרף לעסקה?", a: "לא. בהצטרפות נתפסת מסגרת אשראי בלבד. החיוב מתבצע רק אם העסקה מגיעה ליעד ונסגרת בהצלחה." },
      { q: "מה קורה אם העסקה לא מגיעה ליעד?", a: "המסגרת משתחררת אוטומטית ואף אחד לא מחויב." },
      { q: "האם צריך חשבון כדי להצטרף לעסקה?", a: "לא. ההצטרפות נעשית ישירות דרך קישור העסקה. חשבון נדרש רק למוכרים." },
      { q: "איך עוקבים אחרי עסקה שהצטרפתי אליה?", a: "מיד אחרי ההצטרפות מקבלים קישור למסך מעקב אישי שמראה את מצב העסקה בזמן אמת." },
      { q: "מה זה הקישור האישי שלי?", a: "כל מצטרף מקבל קישור שיתוף משלו. כשחברים מצטרפים דרך הקישור שלכם — ההצטרפות נזקפת לזכותכם ורואים את ההשפעה שלכם על העסקה." },
      { q: "איך פותחים עסקה כמוכר?", a: "נרשמים בחינם באזור המוכרים, ממלאים את פרטי העסקה — מחיר, כמות מינימום ומועד סיום — ומפרסמים. יצירת עסקה אורכת פחות מ־5 דקות." }
    ] as LandingFaqItem[]
  }
};
