# Siton Documentation Map

Updated: 2026-09-30. Owner decision: a new agent must understand Siton without reading hundreds of documents.

Three tiers. A document's tier is decided by its role today, not by its title. Historical documents stay in Git for their evidence value; they are never authority.

| Tier | Meaning | Rule |
|---|---|---|
| **CANONICAL** | the few documents an agent must read before meaningful work | kept current; conflicts resolved forward |
| **REFERENCE** | design, architecture, policy, legal text and runbooks that are still operationally useful | read when the task touches the area; may carry dated sections |
| **ARCHIVE** | delivery reports, stage closeouts, audits, handoffs, superseded decisions | history only; must carry a superseded/historical marker if anything inside reads as current authority |

Physical relocation of ARCHIVE files into `docs/archive/` is a later, mechanical step: several gates and tests read documents by path (`scripts/architecture_truth_gate.cjs`, `scripts/legal_compliance_gate.cjs`, `src/admin_mission_control.ts`, `tests/*`), so moves happen per file with their consumers updated, never in bulk.

Counts: CANONICAL 12 · REFERENCE 100 · ARCHIVE 176 (288 documents: everything under `docs/` plus the root reports and `legacy/render/README.md`). Out of scope: `.claude/agents/*.md` (agent definitions, CI-checked), `legacy/render/docs/*` (quarantined, ARCHIVE by location), `scripts/README.md`, `ios/App/CapApp-SPM/README.md`.

## CANONICAL (read these)

| Document | Role |
|---|---|
| `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md` | product rules, highest precedence |
| `docs/CURRENT_ARCHITECTURE_2026-09-30.md` | runtime and authority map |
| `AGENTS.md` | binding agent rules |
| `CLAUDE.md` | Claude Code entry point |
| `AI_WORKFLOW.md` | execution workflow |
| `PROJECT_STATUS.md` | current state and blockers |
| `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` | product policy detail (max_units, 24h window, 8%, links) |
| `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md` | precedence rules and history pointer |
| `docs/CLAUDE_TEAM_LEAD.md` | lead procedure |
| `docs/ENGINEERING_OPERATING_SYSTEM.md` | engineering model and tiers |
| `docs/CI_TEST_STRATEGY.md` | CI rules |
| `docs/DOCUMENTATION_MAP.md` | this map |

Reading order for a new agent: constitution → current architecture → AGENTS.md → PROJECT_STATUS.md (head and the open track only) → the task-relevant REFERENCE docs.

## REFERENCE

| Document | Title | Why it is still useful |
|---|---|---|
| `docs/ACCESSIBILITY_COMPLIANCE.md` | Accessibility Compliance | a11y rules |
| `docs/ADMIN_CONTROL_PLANE.md` | Admin Control Plane | admin design |
| `docs/ADMIN_IDENTITY_RBAC_MFA.md` | Admin Identity, RBAC And MFA | RBAC design |
| `docs/ADMIN_INTERVENTION_RUNBOOK.md` | Admin Intervention Runbook | runbook |
| `docs/ADMIN_LEGAL_OPS_POLICY.md` | Admin Legal Ops Policy | policy |
| `docs/ADMIN_MISSION_CONTROL.md` | Admin Mission Control | admin design |
| `docs/ADMIN_SUPPORT_OBSERVABILITY.md` | Admin / Support Observability | ops design |
| `docs/ADMIN_SUPPORT_PRODUCT_SURFACES.md` | Admin + Support Product Surfaces | surface design |
| `docs/AGENT_EFFICIENCY_QUICKSTART.md` | Agent efficiency quickstart | agent setup |
| `docs/AUTHENTICATED_UI_ACCEPTANCE.md` | Authenticated UI acceptance harness | test harness |
| `docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md` | AWS Accordion Blueprint | portability reference |
| `docs/BACKUP_RESTORE_RUNBOOK.md` | Backup and Restore Runbook | runbook |
| `docs/BLACK_SKY_THREAT_MODEL.md` | Black-Sky Threat Model | threat model |
| `docs/BRAND_GRAPHITE_MINT.md` | Brand "Graphite Mint" | brand spec |
| `docs/BUYER_CAPACITY_RULE_OVERRIDE.md` | buyer-capacity-rule-override | product rule |
| `docs/BUYER_DOCUMENT_VISIBILITY.md` | Buyer Document Visibility | design |
| `docs/BUYER_TERMS_HE.md` | תנאי שימוש לקונה | legal text |
| `docs/CACHE_POLICY.md` | Cache Policy | policy |
| `docs/CANCELLATION_REFUND_POLICY_HE.md` | מדיניות ביטולים והחזרים | legal text |
| `docs/CLOUD_AGENT_MANAGER.md` | Cloud Agent Manager | agent control plane |
| `docs/CONFIG_INVENTORY.md` | Configuration Outside Git | config inventory |
| `docs/CREDENTIAL_COMPROMISE_RUNBOOK.md` | Credential Compromise Runbook | runbook |
| `docs/DATABASE_INCIDENT_RUNBOOK.md` | Database Incident Runbook | runbook |
| `docs/DEAL_TYPES_PHYSICAL_VOUCHER_TICKET.md` | Deal Types, Physical/Voucher/Ticket | deal type design |
| `docs/DELIVERY_DATA_HANDOFF.md` | Delivery Data Handoff | feature spec |
| `docs/DEPLOYMENT_RUNBOOK.md` | Deployment Runbook | runbook |
| `docs/DISASTER_RECOVERY_RUNBOOK.md` | Disaster Recovery Runbook | runbook |
| `docs/DISTRIBUTOR_TERMS_HE.md` | תנאי מפיץ | legal text (legal gate reads it); says measurement only |
| `docs/DOCKER_READINESS.md` | Docker Readiness | ops reference |
| `docs/ENVIRONMENT_CONTRACT.md` | Environment Contract | env contract |
| `docs/ERROR_MONITORING.md` | Error monitoring (Sentry) | error monitoring |
| `docs/FAULT_BOUNDARY_MAP.md` | Fault boundary map | design |
| `docs/FLAKE_CLASSIFICATION.md` | Flake classification | CI reference |
| `docs/FRONTEND_BROWSER_SMOKE.md` | Frontend Browser Smoke | smoke reference |
| `docs/GROW_PAYMENTS_INTEGRATION_READINESS.md` | Grow Payments Integration Readiness | provider reference |
| `docs/HEALTH_CHECK_CONTRACT.md` | Health check contract | contract |
| `docs/HORIZONTAL_SCALE_READINESS.md` | Horizontal Scale Readiness | scale reference |
| `docs/HTTP_SECURITY_SURFACE.md` | HTTP security surface | security reference |
| `docs/INCIDENT_RESPONSE_RUNBOOK.md` | Incident Response Runbook | runbook |
| `docs/INFORMATION_SECURITY_POLICY.md` | Information Security Policy | security policy |
| `docs/INFRASTRUCTURE_HEALTH_AND_CAPACITY.md` | Infrastructure Health and Capacity | ops design |
| `docs/INVOICE_ACCOUNTING_GROUNDWORK.md` | Invoice / Accounting Groundwork | invoice design |
| `docs/INVOICE_PROVIDER_MORNING_ADAPTER.md` | Morning / Green Invoice Adapter | provider adapter |
| `docs/KNOWN_GAPS_AND_DECISIONS.md` | Known Gaps And Decisions | closed product decisions |
| `docs/LANDING_HERO_VIDEO.md` | Landing hero video spec | asset spec |
| `docs/LEGAL_TRUST_SURFACES.md` | Legal / Trust Surfaces | legal surfaces |
| `docs/LOCAL_RESTORE_CHECKLIST.md` | Local Restore Checklist | checklist |
| `docs/LOGGING_DATA_CLASSIFICATION.md` | Logging data classification | policy |
| `docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md` | Long-horizon payment authorization architecture | current architecture |
| `docs/MIGRATION_SAFETY_SYSTEM.md` | Migration safety system | DB safety |
| `docs/MOBILE_APP_RELEASE_READINESS.md` | Mobile App Release Readiness | mobile |
| `docs/MOBILE_DATA_INVENTORY.md` | Mobile data inventory | mobile |
| `docs/MOBILE_RELEASE_READINESS.md` | Mobile release readiness | mobile |
| `docs/MOBILE_STORE_PAYMENT_POLICY_MATRIX.md` | Mobile store payment policy matrix | mobile |
| `docs/MONEY_TAX_INVOICE_CANON.md` | Money Tax Invoice Canon | money canon |
| `docs/NOTIFICATIONS_OPERATIONS.md` | Notification Operations | ops |
| `docs/NOTIFICATIONS_PRODUCTION_FOUNDATION.md` | Notifications Production Foundation | design |
| `docs/OBSERVABILITY_CONTRACT.md` | Observability Contract | contract |
| `docs/OPERATIONAL_RUNBOOK.md` | Operational Runbook | PowerShell-era; overlaps OPERATIONAL_RUNBOOKS |
| `docs/OPERATIONAL_RUNBOOKS.md` | Operational Runbooks | runbooks |
| `docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md` | Money Incident Runbook | runbook |
| `docs/OUTBOX_WORKER_OPERATIONS.md` | Outbox Worker Operational Reference | ops reference |
| `docs/PARALLEL_AGENT_DEVELOPMENT.md` | Parallel Agent Development | agent process |
| `docs/PARTICIPANT_TRACKING_SECURITY.md` | Participant Tracking Security | security design |
| `docs/PAYMENT_ACTIVATION_SOURCE_OF_TRUTH.md` | Payment Activation Source of Truth | payment gate |
| `docs/PAYMENT_INCIDENT_RUNBOOK.md` | Payment Incident Runbook | runbook |
| `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` | Payment Reconciliation Runbook | runbook |
| `docs/PAYMENT_SECURITY_AND_PCI_SCOPE.md` | Payment Security and PCI Scope | security |
| `docs/PHYSICAL_FULFILLMENT_PICKUP.md` | Physical fulfillment pickup | design |
| `docs/PILOT_DEAL_TEMPLATES.md` | Pilot Deal Templates | seller aid |
| `docs/PILOT_LAUNCH_RUNBOOK.md` | Closed Web Pilot Launch Runbook | runbook |
| `docs/PLATFORM_FEE_PAYMENTS_8_PERCENT.md` | Platform Fee 8% before VAT | fee policy |
| `docs/PRIVACY_DATA_MAP.md` | Privacy Data Map | privacy map |
| `docs/PRIVACY_POLICY_HE.md` | מדיניות פרטיות | legal text |
| `docs/PRODUCTION_DATA_ACCESS_BOUNDARIES.md` | Production Data Access Boundaries | security |
| `docs/PRODUCTION_LAUNCH_READINESS.md` | Production Launch Readiness | readiness map |
| `docs/R9B_GROW_SANDBOX_ACTIVATION.md` | R9B Grow Sandbox Activation | provider contract |
| `docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md` | R9B Hosted Grow sandbox proof runbook | runbook |
| `docs/REAL_MONEY_RELEASE_GOVERNANCE.md` | Real-money release governance | governance |
| `docs/RECEIPT_TRUST_CONTENT.md` | Receipt, seller identity, site content | content spec |
| `docs/REFUND_POLICY.md` | Refund Policy | policy |
| `docs/RELEASE_READINESS_ARCHITECTURE.md` | Release readiness architecture | release layer |
| `docs/RELEASE_READINESS_CHECKLIST.md` | Release Readiness Checklist | checklist |
| `docs/RELEASE_READINESS_SCORECARD.md` | Release readiness scorecard | scorecard |
| `docs/REPRODUCIBLE_BUILD.md` | Reproducible build | build |
| `docs/ROLLBACK_RUNBOOK.md` | Rollback Runbook | runbook |
| `docs/RUNTIME_ENVIRONMENT_POLICY.md` | Runtime environment policy | env policy |
| `docs/SECURITY_INCIDENT_RUNBOOK.md` | Security Incident Runbook | runbook |
| `docs/SELLER_DISTRIBUTION_HUB_2026-09-17.md` | Seller Distribution Hub, attribution + analytics only | current sharing feature |
| `docs/SELLER_KYC_POLICY.md` | Seller Identification Policy | policy |
| `docs/SELLER_ONBOARDING_KYC.md` | Seller Onboarding And KYC | design |
| `docs/SELLER_TERMS_HE.md` | תנאי מוכר | legal text |
| `docs/SITE_CMS.md` | Site CMS | CMS |
| `docs/STORAGE_PRODUCTION_FOUNDATION.md` | Storage Production Foundation | storage design |
| `docs/SUPPLY_CHAIN_STATUS.md` | Supply chain status | supply chain |
| `docs/SUPPORT_OPERATIONS.md` | Support Operations | support ops |

| `docs/SITON_V1_1_MALL_PRODUCT_DIRECTION.md` | V1.1 Mall Product Direction | future Mall spec; the Mall is hidden for the current launch (constitution §6) |
| `docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md` | Rebase R2 Canonical Postgres | current runtime record (Postgres roles), read by the architecture gate |
| `docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md` | Rebase R3 Render Web | current runtime record (Render web), read by the architecture gate |
| `docs/ARCHITECTURE_REBASE_R4_WORKER.md` | Rebase R4 Continuous Worker | current runtime record (Render worker) |

## ARCHIVE

Historical. Any claim inside these files about the current runtime, the Mall, a seven-day cap, a distributor role or a product library is not authority.

| Document | Title | Why archived |
|---|---|---|
| `BLACK_SKY_FINAL_REPORT.md` | Black-Sky Final Report | delivery report |
| `DEAL_TYPES_E2E_DELIVERY_REPORT.md` | Deal Types E2E Delivery Report | delivery report |
| `DOCKER_AWS_ACCORDION_DELIVERY_REPORT.md` | Docker + AWS Accordion Delivery Report | delivery report |
| `MVP_DEEP_COMPLETION_DELIVERY_REPORT.md` | MVP Deep Completion Delivery Report | delivery report |
| `OPS_HARDENING_AND_READINESS_DELIVERY_REPORT.md` | Ops Hardening Delivery Report | delivery report |
| `POST_E2E_REFACTOR_DELIVERY_REPORT.md` | Post E2E Refactor Delivery Report | delivery report |
| `RED_TEAM_FINAL_REPORT.md` | Red Team Final Report | red-team report |
| `REFUND_POLICY_ALIGNMENT_DELIVERY_REPORT.md` | Refund Policy Alignment Delivery Report | delivery report |
| `SECURITY_HARDENING_DELIVERY_REPORT.md` | Security Hardening Delivery Report | delivery report |
| `SECURITY_IDENTITY_TRACKING_DELIVERY_REPORT.md` | Security Identity Tracking Delivery Report | delivery report |
| `docs/ADVERSARIAL_HARDENING_DECISION.md` | Adversarial Hardening Decision | historical decision |
| `docs/ADVERSARIAL_HARDENING_ISSUES.md` | Adversarial Hardening Issues | night-run log |
| `docs/ADVERSARIAL_HARDENING_LOG.md` | Adversarial Hardening Log | night log |
| `docs/ADVERSARIAL_RESILIENCE_GATE.md` | Adversarial Resilience Gate | gate report |
| `docs/ARCHITECTURE_REBASE_R0.md` | Architecture Rebase R0 | R0 rebase log |
| `docs/ARCHITECTURE_REBASE_R1_SUPABASE_STAGING.md` | Rebase R1 Supabase Staging | R1 log |
| `docs/BACKEND_CLOSURE_DECISION.md` | Backend Closure Decision | historical decision |
| `docs/BACKEND_PROFESSIONALIZATION_AUDIT.md` | Backend Professionalization Audit | audit |
| `docs/BACKEND_PROFESSIONALIZATION_DECISION.md` | Backend Professionalization Decision | decision |
| `docs/BACKEND_SECURITY_HARDENING_AUDIT.md` | Backend security hardening audit | audit (long) |
| `docs/BASE44_DATA_MIGRATION_CENSUS_R1.md` | Base44 Data Migration Census R1 | Base44-era |
| `docs/BASE44_WORKER_ACTIVATION_BLOCKER.md` | Base44 Worker Activation Blocker | Base44-era |
| `docs/BUYER_PAYMENT_PROVIDER_PRODUCTION_READINESS.md` | Buyer Payment Provider Readiness | readiness audit |
| `docs/BUYER_TRACKING_REFINEMENT.md` | Buyer Tracking Refinement | dated pass |
| `docs/CANONICAL_ARCHITECTURE_V1.md` | Siton V1 Canonical Architecture | Base44 runtime superseded by R2-R4; owner decision PR-22 open |
| `docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md` | Canonical Drift Audit | closed audit |
| `docs/CANONICAL_PRODUCT_POLICY_CODE_CLEANUP_2026-09-16.md` | Code Cleanup Task, policy alignment | finished task record |
| `docs/CANONICAL_REPO_DECISION.md` | Canonical Repo Decision | old decision |
| `docs/CLOSED_PILOT_WAR_GAME_REPORT.md` | Closed pilot war game | report |
| `docs/CLOSING_PRODUCT_GAPS_AUDIT.md` | Closing Product Gaps Audit | audit |
| `docs/CODEX_BASELINE_INTEGRATION_REPORT.md` | Baseline integration report | report |
| `docs/CODEX_BASELINE_REVIEW.md` | Baseline candidate review | review |
| `docs/DB_BACKUP_RESTORE_REHEARSAL.md` | DB backup / restore rehearsal | dated rehearsal |
| `docs/DB_CONFIGURATION_UNIFICATION.md` | DB Configuration Unification | old stage |
| `docs/DEAL_TYPES_E2E_GATE.md` | Deal Types E2E Gate | gate report |
| `docs/DEAL_TYPES_E2E_HANDOFF.md` | Deal Types E2E Handoff | handoff |
| `docs/DEAL_TYPE_EXPANSION_DELIVERY_REPORT.md` | Deal Type Expansion Delivery Report | delivery report |
| `docs/DEMO_DEPLOYMENT_EXECUTION_DECISION.md` | Demo Deployment Execution Decision | old run |
| `docs/DEMO_DEPLOYMENT_EXECUTION_ISSUES.md` | Demo Deployment Execution Issues | old run |
| `docs/DEMO_DEPLOYMENT_EXECUTION_LOG.md` | Demo Deployment Execution Log | old run |
| `docs/DEMO_PREVIEW_DEPLOYMENT_DECISION.md` | Demo/Preview Deployment Decision | old run |
| `docs/DEMO_PREVIEW_DEPLOYMENT_ISSUES.md` | Demo/Preview Deployment Issues | old run |
| `docs/DEMO_PREVIEW_DEPLOYMENT_LOG.md` | Demo/Preview Deployment Log | old run |
| `docs/DOC_ENCODING_AND_READABILITY.md` | Doc Encoding And Readability | old note |
| `docs/EXTERNAL_ACTIVATION_CHECKLIST.md` | V1 External Activation Checklist | Base44-era checklist |
| `docs/FINAL_CANONICAL_AUDIT_DECISION.md` | Final Canonical Audit Decision | old audit |
| `docs/FINAL_CANONICAL_AUDIT_ISSUES.md` | Final Canonical Audit Issues | old audit |
| `docs/FINAL_CANONICAL_AUDIT_LOG.md` | Final Canonical Audit Log | old audit |
| `docs/FINAL_ZERO_DEVELOPMENT_CLOSURE.md` | V1 Final Zero-Development Closure | closeout |
| `docs/FRONTEND_EXECUTION_LOG.md` | Frontend Execution Log | log |
| `docs/FRONTEND_FOUNDATION_RTL_ACCESSIBILITY.md` | Frontend Foundation RTL/A11y | dated stage |
| `docs/FRONTEND_ISSUES.md` | Frontend Issues | old |
| `docs/FRONTEND_PROGRESS_DECISION.md` | Frontend Progress Decision | old |
| `docs/FRONTEND_START_GATE.md` | Frontend Start Gate | old |
| `docs/FULL_E2E_GATE.md` | Full E2E Gate | gate report |
| `docs/FULL_PRODUCT_CLOSURE_DECISION.md` | FULL PRODUCT CLOSURE DECISION | superseded |
| `docs/FULL_PRODUCT_CLOSURE_ISSUES.md` | FULL PRODUCT CLOSURE ISSUES | superseded |
| `docs/FULL_PRODUCT_CLOSURE_LOG.md` | FULL PRODUCT CLOSURE LOG | superseded |
| `docs/FULL_SYSTEM_QA_DECISION.md` | Full System QA Decision | old QA |
| `docs/FULL_SYSTEM_QA_ISSUES.md` | Full System QA Issues | old QA |
| `docs/FULL_SYSTEM_QA_LOG.md` | Full System QA Log | old QA |
| `docs/GAP_REGISTER_MASTER.md` | Gap Register Master | old gap map |
| `docs/HOUSEKEEPING_SUMMARY.md` | Housekeeping Summary | old cleanup |
| `docs/INTERNAL_MAXIMAL_CLOSURE_DECISION.md` | Internal Maximal Closure Decision | old |
| `docs/INTERNAL_MAXIMAL_CLOSURE_ISSUES.md` | Internal Maximal Closure Issues | old |
| `docs/INTERNAL_MAXIMAL_CLOSURE_LOG.md` | Internal Maximal Closure Log | old |
| `docs/LAUNCH_GAP_REPORT.md` | Launch Gap Report (closed web pilot) | dated report |
| `docs/LAUNCH_POLISH_SPRINT_1.md` | Launch Polish Sprint 1 | sprint report |
| `docs/LAUNCH_POLISH_SPRINT_2.md` | Launch Polish Sprint 2 | sprint report |
| `docs/LEGACY_FOUNDATION_DOC_STATUS_2026-04-18.md` | Legacy Foundation Document Status | doc-status note |
| `docs/LOAD_CAPACITY_BASELINE_REPORT.md` | Load & Capacity Baseline Report | dated report |
| `docs/LOCAL_STAGE_COMPLETION_REPORT.md` | Local Stage Completion Report | stage report |
| `docs/LOGGING_HARDENING.md` | Logging Hardening | old stage |
| `docs/MASTER_PRODUCT_DEEP_MAP_AND_HARDENING_DECISION.md` | Master Product Deep Map Decision | old |
| `docs/MASTER_PRODUCT_DEEP_MAP_AND_HARDENING_ISSUES.md` | Master Product Deep Map Issues | old |
| `docs/MASTER_PRODUCT_DEEP_MAP_AND_HARDENING_LOG.md` | Master Product Deep Map Log | superseded |
| `docs/MOBILE_TECHNICAL_INVENTORY.md` | Mobile technical inventory | dated inventory |
| `docs/MONEY_PILOT_SCOPE.md` | Money Pilot Scope | proposal |
| `docs/MORNING_HANDOFF_ADVERSARIAL_HARDENING.md` | Morning Handoff Adversarial Hardening | handoff |
| `docs/MORNING_HANDOFF_BACKEND_PROFESSIONALIZATION.md` | Morning Handoff Backend Prof. | handoff |
| `docs/MORNING_HANDOFF_DEMO_DEPLOYMENT_EXECUTION.md` | Morning Handoff Demo Deployment | handoff |
| `docs/MORNING_HANDOFF_DEMO_PREVIEW_DEPLOYMENT.md` | Morning Handoff Demo/Preview | handoff |
| `docs/MORNING_HANDOFF_FINAL_CANONICAL_AUDIT.md` | Morning Handoff Final Canonical Audit | handoff |
| `docs/MORNING_HANDOFF_FRONTEND_EXECUTION.md` | Morning Handoff Frontend | handoff |
| `docs/MORNING_HANDOFF_FULL_PRODUCT_CLOSURE.md` | Morning Handoff Full Product Closure | superseded |
| `docs/MORNING_HANDOFF_FULL_SYSTEM_QA.md` | Morning Handoff Full System QA | handoff |
| `docs/MORNING_HANDOFF_INTERNAL_MAXIMAL_CLOSURE.md` | Morning Handoff Internal Maximal Closure | handoff |
| `docs/MORNING_HANDOFF_MASTER_PRODUCT_DEEP_MAP_AND_HARDENING.md` | Morning Handoff Master Product Deep Map | superseded |
| `docs/MORNING_HANDOFF_PREPROD_TORTURE_QA.md` | Morning Handoff Preprod Torture QA | handoff |
| `docs/MORNING_HANDOFF_REAL_INTEGRATIONS.md` | Morning Handoff Real Integrations | handoff |
| `docs/MORNING_HANDOFF_REAL_PAYMENT_AND_RECONCILIATION.md` | Morning Handoff Real Payment | handoff |
| `docs/MORNING_HANDOFF_REMAINING_PRODUCT_SURFACES.md` | Morning Handoff Remaining Surfaces | superseded |
| `docs/MORNING_HANDOFF_ULTIMATE_PRELIVE_QA_RC.md` | Morning Handoff Ultimate Pre-Live QA | handoff |
| `docs/MVP_COMPLETION_GATE.md` | MVP Completion Gate | gate report |
| `docs/OPERATIONAL_SCRIPT_VALIDATION.md` | Operational Script Validation | old stage |
| `docs/OVERNIGHT_ENGINEERING_HANDOFF_2026-08-31.md` | Overnight Engineering Handoff | night handoff |
| `docs/P0_ATTACK_PLAN.md` | P0 Attack Plan | old plan |
| `docs/PASS2_BACKEND_DB_ALIGNMENT_2026-04-09.md` | Pass 2 Backend+DB Alignment | pass log |
| `docs/PASS3_DELIVERY_METHOD_PERSISTENCE_2026-04-09.md` | Pass 3 Delivery Method | pass log |
| `docs/PASS4_ACTIVE_PRODUCT_CLEANUP_2026-04-09.md` | Pass 4 Active Product Cleanup | pass log |
| `docs/PASS5_PRODUCT_SURFACE_FOCUS_2026-04-09.md` | Pass 5 Product Surface Focus | pass log |
| `docs/PASS6_COPY_AND_NARRATIVE_UNIFICATION_2026-04-09.md` | Pass 6 Copy Unification | pass log |
| `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md` | Pass 7 Seller Identity | pass log |
| `docs/PAYMENT_JSON_BOUNDARY_AUDIT.md` | Payment JSON Boundary Audit | audit |
| `docs/PAYMENT_PROVIDER_SANDBOX_READINESS.md` | Payment Provider Sandbox Readiness | readiness |
| `docs/PAYMENT_RAIL_ATTACK_PLAN.md` | Payment Rail Attack Plan | old plan |
| `docs/PAYMENT_RED_TEAM_2026-09-18.md` | Payment Rail Red-Team | red-team |
| `docs/POST_E2E_REFACTOR_AUDIT.md` | Post E2E Refactor Audit | audit |
| `docs/PREPROD_TORTURE_QA_DECISION.md` | Preprod Torture QA Decision | old QA |
| `docs/PREPROD_TORTURE_QA_ISSUES.md` | Preprod Torture QA Issues | old QA |
| `docs/PREPROD_TORTURE_QA_LOG.md` | Preprod Torture QA Log | old QA |
| `docs/PRODUCT_CATALOG.md` | Product catalog, Products and frozen Deal snapshots | feature removed by the 2026-09-30 constitution |
| `docs/PRODUCT_DIRECTION_ALIGNMENT_2026-04-09.md` | Product Direction Alignment | old direction |
| `docs/PRODUCT_SURFACES_REFINEMENT.md` | Product Surfaces Refinement | dated stage |
| `docs/PROVIDER_LIVE_MONEY_READINESS.md` | Provider Live Money Readiness | old audit |
| `docs/R2_RUNTIME_PERMISSION_AUDIT.md` | R2 runtime permission audit | audit |
| `docs/R6_STAGING_SHOWCASE.md` | R6 Staging Showcase | showcase |
| `docs/R9A_PAYMENT_FOUNDATION_HARDENING.md` | R9A Payment Foundation Hardening | stage report |
| `docs/R9C_POST_ACCEPTANCE_PREP.md` | R9C post-acceptance prep | stage prep |
| `docs/R9C_PRODUCTION_EXTRACTION_AUDIT.md` | R9C Extraction Audit | audit |
| `docs/RC_EXECUTION_PLAN.md` | RC Execution Plan | old plan |
| `docs/RC_EXECUTION_RESULT.md` | RC Execution Result | old result |
| `docs/RC_GATE_DECISION.md` | RC Gate Decision | old decision |
| `docs/RC_STAGING_SMOKE.md` | RC Staging Deploy Smoke (LEGACY RENDER) | legacy evidence |
| `docs/READ_SURFACES_TRUTH_ALIGNMENT.md` | Read Surfaces Truth Alignment | dated stage |
| `docs/REAL_INTEGRATIONS_DECISION.md` | Real Integrations Decision | old |
| `docs/REAL_INTEGRATIONS_EXECUTION_LOG.md` | Real Integrations Log | old |
| `docs/REAL_INTEGRATIONS_ISSUES.md` | Real Integrations Issues | old |
| `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md` | Real Payment Decision | old |
| `docs/REAL_PAYMENT_AND_RECONCILIATION_ISSUES.md` | Real Payment Issues | old |
| `docs/REAL_PAYMENT_AND_RECONCILIATION_LOG.md` | Real Payment Log | old |
| `docs/RED_TEAM_SYSTEM_2026-09-18.md` | System Red Team | red-team |
| `docs/REMAINING_PRODUCT_SURFACES_DECISION.md` | Remaining Surfaces Decision | superseded |
| `docs/REMAINING_PRODUCT_SURFACES_ISSUES.md` | Remaining Surfaces Issues | old |
| `docs/REMAINING_PRODUCT_SURFACES_LOG.md` | Remaining Surfaces Log | old |
| `docs/REPOSITORY_FINAL_HYGIENE_DECISION.md` | Repository Final Hygiene Decision | old |
| `docs/RUNTIME_VALIDATION_LIMITATIONS.md` | Runtime Validation Limitations | old |
| `docs/SANDBOX_DRY_RUN_REPORT.md` | Sandbox Dry-Run Report | report |
| `docs/SECURITY_HARDENING_GATE.md` | Security Hardening Gate | gate report |
| `docs/SELLER_AUTH_ATTACK_PLAN.md` | Seller Auth Attack Plan | old plan |
| `docs/SENIOR_ADVERSARIAL_REVIEW.md` | Senior Skeptical Engineer Adversarial Review | review; §LONG_HORIZON marked OBSOLETE/HISTORICAL |
| `docs/SHELF_CLOSEOUT_2026-09-17.md` | Shelf closeout, Claude lane | closeout |
| `docs/SITON_V1_1_PRODUCT_DEPTH_AUDIT.md` | V1.1 Product Depth Audit | audit |
| `docs/SOURCE_DOCX_OBSOLETE_RULES.md` | Source .docx, HISTORICAL SOURCE | obsolete rules |
| `docs/SPEC_DRIFT_MAP_2026-04-19.md` | Spec drift map | closed |
| `docs/STAGE11_RUNTIME_VERIFICATION_2026-03-29.md` | Stage 11 Runtime Verification | stage |
| `docs/STAGE12_DUPLICATE_EVENT_VERIFICATION.md` | Stage 12 Duplicate Event | stage |
| `docs/STAGE12_LEGACY_DOC_ALIGNMENT.md` | Stage 12 Legacy Doc Alignment | stage |
| `docs/STAGE12_OPERATIONAL_CONFIDENCE_SUMMARY.md` | Stage 12 Operational Confidence | stage |
| `docs/STAGE12_RESTART_AND_OUTBOX_RECOVERY.md` | Stage 12 Restart/Outbox Recovery | stage |
| `docs/STAGE12_SOAK_TEST_VERIFICATION.md` | Stage 12 Soak Test | stage |
| `docs/STAGE1_RTL_HEBREW_EXTERNAL_ALIGNMENT_2026-04-10.md` | Stage 1 RTL Hebrew Alignment | stage |
| `docs/STAGE32B_LIVE_DIAGNOSIS_2026-08-14.md` | אבחון חי, Stage 32B | live diagnosis |
| `docs/STAGE32B_OPERATIONAL_RECOVERY.md` | Stage 32B Operational Recovery | stage |
| `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` | Stage 4 Operational Readiness Map | stage |
| `docs/STAGE_32C_PRODUCT_SURFACE_CLOSURE.md` | Stage 32C Product Surface Closure | stage |
| `docs/STAGE_32D_FINAL_INTERNAL_CODE_FREEZE.md` | Stage 32D Code Freeze | freeze |
| `docs/STAGE_9D_DRIFT_REPORT.md` | STAGE 9D DRIFT REPORT | historical |
| `docs/STAGING_ACCEPTANCE_2026-09-10.md` | Staging acceptance | acceptance |
| `docs/STAGING_ACCEPTANCE_2026-09-14.md` | Staging acceptance closure | acceptance |
| `docs/STRIPE_SANDBOX_EXTERNAL_VERIFICATION.md` | Stripe Test Mode verification | Stripe-era |
| `docs/SYNTHETIC_MONEY_PROOF.md` | Synthetic Money Proof | proof report |
| `docs/TEMP_AND_SCRIPT_HYGIENE.md` | Temp And Script Hygiene | old |
| `docs/TEST_BASELINE_DECISION.md` | Test Baseline Decision | old |
| `docs/TEST_INVENTORY.md` | TEST INVENTORY, Unit Mapping | old inventory |
| `docs/ULTIMATE_PRELIVE_QA_RC_DECISION.md` | Ultimate Pre-Live QA Decision | old QA |
| `docs/ULTIMATE_PRELIVE_QA_RC_ISSUES.md` | Ultimate Pre-Live QA Issues | old QA |
| `docs/ULTIMATE_PRELIVE_QA_RC_LOG.md` | Ultimate Pre-Live QA Log | old QA |
| `docs/UX_NIGHT_REINTEGRATION.md` | Overnight UX reintegration | night report |
| `docs/V1_1_BASE44_PRE_ACTIVATION_SNAPSHOT.md` | V1.1 Base44 pre-activation snapshot | Base44-era |
| `docs/V1_1_RESUMED_LIVE_CLOSURE_2026-08-26.md` | V1.1 Resumed Live-Closure | Base44-era |
| `docs/db-drift-resolution.md` | db-drift-resolution | old note, unreadable |
| `docs/foundation-canonical-2026-04-18/README.md` | Foundation pack, HISTORICAL SOURCE | marked historical/obsolete |
| `docs/runtime-contract-resolution.md` | runtime-contract-resolution | old note, unreadable |
| `docs/USER_TEST_CONDITIONAL_DEAL_PLAN.md` | Conditional Deal User Test Plan | research plan from 2026-08-23, not an operating document |
| `legacy/render/README.md` | Legacy Render snapshot | quarantined pre-R3 Render snapshot README; evidence only |

## Known drift markers added 2026-09-30

- `docs/CANONICAL_ARCHITECTURE_V1.md`: superseded banner (Base44 as production).
- Base44-era records (`ARCHITECTURE_REBASE_R0`, `R1`, `BASE44_*`, `V1_1_*`, `STAGE32B_*`, `SITON_V1_1_PRODUCT_DEPTH_AUDIT`, `EXTERNAL_ACTIVATION_CHECKLIST`, `FINAL_ZERO_DEVELOPMENT_CLOSURE`, `STAGE_32C`, `STAGE_32D`): historical banner.
- Runtime sentences corrected in place: `ENVIRONMENT_CONTRACT.md`, `AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md`, `INVOICE_PROVIDER_MORNING_ADAPTER.md`, `SITON_V1_1_MALL_PRODUCT_DIRECTION.md`, `MOBILE_APP_RELEASE_READINESS.md`, `RC_STAGING_SMOKE.md`, `legacy/render/README.md`.
- Distributor-as-role wording corrected in REFERENCE docs: `INFORMATION_SECURITY_POLICY.md`, `PRIVACY_DATA_MAP.md`, `PRODUCTION_DATA_ACCESS_BOUNDARIES.md`, `ADMIN_LEGAL_OPS_POLICY.md`, `ACCESSIBILITY_COMPLIANCE.md`, `SECURITY_INCIDENT_RUNBOOK.md`, `LEGAL_TRUST_SURFACES.md`.
- `docs/PRODUCT_CATALOG.md`: removal banner.
- Code-side drift still open (needs its own FULL-profile change): `scripts/architecture_truth_gate.cjs` and `base44/runtime-manifest.json` still assert `production_runtime = base44`.

## Housekeeping candidates (not done here)

- `docs/db-drift-resolution.md`, `docs/runtime-contract-resolution.md`: unreadable encoding, zero consumers.
- `docs/OPERATIONAL_RUNBOOK.md` overlaps `docs/OPERATIONAL_RUNBOOKS.md` (PowerShell era).
- `docs/HOUSEKEEPING_SUMMARY.md` points at a file that no longer exists.
- `PROJECT_STATUS.md` carries ~900 lines of milestone history; the standing rule already says history lives in Git.
