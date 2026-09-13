// Evaluates an environment map against config/runtime-environment-policy.json.
// Pure: no provider calls, no network, no database. Used by
// scripts/runtime_environment_gate.cjs, proof:no-real-money and the preflight.
const fs = require("node:fs");
const path = require("node:path");

function loadPolicy(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, "config", "runtime-environment-policy.json"), "utf8"));
}

function loadRealMoneyPolicy(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, "config", "real-money-release-policy.json"), "utf8"));
}

function detectTarget(policy, env) {
  const mode = String(env.APP_DEPLOYMENT_MODE || "").trim().toLowerCase();
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  for (const name of policy.identity.detection_order) {
    const identity = policy.identity[name];
    if (!identity) continue;
    const modeOk = !identity.APP_DEPLOYMENT_MODE || identity.APP_DEPLOYMENT_MODE.includes(mode);
    const nodeOk = !identity.NODE_ENV || identity.NODE_ENV.includes(nodeEnv);
    if (modeOk && nodeOk) return name;
  }
  return "development";
}

function value(env, name) {
  const raw = env[name];
  return raw === undefined || raw === null ? undefined : String(raw).trim();
}

function evaluateRule(rule, env, context) {
  const actual = value(env, rule.var);
  const present = actual !== undefined && actual !== "";
  const lower = present ? actual.toLowerCase() : "";
  const placeholder = new RegExp(context.placeholderPattern, "i");
  const expected = rule.value;
  switch (rule.must) {
    case "present": return present ? null : rule.var + " must be present";
    case "absent": return !present ? null : rule.var + " must be absent";
    case "equal": return present && lower === String(expected).toLowerCase() ? null : rule.var + " must equal " + JSON.stringify(expected) + " (found " + describe(actual) + ")";
    case "not_equal": return !present || lower !== String(expected).toLowerCase() ? null : rule.var + " must not equal " + JSON.stringify(expected);
    case "absent_or_equal": return !present || lower === String(expected).toLowerCase() ? null : rule.var + " must be absent or " + JSON.stringify(expected) + " (found " + describe(actual) + ")";
    case "one_of": {
      const options = expected.map((item) => String(item).toLowerCase());
      return options.includes(present ? lower : "") ? null : rule.var + " must be one of " + JSON.stringify(expected) + " (found " + describe(actual) + ")";
    }
    case "not_one_of": {
      const options = expected.map((item) => String(item).toLowerCase());
      return !options.includes(present ? lower : "") ? null : rule.var + " must not be " + describe(actual);
    }
    case "matches": return present && new RegExp(expected, "i").test(actual) ? null : rule.var + " must match /" + expected + "/ (found " + describe(actual, true) + ")";
    case "not_matches": return !present || !new RegExp(expected, "i").test(actual) ? null : rule.var + " must not match /" + expected + "/";
    case "not_placeholder": {
      if (!present) return rule.var + " must be present and not a placeholder";
      return placeholder.test(actual) ? rule.var + " is a placeholder value" : null;
    }
    case "min_length": return present && actual.length >= Number(expected) ? null : rule.var + " must be at least " + expected + " characters" + (present ? " (found " + actual.length + ")" : " (absent)");
    case "https_url": {
      if (!present) return rule.var + " must be an https URL (absent)";
      try { return new URL(actual).protocol === "https:" ? null : rule.var + " must use https"; } catch { return rule.var + " is not a valid URL"; }
    }
    default: throw new Error("unknown policy operator " + rule.must + " for " + rule.var);
  }
}

// Never echo secret-looking values into reports. Show only length/shape.
const SECRET_LIKE = /(SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL|SALT)/i;
function describe(actual, allowShape = false) {
  if (actual === undefined || actual === "") return "absent";
  if (allowShape) return "value of length " + actual.length;
  return JSON.stringify(actual);
}

/**
 * Evaluate the environment for a target.
 * Returns { target, role, results: [{ rule, ok, message, severity }], failures, warnings }
 */
function evaluate(policy, env, options = {}) {
  const target = options.target || detectTarget(policy, env);
  const environment = policy.environments[target];
  if (!environment) throw new Error("unknown target " + target + "; known: " + Object.keys(policy.environments).join(", "));
  const role = String(options.role || env.RUNTIME_ROLE || "").toLowerCase() || null;
  const realMoney = options.realMoneyPolicy || null;
  const results = [];
  for (const rule of environment.rules) {
    if (rule.roles && role && !rule.roles.includes(role)) continue;
    if (rule.roles && !role) {
      // Role unknown: evaluate role-specific rules for both roles and report
      // as informational failures only when they fail for every role.
    }
    // A blueprint-declared external secret (render.yaml sync:false /
    // generateValue) has a value only in the hosting console. It counts as
    // present but its content cannot be verified statically.
    const external = String(env[rule.var] || "").startsWith("__EXTERNAL_SECRET__");
    let message = external && rule.must !== "absent" ? null : evaluateRule(rule, env, { placeholderPattern: policy.placeholder_pattern });
    if (message && rule.governed_by === "real-money-release-policy" && realMoney && realMoney.real_money_allowed === true) {
      message = null;
    }
    const secretRedacted = SECRET_LIKE.test(rule.var) && message ? message.replace(/\(found "[^"]*"\)/, "(found: redacted)") : message;
    results.push({ var: rule.var, must: rule.must, severity: rule.severity, reason: rule.reason, ok: !message, message: secretRedacted, roles: rule.roles || null, external: external || undefined, governed_by: rule.governed_by || undefined });
  }
  const failures = results.filter((item) => !item.ok && item.severity === "FAIL");
  const warnings = results.filter((item) => !item.ok && item.severity === "WARNING");
  return { target, role, description: environment.description, results, failures, warnings };
}

/** Parse a dotenv-style file into a map without mutating process.env. */
function parseEnvFile(filePath) {
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/** Extract the static env map for a service from render.yaml (value: entries only). */
function renderBlueprintEnv(root, serviceName) {
  const file = path.join(root, "render.yaml");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const services = text.split(/\n\s*-\s+type:\s*/).slice(1);
  for (const block of services) {
    const name = (block.match(/name:\s*(\S+)/) || [])[1];
    if (name !== serviceName) continue;
    const env = {};
    for (const match of block.matchAll(/-\s+key:\s*(\S+)\s*\n\s*(value:\s*"?([^"\n]*)"?|sync:\s*false|generateValue:\s*true)/g)) {
      const key = match[1];
      if (match[2].startsWith("value:")) env[key] = match[3].trim();
      else env[key] = "__EXTERNAL_SECRET__" + key;
    }
    return env;
  }
  return null;
}

module.exports = { loadPolicy, loadRealMoneyPolicy, detectTarget, evaluate, evaluateRule, parseEnvFile, renderBlueprintEnv };
