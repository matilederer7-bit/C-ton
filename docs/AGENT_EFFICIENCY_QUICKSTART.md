# Siton Agent Quickstart

פקודת הבעלים היחידה:

`node scripts/agent.cjs <command>`

הקמה חד־פעמית:

`node scripts/agent.cjs setup`

משימה רגילה:

`node scripts/agent.cjs start codex "תיקון תמונות מוכר"`

ואז לסוכן מספיק בדרך כלל:

`TASK: <מה צריך להיות נכון בסוף>`

Review:

`node scripts/agent.cjs review claude "PR #123"`

או פשוט:

`REVIEW: PR #123`

שני builders במקביל:

השתמש רק ב־scopes נפרדים. לכל אחד כתוב `SCOPE` ו־`DO NOT TOUCH` שמגדירים את הגבול מול השני.

Status:

`node scripts/agent.cjs status`

בדיקת סביבת עבודה:

`node scripts/agent.cjs doctor`

סיום workspace אחרי commit + push + PR:

`node scripts/agent.cjs finish codex`

אם סוכן נתקע פעמיים באותה דרך:

STOP. אבחון מחדש. לא להריץ שוב את אותה פעולה ולא לשרוף full suite בלי סיבה חדשה.

בסוף אני אמור לקבל רק:

`DONE` או `FAILED` או `DECISION_NEEDED`

ובתוספת קצרה: PR, מה השתנה, מה נבדק, blocker אם יש.
