import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  const coreUrl = import.meta.env.VITE_SITON_CORE_URL || "לא הוגדר עדיין";

  return (
    <main className="shell">
      <section className="card">
        <div className="eyebrow">Siton × Base44</div>
        <h1>ראש הגשר פעיל</h1>
        <p className="lead">
          זהו משטח ההגירה המבודד של סיטון. הליבה הקנונית, מסד הנתונים, ה־Worker ומנגנון התשלומים לא שונו.
        </p>

        <div className="grid">
          <div className="status ok">
            <span>Base44</span>
            <strong>שלד מוכן לחיבור</strong>
          </div>
          <div className="status safe">
            <span>Siton Core</span>
            <strong>נשאר מקור האמת</strong>
          </div>
        </div>

        <div className="meta">
          <span>יעד Core</span>
          <code>{coreUrl}</code>
        </div>

        <p className="note">
          השלב הבא הוא לחבר את אפליקציית Base44 לענף ההגירה, להעלות את המשטח הזה ולבצע קריאת Read-only ראשונה לליבת סיטון.
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
