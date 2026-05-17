# Payment Security and PCI Scope

Written as an initial MVP response; legal validation is recommended later.

C-ton אינה שומרת ואינה מעבדת מספר כרטיס אשראי גולמי, CVV או תוקף כרטיס. פרטי הכרטיס מוזנים רק ברכיב מאובטח של ספק הסליקה, כגון hosted field, iframe או redirect.

C-ton שומרת רק מזהים תפעוליים כגון token או auth id, ככל שנדרש לניהול תפיסת מסגרת, חיוב, השלמה, בקרה או החזר.

המטרה התפעולית היא לצמצם את PCI scope של C-ton: אין שדות כרטיס רגילים בפרונט, אין DTO תפעולי לפרטי כרטיס גולמיים, אין שמירה בסכמה ואין לוגים של פרטי כרטיס.

בדיקת `scripts/compliance_payment_scan.cjs` נכשלת אם נמצאים מונחי כרטיס גולמי בקוד תפעולי.
