import { strict as assert } from "node:assert";

// Short or username-overlapping secrets require credential context. For all
// lengths, inspect raw, URL-encoded and JSON-escaped representations.
export function leaksCredential(output: string, username: string, password: string): boolean {
  if (!password) return false;
  const representations = new Set([password, encodeURIComponent(password), encodeURIComponent(password).replace(/%[0-9A-F]{2}/g, value => value.toLowerCase()), JSON.stringify(password).slice(1, -1)]);
  // Decode JSON string values instead of guessing which escape spelling a
  // logger selected (quotes, backslashes and Unicode escapes are equivalent).
  for (const match of output.matchAll(/"password"\s*:\s*("(?:\\.|[^"\\])*")/gi)) {
    try { if (representations.has(JSON.parse(match[1]!))) return true; } catch { /* malformed output is inspected below */ }
  }
  for (const secret of representations) {
    if (output.includes(':' + secret + '@')) return true;
    const assignments = /\b["']?password["']?\s*[:=]/gi;
    for (const match of output.matchAll(assignments)) {
      const tail = output.slice(match.index! + match[0].length);
      if ([tail, tail.trimStart()].some(value => [secret, '"' + secret, "'" + secret].some(prefix => value.startsWith(prefix)))) return true;
    }
    // A username is deliberately retained in redacted connection diagnostics.
    // Its substrings cannot independently establish disclosure of a password.
    const usernameForms = [username, encodeURIComponent(username), JSON.stringify(username).slice(1, -1)];
    if (password.length >= 12 && !usernameForms.some(value => value.includes(secret)) && output.includes(secret)) return true;
  }
  return false;
}

export function assertRequestCorrelation(logs: string, expected: string): void {
  assert.match(expected, /^[A-Za-z0-9._:-]{8,160}$/, "expected request id must be canonical");
  const records = logs.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const ids = records.filter(record => Object.hasOwn(record, "reqId")).map(record => record.reqId);
  assert.ok(ids.length > 0, "no request id in captured logs");
  assert.ok(ids.every(id => id === expected), "the log carries a different id than the response");
}
