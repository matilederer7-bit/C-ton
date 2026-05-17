# Payment Security And PCI Scope

Written as an initial MVP response; legal validation is recommended later.

C-ton אינה שומרת ואינה מעבדת מספר כרטיס אשראי גולמי, CVV או תוקף כרטיס. פרטי הכרטיס מוזנים רק ברכיב מאובטח של ספק הסליקה. C-ton שומרת רק מזהים תפעוליים כגון token/auth id, ככל שנדרש לניהול תפיסת מסגרת, חיוב, השלמה ובקרה.

The MVP architecture reduces PCI DSS scope by keeping C-ton outside raw card-data collection. Public buyer screens must use a provider hosted field, iframe or redirect. Server endpoints accept provider identifiers only.

Operational code must not define application-owned raw payment fields such as card_number, credit_card_number, cvv, cvc, raw_card, pan, expiry_month, expiry_year, full_card or cardholder_data. These terms may appear only in compliance documents or tests that enforce the prohibition.
