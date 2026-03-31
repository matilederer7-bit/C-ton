# STAGE 9D DRIFT REPORT

## מצב כללי
נמצאו 10 עסקאות חריגות ב deals

## deals columns

- 1. deal_id | uuid | nullable=NO | default=gen_random_uuid()
- 2. title | text | nullable=YES | default=null
- 3. price_per_unit | numeric | nullable=YES | default=null
- 4. min_units | integer | nullable=YES | default=null
- 5. max_units | integer | nullable=YES | default=null
- 6. threshold_units | integer | nullable=YES | default=null
- 7. deadline | timestamp with time zone | nullable=YES | default=null
- 8. commission_rate | numeric | nullable=YES | default=null
- 9. state | text | nullable=YES | default='Draft'::text
- 10. published_at | timestamp with time zone | nullable=YES | default=null
- 11. completion_window_until | timestamp with time zone | nullable=YES | default=null
- 12. created_at | timestamp with time zone | nullable=YES | default=now()
- 13. updated_at | timestamp with time zone | nullable=YES | default=now()

## deals constraints

- CHECK | deals_deal_id_not_null | column=deal_id | check=deal_id IS NOT NULL
- CHECK | valid_deal_state | column=state | check=(state = ANY (ARRAY['Draft'::text, 'PendingTarget'::text, 'TargetReached'::text, 'ClosedForJoining'::text, 'ReadyForCharging'::text, 'Charging'::text, 'CompletionWindow'::text, 'Completed'::text, 'Failed'::text, 'Cancelled'::text]))
- PRIMARY KEY | deals_pkey | column=deal_id | check=n/a

## suspicious deals

- 9930e7f6-84fd-4dc4-8cdd-730dc6a8f561 | QA x9 load test join 1350 1800 2700 | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=1800 | threshold_units=1350 | commission_rate=null | deadline=Thu Mar 26 2026 21:36:07 GMT+0200 (שעון ישראל (חורף))
- eabc4939-2275-452a-972f-9a254eec05ce | QA x3 load test join 450 600 900 | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=600 | threshold_units=450 | commission_rate=null | deadline=Thu Mar 26 2026 21:33:13 GMT+0200 (שעון ישראל (חורף))
- 8ccd7f47-695b-43fa-b8aa-788a21d81b2e | QA extreme load test join 150 200 300 | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=200 | threshold_units=150 | commission_rate=null | deadline=Thu Mar 26 2026 21:29:44 GMT+0200 (שעון ישראל (חורף))
- a86f3f62-c71e-4d5e-b141-405feee61f44 | QA load test join 40 45 70 | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=45 | threshold_units=40 | commission_rate=null | deadline=Thu Mar 26 2026 21:24:39 GMT+0200 (שעון ישראל (חורף))
- e5233c52-c8c1-4422-9215-33fdd74ac6e5 | QA diagnostics retest | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=5 | threshold_units=3 | commission_rate=null | deadline=Thu Mar 26 2026 21:21:42 GMT+0200 (שעון ישראל (חורף))
- 580ea1f6-bf45-4c69-a442-264dc7d83b0f | QA join capacity node retest | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=5 | threshold_units=3 | commission_rate=null | deadline=Thu Mar 26 2026 20:29:15 GMT+0200 (שעון ישראל (חורף))
- 95777fcf-e499-40cb-a9c1-390f8bb1ad05 | QA join capacity retest clean | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=5 | threshold_units=3 | commission_rate=null | deadline=Thu Mar 26 2026 20:24:22 GMT+0200 (שעון ישראל (חורף))
- 1476e831-1174-4fec-bfab-72702be41fd8 | QA join capacity test | state=TargetReached | published_at=null | price_per_unit=null | min_units=null | max_units=5 | threshold_units=3 | commission_rate=null | deadline=Thu Mar 26 2026 20:13:29 GMT+0200 (שעון ישראל (חורף))
- 1febb2a8-8b5c-438c-a1c0-b3999f30e7a6 | rulefix finalize 90 percent probe | state=Completed | published_at=null | price_per_unit=10 | min_units=10 | max_units=20 | threshold_units=10 | commission_rate=0 | deadline=Wed Mar 25 2026 02:31:42 GMT+0200 (שעון ישראל (חורף))
- 37194a24-d240-45e3-989c-d4d4749342d2 | stage5 early finalize probe | state=Failed | published_at=null | price_per_unit=10 | min_units=1 | max_units=10 | threshold_units=1 | commission_rate=0 | deadline=Wed Mar 25 2026 02:32:16 GMT+0200 (שעון ישראל (חורף))