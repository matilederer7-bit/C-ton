#!/usr/bin/env node
// Team work-plan check (npm run team:plan-check -- <plan.json>).
//
// The team lead (docs/CLAUDE_TEAM_LEAD.md) writes one JSON plan per task
// before any writer starts, and commits it with the Pull Request as evidence.
// This check enforces the owner's coordination rules mechanically:
//
//   - every assignment names a scope, a role and a Definition of Done
//   - builders declare the exact files/directories they may write, and what
//     they must not touch
//   - no two builders may write overlapping paths (parallel writers only on
//     disjoint scopes; Claude and Codex never write the same files)
//   - no builder may write a path already changed by an open Pull Request or
//     active branch listed in `open_branches` (computed from git, not trusted)
//   - reviewers are read-only
//   - every builder is reviewed by a different agent than itself
//   - builders touching database, migrations, security/auth, payments/money,
//     the state machine or the gate tooling itself require a reviewer marked
//     `senior: true`
//   - dependencies reference existing assignments and contain no cycle
//   - every assignment declares the model it runs on (haiku, sonnet or opus,
//     or `n/a` for an agent whose model this project does not choose)
//   - the model matches the risk tier: senior-risk builders and senior
//     reviewers run on opus, and standard-risk work on opus is flagged as a
//     (non-failing) warning so the lead can downshift it. The tier rules are
//     keyed on the DECLARED model and skipped only for `n/a`; an agent whose
//     model this project does not choose may not declare an Anthropic tier
//   - independent workstreams are dispatched in parallel: with two or more
//     builders at least two real agent identities must be able to start at
//     once, unless the plan carries a `serialization_justification`
//   - a builder that waits on another builder argues it in `depends_on_reason`:
//     a dependent builder is normally handed a fixed interface contract and
//     authors in parallel anyway, so a true serial chain has to be defended
//   - a lone builder spanning two or more areas, one whole-tree grant that
//     carries two or more risk families, or a bare single-segment directory
//     grant such as `scripts/` or `web/`, needs a `solo_justification`;
//     otherwise the work is split across parallel builders
//   - every justification carries an argument: >= 40 characters and >= 8
//     distinct words (repetition is filler, not an argument)
//   - every path a builder declares in `allowed` or `forbidden` is spelled the
//     one way that means what it says: a directory ends in `/` and a file does
//     not, and the entry is written in normal form (no leading `/` or `./`, no
//     stray whitespace, no `.` or `..` segment) with the case the working tree
//     actually uses. `scripts` without the slash reached every gate script
//     while scoring no risk family, no area beyond `root` and no overlap at
//     all with a neighbour holding `scripts/`
//   - an overlap with open work is tolerated only when the plan lists the exact
//     CONFLICTING file - the path already changed on the open branch, not the
//     builder's grant - in `accepted_overlaps` and argues it in
//     `overlap_decision`; the finding is then downgraded to a warning, never
//     silently dropped
//
// How the file-versus-directory half of that rule decides, and what it cannot
// see. Round four asked one question - "does the last segment contain a dot?"
// - and `.github` answered yes, so the bare word `.github` was accepted as a
// file and then behaved exactly like the `scripts` hole it was meant to close:
// riskFamilies([".github"]) was [], planAreas([".github"]) was ["root"], and
// pathsOverlap(".github", ".github/workflows/backend-quality-gates.yml") was
// false - a grant of every workflow, the step that runs this very checker
// included, scored as one harmless root-level file. A naming convention cannot
// be the primary test, because what is being tested is not a naming convention.
//
//   - PRIMARY, and decisive whenever it can answer: the working tree itself.
//     An entry naming an existing DIRECTORY must end in `/`; one naming an
//     existing FILE must not. That is a fact rather than a convention, so it
//     needs no allowlist and no guesswork: Dockerfile, android/gradlew and
//     mobile/association-templates/apple-app-site-association pass because the
//     tree says they are files, and `.github`, `scripts`, `src` and `web/src`
//     fail because the tree says they are directories. It reads the same
//     cached listings as the case comparison - one readdir per directory per
//     plan, one walk per entry - so it costs no extra filesystem work.
//   - FALLBACK, reached only where the tree cannot answer: the last segment
//     must carry a "." or be one of the three tracked extensionless basenames.
//     A path absent from the tree is ordinary - a file about to be created -
//     and has to stay writable in a plan. This is round four's heuristic and
//     it is exactly as weak as one: it cannot tell a dotted directory from a
//     file, nor a new extensionless file from a mistyped directory. Confining
//     it to paths the tree does not contain is what makes it safe, because
//     there a wrong answer grants nothing rather than everything underneath.
//   - reading the tree is FAIL-OPEN on purpose, the same posture the case
//     comparison already takes: an unreadable checkout (a bare clone, a
//     sandbox with no working files) yields kind `null` for every entry, and
//     the fallback then decides all of them. So the gate degrades to round
//     four's behaviour instead of refusing to run - never worse than its
//     predecessor, and precise wherever a checkout is present. A gate that
//     cannot run without a working tree is a gate that gets switched off.
//   - the case comparison is likewise silent about a path that does not exist
//     yet and silent if the checkout cannot be read. It compares case only:
//     other filesystem aliases for the same file, such as a Windows 8.3 short
//     name or a differently normalized Unicode name, stay uncovered.
//
// Known limit, left deliberately: an `accepted_overlaps` entry is a bare path,
// scoped neither to a branch nor to a builder, so one entry accepts that same
// file's collision on every open branch and for every builder in the plan, and
// one justified `overlap_decision` covers all entries rather than one each.
// Tightening either needs a richer entry shape than a string, which is a
// plan-format change; until then read an entry as "this file is accepted",
// not "this file, on this branch, for this builder".
//
// Exit 1 on any violation; warnings never fail the gate.
// Output is one line per finding, one per warning, plus a JSON summary.
// Controls: tests/release_tools/team_plan_check.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROLES = new Set(["builder", "reviewer"]);
const AGENTS = new Set(["claude-lead", "claude-subagent", "codex", "chatgpt", "cloud-manager"]);
// Declared model per assignment. Cheap work must not silently run on opus and
// risky work must not silently run on haiku, so the plan states it explicitly.
// "n/a" exists for agents whose model this project does not choose (Codex,
// ChatGPT): making them record an Anthropic tier would write a fabricated
// claim about another vendor into the historic record.
const MODELS = new Set(["haiku", "sonnet", "opus", "n/a"]);
// The agents that run on a model Siton itself picks. "cloud-manager" belongs
// here: .github/workflows/cloud-agent-manager.yml dispatches its Claude
// builder, both Claude review passes and its bounded fix pass through
// anthropics/claude-code-action@v1 with this repository's own
// ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN. Siton does choose that model, so
// a cloud-manager builder on haiku holding src/payment_reconciliation.ts is a
// real, checkable mistake and not another vendor's business.
const CLAUDE_AGENTS = new Set(["claude-lead", "claude-subagent", "cloud-manager"]);

// High-risk path families. Touching any of them makes the builder "senior":
// it needs an independent reviewer with `senior: true` before merge.
// src/app.ts is included because it hosts the deal state machine, charging,
// refunds and outbox handling.
const HIGH_RISK = [
  { family: "database", pattern: /^(src\/migrations\/|supabase\/|scripts\/run_migrations|src\/schema_contract\.ts$|src\/db\.ts$|src\/runtime_database_boundary\.ts$|src\/.*\.sql$)/ },
  { family: "money", pattern: /^src\/(.*payment.*|.*payout.*|platform_fee_money|money_input|vat_authority|invoice_.*|grow_.*|synthetic_payment_provider|payment_reconciliation|webhook_ingestion)\.ts$/ },
  { family: "security", pattern: /^src\/(.*auth.*|seller_auth|admin_identity|otp_rail|participant_tracking_security|production_guards|seller_enforcement|buyer_session|error_monitoring|log_redaction)\.ts$|^config\/(runtime-environment-policy|route-classification)\.json$|^scripts\/protected_route_policy\.cjs$|^web\/src\/(auth|authRedirect|authTrace|session|adminGate|adminStepUp|api)\.tsx?$/ },
  { family: "state-machine", pattern: /^src\/(app|inventory_repository|authorization_lifecycle|outbox_worker_helpers|worker|worker_scheduler)\.ts$/ },
  // The gate tooling itself is as load-bearing as the workflows that run it,
  // and that is the whole of scripts/: every file under it is a gate, a proof,
  // a policy or migration tooling, and whoever edits one of them can switch
  // another off. Naming three files here let a plan grant the real-money proof
  // and the legal gate by name and still be scored standard risk.
  //
  // Two more kinds of control file live outside those two directories:
  //   - tests/release_tools/team_plan_check.test.cjs is not an ordinary test.
  //     A workflow step runs it, and that step IS the enforcement of this
  //     gate, so emptying its assertions turns the step green forever while
  //     the checker still "runs". A control file that a workflow names is gate
  //     tooling whatever directory it happens to sit in.
  //   - Dockerfile, docker-compose*.yml and render.yaml define the production
  //     image and the Render service. They decide what actually runs in
  //     production, which is at least as load-bearing as a workflow file.
  { family: "ci-gates", pattern: /^\.github\/workflows\/|^scripts\/|^tests\/release_tools\/team_plan_check\.test\.cjs$|^Dockerfile$|^docker-compose[^/]*\.ya?ml$|^render\.ya?ml$/ }
];

function declaredModel(item) {
  return String(item?.model || "").trim();
}

function isClaudeAgent(item) {
  return CLAUDE_AGENTS.has(item?.agent);
}

// A justification has to carry an argument, not filler. A length-only bar
// passed "." x 40; adding a word count passed "because " x 6, and two more
// repeats cleared that too ("because " x 8, "we " x 20, "TODO " x 9, or one
// word repeated 16 times). Repetition is the tell, so the bar counts DISTINCT
// words as well: filler repeats itself, an argument does not.
function justified(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const words = text.split(" ").filter(Boolean);
  const distinct = new Set(words.map((word) => word.toLowerCase())).size;
  return text.length >= 40 && words.length >= 8 && distinct >= 8;
}

// Forgiving on purpose, and deliberately more forgiving than the plan format:
// every comparison below has to agree about what a path is even when an entry
// arrives decorated, so surrounding whitespace, backslashes, a leading "./",
// a leading "/" and a trailing "/**" are all folded away here. The spelling
// rule then requires the plan to have written the normal form in the first
// place, so a future call site that forgets to normalize cannot reopen the
// hole this function is quietly closing.
function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/\*\*$/, "/");
}

// Paths are exact files or directory prefixes ending in "/".
function pathsOverlap(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith("/") && right.startsWith(left)) return true;
  if (right.endsWith("/") && left.startsWith(right)) return true;
  return false;
}

// FALLBACK ONLY: consulted for a path the working tree does not contain, where
// the primary tree lookup has no answer. For all three of these the tree does
// answer - they are tracked files present in any ordinary checkout - so this
// list now matters only when the checkout cannot be read, or when one of them
// is itself about to be created. The only files this repository tracks that
// carry no extension:
//   git ls-files | grep -vE '\.[^/]*$'
// returns exactly Dockerfile, android/gradlew and
// mobile/association-templates/apple-app-site-association - 3 of 1371 tracked
// files. The fallback reads a last segment without a "." as a directory written
// wrong, so those three basenames are named here instead of guessed at.
// Dockerfile is already matched by exact name in the ci-gates pattern above.
const EXTENSIONLESS_FILES = new Set(["Dockerfile", "gradlew", "apple-app-site-association"]);

// The repository root, found by walking up from this file rather than trusting
// the caller's cwd, so the case check answers the same way from the CLI and
// from a test process that runs in a temporary directory. No shell-out: a
// worktree's .git is a file and a plain checkout's is a directory, and
// fs.existsSync accepts both.
let REPO_ROOT = null;
function repoRoot() {
  if (REPO_ROOT) return REPO_ROOT;
  let dir = __dirname;
  for (let step = 0; step < 16; step += 1) {
    try { if (fs.existsSync(path.join(dir, ".git"))) { REPO_ROOT = dir; return REPO_ROOT; } } catch (error) { /* unreadable: keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  REPO_ROOT = path.dirname(__dirname);
  return REPO_ROOT;
}

// One cached readdir per directory, shared by every entry in the plan. Dirents
// rather than bare names, because the same listing that says whether the tree
// spells a segment this way also says whether that segment is a file or a
// directory - the two questions pathSpellingProblem asks, answered from one
// walk and no extra filesystem work. A listing that cannot be read is cached
// as null and means "unknown", never "absent": see the fail-open note above.
function treeEntries(dir, cache) {
  if (!cache.has(dir)) {
    let listing = null;
    try { listing = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { listing = null; }
    cache.set(dir, listing);
  }
  return cache.get(dir);
}

// Walk one path against the names the working tree actually carries and report
// both facts the spelling rule needs.
//
// `mismatch`: the first segment whose case is wrong, or null. "SCRIPTS/" is a
// real write path to scripts/ on this Windows checkout and on macOS, a
// different path on Linux, and it matches none of the HIGH_RISK patterns; only
// the tree knows which spelling is real, so this reads it rather than
// lowercasing paths silently and pretending the two are one. Null includes the
// case of a path that does not exist yet, ordinary for a file about to be
// written.
//
// `kind`: "dir", "file", or null when the tree cannot say - the path is not
// there, or a listing could not be read. Any trailing "/" on the entry is
// ignored here: what the tree holds is a fact about the path, and comparing it
// against how the plan spelled the entry is the caller's job.
function treeLookup(value, cache) {
  let dir = repoRoot();
  let walked = "";
  let leaf = null;
  for (const segment of value.split("/").filter(Boolean)) {
    const listing = treeEntries(dir, cache);
    if (!listing) return { mismatch: null, kind: null };
    leaf = listing.find((item) => item.name === segment);
    if (!leaf) {
      const actual = listing.find((item) => item.name.toLowerCase() === segment.toLowerCase());
      return { mismatch: actual ? { segment, actual: walked ? `${walked}/${actual.name}` : actual.name } : null, kind: null };
    }
    walked = walked ? `${walked}/${segment}` : segment;
    dir = path.join(dir, segment);
  }
  if (!leaf) return { mismatch: null, kind: null };
  if (leaf.isDirectory()) return { mismatch: null, kind: "dir" };
  if (leaf.isFile()) return { mismatch: null, kind: "file" };
  // A symlink or a Windows junction: the dirent describes the link itself, so
  // ask what it resolves to. A broken link stays unknown and takes the fallback.
  let resolved = null;
  try { resolved = fs.statSync(dir); } catch (error) { resolved = null; }
  if (!resolved) return { mismatch: null, kind: null };
  return { mismatch: null, kind: resolved.isDirectory() ? "dir" : "file" };
}

// A grant has to name exactly one thing, and name it the way the tree spells it.
// Returns the reason an entry does not, or null.
//
// The hole this closes: "scripts" without the trailing slash reached every file
// under scripts/ while riskFamilies() scored it [] (the pattern is ^scripts\/ and
// the prefix widening is gated on a trailing "/"), planAreas() scored it "root"
// so no whole-tree span fired, and pathsOverlap("scripts",
// "scripts/proof_no_real_money.cjs") was false - so a lead builder on haiku could
// hold the whole gate tree with a junior reviewer, and a second builder holding
// "scripts/" collided with it nowhere. An ambiguous grant is now impossible to
// write rather than merely expensive.
function pathSpellingProblem(raw, cache) {
  const text = String(raw === null || raw === undefined ? "" : raw);
  const value = normalizePath(text);
  if (!value) return "is empty";
  const segments = value.split("/");
  if (segments.slice(0, -1).some((segment) => !segment)) return 'contains an empty segment (a doubled "/")';
  if (segments.some((segment) => segment === "." || segment === "..")) return 'contains a "." or ".." segment';
  // One walk, both answers. Per the header: the working tree decides the
  // file-versus-directory question wherever it can answer, and the dot
  // heuristic is only the fallback for a path the tree does not contain.
  const { kind, mismatch } = treeLookup(value, cache);
  const trailing = value.endsWith("/");
  if (kind === "dir" && !trailing) return `names a directory in the working tree, so it must end in a slash: write it as ${value}/`;
  if (kind === "file" && trailing) return `names a file in the working tree, so it must not end in a slash: write it as ${value.slice(0, -1)}`;
  if (kind === null && !trailing) {
    const last = segments[segments.length - 1];
    if (!last.includes(".") && !EXTENSIONLESS_FILES.has(last)) return `is neither a file nor a directory: write a directory as ${value}/, and a file with its extension`;
  }
  if (text !== value) return `is not written in normal form: write it as ${value}`;
  if (mismatch) return `differs from the tree only in case: the repository has ${mismatch.actual}, not ${mismatch.segment}`;
  return null;
}

const HIGH_RISK_PREFIXES = {
  "database": ["src/migrations/", "supabase/"],
  "money": ["src/"],
  "security": ["src/", "config/", "web/src/"],
  "state-machine": ["src/"],
  // A broad `scripts/` grant is treated as gate-risk the same way a broad
  // `src/` grant is treated as money/security risk.
  // tests/release_tools/ is listed so that a directory grant of tests/ (or of
  // tests/release_tools/) is scored gate-risk too: the gate's own control file
  // lives under it.
  "ci-gates": [".github/workflows/", "scripts/", "tests/release_tools/"]
};

// A directory grant is conservatively risky if a high-risk file could live
// under it.
function riskFamilies(paths) {
  const families = new Set();
  for (const raw of paths) {
    const value = normalizePath(raw);
    for (const { family, pattern } of HIGH_RISK) {
      if (pattern.test(value) || (value.endsWith("/") && HIGH_RISK_PREFIXES[family].some((prefix) => prefix.startsWith(value) || value.startsWith(prefix)))) families.add(family);
    }
  }
  return [...families].sort();
}

// Coarse areas of the codebase, used to judge how wide one builder's grant is.
// First match wins, so src/migrations/ is database rather than backend.
const AREAS = [
  ["docs", ["docs/"]],
  ["tests", ["tests/", "external-tests/"]],
  ["frontend", ["web/", "frontend/", "assets/", "android/", "ios/"]],
  ["database", ["src/migrations/", "supabase/"]],
  ["backend", ["src/"]],
  ["tooling", ["scripts/"]],
  ["ci", [".github/"]],
  ["config", ["config/"]]
];

function planAreas(paths) {
  const areas = new Set();
  for (const raw of paths || []) {
    const value = normalizePath(raw);
    if (!value) continue;
    // Root-level markdown (CLAUDE.md, PROJECT_STATUS.md) is documentation;
    // every other root-level file shares one "root" area, so a manifest pair
    // such as package.json + package-lock.json is not a two-area sprawl.
    if (!value.includes("/")) { areas.add(value.endsWith(".md") ? "docs" : "root"); continue; }
    const hit = AREAS.find(([, prefixes]) => prefixes.some((prefix) => value.startsWith(prefix)));
    areas.add(hit ? hit[0] : value.split("/")[0]);
  }
  return [...areas].sort();
}

function branchPaths(branch, base, cwd) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot diff ${branch} against ${base}: ${String(result.stderr || "").trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function checkPlan(plan, options = {}) {
  const findings = [];
  const warnings = [];
  const fail = (code, message) => findings.push({ code, message });
  // Warnings are advice for the lead; they never fail the gate.
  const warn = (code, message) => warnings.push({ code, message });
  const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];

  if (!plan || typeof plan !== "object") fail("plan_invalid", "plan must be a JSON object");
  if (!String(plan?.task || "").trim()) fail("task_missing", "plan.task must describe the owner's outcome");
  if (!assignments.length) fail("assignments_missing", "plan.assignments must list at least one assignment");

  // One readdir per directory per plan, shared by every path-spelling check.
  const spellingCache = new Map();
  const ids = new Set();
  for (const item of assignments) {
    const id = String(item?.id || "").trim();
    if (!id) { fail("id_missing", "every assignment needs an id"); continue; }
    if (ids.has(id)) fail("id_duplicate", `assignment id ${id} is used twice`);
    ids.add(id);
    if (!ROLES.has(item.role)) fail("role_invalid", `${id}: role must be builder or reviewer`);
    if (!AGENTS.has(item.agent)) fail("agent_invalid", `${id}: agent must be one of ${[...AGENTS].join(", ")}`);
    if (!String(item.scope || "").trim()) fail("scope_missing", `${id}: scope (area of responsibility) is required`);
    if (!Array.isArray(item.dod) || !item.dod.length) fail("dod_missing", `${id}: dod (Definition of Done) must list at least one item`);
    if (!Array.isArray(item.depends_on)) fail("depends_on_missing", `${id}: depends_on must be an array (empty when independent)`);
    const model = declaredModel(item);
    if (!model) fail("model_missing", `${id}: model must be declared (haiku, sonnet, opus, or n/a for an agent whose model this project does not choose)`);
    else if (!MODELS.has(model)) fail("model_invalid", `${id}: model must be one of ${[...MODELS].join(", ")}`);
    else if (model === "n/a" && isClaudeAgent(item)) fail("model_not_applicable_misused", `${id}: model n/a is only for agents whose model this project does not choose; a Claude agent must declare haiku, sonnet or opus`);
    // The mirror image, and the hole the "n/a" value was introduced to close:
    // Siton does not select this agent's model, so naming an Anthropic tier for
    // it is an unverifiable claim about another vendor's product. A fabricated
    // {agent: "codex", model: "sonnet"} is exactly how one reached a committed
    // record, and keying the tier rules on the agent then let it validate clean.
    else if (model !== "n/a" && !isClaudeAgent(item)) fail("model_fabricated", `${id}: agent ${item.agent} runs on a model this project does not choose, so declaring the Anthropic tier ${model} states an unverifiable fact about another vendor; declare model n/a`);
    if (item.role === "builder") {
      if (!Array.isArray(item.allowed) || !item.allowed.length) fail("allowed_missing", `${id}: builder must declare allowed paths`);
      if (!Array.isArray(item.forbidden)) fail("forbidden_missing", `${id}: builder must declare forbidden paths (may be empty only deliberately)`);
      for (const [key, entries] of [["allowed", item.allowed], ["forbidden", item.forbidden]]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const problem = pathSpellingProblem(entry, spellingCache);
          if (problem) fail("path_spelling_ambiguous", `${id}: ${key} path ${JSON.stringify(String(entry === null || entry === undefined ? "" : entry))} ${problem}`);
        }
      }
    }
    if (item.role === "reviewer") {
      if (Array.isArray(item.allowed) && item.allowed.length) fail("reviewer_writes", `${id}: reviewers are read-only; allowed must be empty`);
      if (!Array.isArray(item.reviews) || !item.reviews.length) fail("reviews_missing", `${id}: reviewer must list the builder ids it reviews`);
    }
  }

  const byId = new Map(assignments.filter((item) => item?.id).map((item) => [String(item.id), item]));
  for (const item of assignments) {
    for (const dep of item?.depends_on || []) if (!byId.has(String(dep))) fail("depends_on_unknown", `${item.id}: depends_on references unknown assignment ${dep}`);
    for (const target of item?.reviews || []) {
      const reviewed = byId.get(String(target));
      if (!reviewed) fail("reviews_unknown", `${item.id}: reviews unknown assignment ${target}`);
      else if (reviewed.role !== "builder") fail("reviews_non_builder", `${item.id}: reviews ${target}, which is not a builder`);
    }
  }

  // Dependency cycles (depth-first search).
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") { fail("depends_on_cycle", `dependency cycle: ${[...trail, id].join(" -> ")}`); return; }
    state.set(id, "active");
    for (const dep of byId.get(id)?.depends_on || []) if (byId.has(String(dep))) visit(String(dep), [...trail, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);

  const builders = assignments.filter((item) => item?.role === "builder" && Array.isArray(item.allowed));
  const reviewers = assignments.filter((item) => item?.role === "reviewer");

  for (const builder of builders) {
    for (const allowed of builder.allowed) {
      for (const forbidden of builder.forbidden || []) {
        if (pathsOverlap(allowed, forbidden)) fail("allowed_forbidden_conflict", `${builder.id}: ${allowed} is both allowed and forbidden (${forbidden})`);
      }
    }
  }

  for (let i = 0; i < builders.length; i += 1) {
    for (let j = i + 1; j < builders.length; j += 1) {
      for (const left of builders[i].allowed) {
        for (const right of builders[j].allowed) {
          if (pathsOverlap(left, right)) fail("writer_overlap", `${builders[i].id} and ${builders[j].id} may both write ${normalizePath(left)} / ${normalizePath(right)}`);
        }
      }
    }
  }

  // An overlap with open work is normally fatal. The lead may accept a named
  // one, but only in machine-checkable form: the exact granted path listed in
  // plan.accepted_overlaps, plus a justified plan.overlap_decision arguing it.
  // Prose alone left "print TEAM_PLAN_PASS before dispatch" unsatisfiable for
  // any task touching a file an open Pull Request also touches.
  const acceptedOverlaps = [...new Set((Array.isArray(plan?.accepted_overlaps) ? plan.accepted_overlaps : []).map(normalizePath).filter(Boolean))];
  const overlapDecisionOk = justified(plan?.overlap_decision);
  const usedOverlapEntries = new Set();
  let unjustifiedAcceptance = false;
  const openBranchPaths = options.openBranchPaths || {};
  for (const [branch, paths] of Object.entries(openBranchPaths)) {
    for (const builder of builders) {
      // EVERY conflicting file under the grant, not just the first one. With
      // acceptance keyed on the conflict, stopping at the first hit would let a
      // single entry keep waving through the rest of a directory collision: the
      // first hit would be accepted and the loop would move on without ever
      // looking at the others.
      for (const allowed of builder.allowed) {
        for (const hit of paths.filter((changed) => pathsOverlap(allowed, changed))) {
          const message = `${builder.id}: ${normalizePath(allowed)} overlaps ${hit}, already changed on open branch ${branch}`;
          // Match the CONFLICT, not the grant. Matching the granted path meant a
          // grant of "src/" plus a single accepted_overlaps entry of "src/" waved
          // through every collision beneath it - a migration and
          // src/payment_reconciliation.ts included - from one line. The entry has
          // to name the file actually changed on the open branch, by exact
          // normalized equality, so a directory grant must list each conflict.
          const entry = acceptedOverlaps.find((accepted) => accepted === normalizePath(hit));
          if (entry && overlapDecisionOk) { usedOverlapEntries.add(entry); warn("open_work_overlap_accepted", `${message}; accepted by plan.accepted_overlaps entry ${entry}`); continue; }
          if (entry) unjustifiedAcceptance = true;
          fail("open_work_overlap", message);
        }
      }
    }
  }
  if (unjustifiedAcceptance) fail("overlap_decision_missing", "plan.accepted_overlaps claims an overlap with open work, but plan.overlap_decision does not argue it (>= 40 characters and >= 8 distinct words); the overlaps above stand");
  // An entry that matched nothing is stale rather than wrong: it is reported
  // so the reader can see the plan carries an acceptance it never used.
  const acceptedOverlapsUnused = acceptedOverlaps.length - usedOverlapEntries.size;

  // Builder-only dependency graph: used for the workstream count below.
  const builderIds = new Set(builders.map((builder) => String(builder.id)));
  const builderDeps = (item) => (item?.depends_on || []).map(String).filter((dep) => builderIds.has(dep));
  // A builder is a root only when nothing known blocks it. A reviewer id
  // blocks just as hard as a builder id: build -> review -> rework is a serial
  // plan, and filtering reviewers out of the dependency list made it look like
  // two independent roots.
  const blockingDeps = (item) => (item?.depends_on || []).map(String).filter((dep) => byId.has(dep));
  const roots = builders.filter((builder) => !blockingDeps(builder).length);
  const parallelBuilders = roots.length;
  // Real concurrency is bounded by agent identities, not by plan rows. Each
  // claude-subagent root is its own instance; every other agent value is a
  // single identity, so two rows both assigned to claude-lead (or both to
  // codex) run one after the other however the plan is drawn.
  const parallelIdentities = new Set(roots.map((builder, index) => (builder.agent === "claude-subagent" ? `claude-subagent#${index}` : `agent:${builder.agent}`))).size;

  // Weakly-connected components (union-find, direction ignored): one component
  // is one workstream that must run end to end before the next one can.
  const parent = new Map([...builderIds].map((id) => [id, id]));
  const find = (id) => { let root = id; while (parent.get(root) !== root) root = parent.get(root); return root; };
  for (const builder of builders) {
    for (const dep of builderDeps(builder)) {
      const left = find(String(builder.id));
      const right = find(dep);
      if (left !== right) parent.set(left, right);
    }
  }
  const workstreams = new Set([...builderIds].map(find)).size;

  if (builders.length >= 2 && parallelIdentities < 2 && !justified(plan?.serialization_justification)) {
    fail("parallel_dispatch_missing", `${builders.length} builders but only ${parallelIdentities} can start in parallel; split the independent workstreams or set plan.serialization_justification (>= 40 characters and >= 8 distinct words)`);
  }
  // Chaining one builder behind another is the thing parallel dispatch exists
  // to avoid. The lead's own procedure hands a dependent builder a fixed
  // interface contract so its authoring still runs at the same time, so a real
  // serial dependency is an argument to make, not an assertion to record.
  // Every declared blocking dependency counts, not only a builder one: running
  // over builder ids alone let a builder dodge the rule by depending on a
  // REVIEWER of the builder it really waits for, which is a strictly longer
  // serial chain (finish, then be reviewed) and needed no argument at all.
  for (const builder of builders) {
    for (const dep of blockingDeps(builder)) {
      const depRole = byId.get(dep)?.role === "reviewer" ? "reviewer" : "builder";
      if (!justified(builder.depends_on_reason)) fail("serial_dependency_unjustified", `${builder.id}: waits on ${depRole} ${dep}; author against a fixed interface contract in parallel, or set ${builder.id}.depends_on_reason (>= 40 characters and >= 8 distinct words) explaining why it cannot`);
    }
  }
  if (builders.length === 1) {
    const areas = planAreas(builders[0].allowed);
    // One area can still be the whole of it: src/ is a single area and every
    // risk family at once. Two or more families count as an extra span, so a
    // whole-tree grant fires here while one gate script does not.
    // Area count alone is blind to width INSIDE one area: scripts/ (all gate,
    // proof and policy scripts), web/ (the whole frontend), .github/ (every
    // workflow), supabase/, config/, tests/, docs/ and frontend/ are each a
    // single area carrying at most one risk family, so none of them used to
    // need an argument. A bare single-segment directory grant is a whole
    // top-level tree and counts as an extra span on its own. Narrower grants
    // do not match: "scripts/one_gate.cjs", "web/src/styles.css" and root
    // files such as package.json all stay at span 1.
    const wholeTopLevelTree = builders[0].allowed.some((raw) => /^[^/]+\/$/.test(normalizePath(raw)));
    const span = areas.length + (riskFamilies(builders[0].allowed).length >= 2 ? 1 : 0) + (wholeTopLevelTree ? 1 : 0);
    if (span >= 2 && !justified(plan?.solo_justification)) {
      fail("solo_justification_missing", `${builders[0].id}: one builder spans ${areas.join(", ")}; split the areas across parallel builders or set plan.solo_justification (>= 40 characters and >= 8 distinct words)`);
    }
  }

  for (const reviewer of reviewers) {
    // Keyed on the DECLARED model, skipped only for an honest "n/a". Keying it
    // on the agent meant a reviewer that fabricated a tier escaped the tier
    // rule; a stated tier is a claim, and a claim is held to the bar.
    if (reviewer.senior === true && declaredModel(reviewer) !== "n/a" && declaredModel(reviewer) !== "opus") fail("reviewer_model_underpowered", `${reviewer.id}: senior reviewer requires model: opus`);
  }

  const summary = [];
  for (const builder of builders) {
    const families = riskFamilies(builder.allowed);
    const model = declaredModel(builder);
    const covering = reviewers.filter((reviewer) => (reviewer.reviews || []).map(String).includes(String(builder.id)));
    // Separate sub-agent instances are independent of each other; the lead,
    // Codex, ChatGPT and the cloud manager are single identities and cannot
    // review their own work.
    const independent = covering.filter((reviewer) => reviewer.agent !== builder.agent || builder.agent === "claude-subagent");
    if (!independent.length) fail("review_missing", `${builder.id}: no independent reviewer (a different agent than the builder)`);
    if (families.length && !independent.some((reviewer) => reviewer.senior === true)) {
      fail("senior_review_missing", `${builder.id}: touches ${families.join(", ")}; an independent reviewer with senior: true is required before merge`);
    }
    // Both tier rules are keyed on the DECLARED model and skip only "n/a".
    // Keying them on the agent was the round-two regression: it made the very
    // value the "n/a" rule exists to prevent - a non-Claude agent declaring an
    // Anthropic tier - skip the tier check, so {agent: "codex", model: "sonnet"}
    // validated clean on a payments path. An agent that states a tier is held
    // to it (and pays model_fabricated above for stating it at all).
    if (families.length && model !== "n/a" && model !== "opus") {
      fail("model_underpowered", `${builder.id}: touches ${families.join(", ")}; senior-risk builders require model: opus`);
    }
    // "opus" is by definition not "n/a", so no extra skip is needed here.
    // The lead itself is always opus, so it never counts as over-provisioned.
    if (!families.length && model === "opus" && builder.agent !== "claude-lead") {
      warn("model_overpowered", `${builder.id}: standard-risk work (${planAreas(builder.allowed).join(", ")}) on opus; a cheaper model is likely sufficient`);
    }
    summary.push({ id: builder.id, agent: builder.agent, model, risk: families.length ? "senior" : "standard", families, reviewers: covering.map((reviewer) => reviewer.id) });
  }

  return { ok: findings.length === 0, findings, warnings, builders: summary, workstreams, parallelBuilders, parallelIdentities, acceptedOverlapsUnused };
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error("usage: node scripts/team_plan_check.cjs <plan.json> [--base origin/master]");
    return 2;
  }
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex !== -1 ? argv[baseIndex + 1] : "origin/master";
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    console.error(`TEAM_PLAN_FAIL plan_unreadable ${error.message}`);
    return 1;
  }
  const openBranchPaths = {};
  for (const branch of plan.open_branches || []) {
    try {
      openBranchPaths[branch] = branchPaths(branch, base, process.cwd());
    } catch (error) {
      console.error(`TEAM_PLAN_FAIL open_branch_unreadable ${error.message}`);
      return 1;
    }
  }
  const result = checkPlan(plan, { openBranchPaths });
  for (const finding of result.findings) console.log(`TEAM_PLAN_FINDING ${finding.code} ${finding.message}`);
  for (const warning of result.warnings) console.log(`TEAM_PLAN_WARN ${warning.code} ${warning.message}`);
  for (const builder of result.builders) console.log(`TEAM_PLAN_BUILDER ${builder.id} agent=${builder.agent} risk=${builder.risk}${builder.families.length ? " families=" + builder.families.join(",") : ""} reviewers=${builder.reviewers.join(",") || "none"} model=${builder.model || "none"}`);
  console.log(`TEAM_PLAN_SUMMARY ${JSON.stringify({ ok: result.ok, findings: result.findings.length, warnings: result.warnings.length, builders: result.builders.length, workstreams: result.workstreams, parallel_builders: result.parallelBuilders, parallel_identities: result.parallelIdentities, accepted_overlaps_unused: result.acceptedOverlapsUnused, open_branches_checked: Object.keys(openBranchPaths).length })}`);
  console.log(result.ok ? "TEAM_PLAN_PASS" : "TEAM_PLAN_FAIL");
  return result.ok ? 0 : 1;
}

module.exports = { checkPlan, pathsOverlap, riskFamilies, planAreas };

if (require.main === module) process.exit(main(process.argv.slice(2)));
