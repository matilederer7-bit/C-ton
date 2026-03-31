# Runtime Validation Limitations

תאריך
- 2026-03-30

מה הוגבל
- סביבת ה-sandbox חסמה תרחישי `spawn` מסוימים בזמן ניסיון אימות runtime דרך `tsx`, `vitest`, ו-`node --test`.
- ניסיון לסקור process details דרך `Get-CimInstance Win32_Process` נחסם עם `Access denied`.
- ניסיון `taskkill` על PID קיים חיצוני נחסם עם `Access denied`.

מה כן אומת בפועל
- `npm test` רץ בהצלחה אחרי מעבר למסלול test שאינו תלוי ב-forked workers.
- `npx tsc --noEmit` עבר.
- בוצעה קומפילציה ל-`.tmp_test_dist`.
- בוצעה הרצה של `node .tmp_test_dist/src/app.js`.
- `/health` החזיר `{"ok":true}`.

מסקנה
- לא ניתן היה להוכיח בסביבת ה-sandbox שכל נתיב startup שמבוסס על spawn חיצוני ישים כאן.
- כן הוכח שה-runtime עצמו עולה ומשרת תעבורה תקינה כשהוא מורץ ישירות דרך Node על build מקומפל.
- זו מגבלת סביבה, לא אינדיקציה לכשל אפליקטיבי.
