const fs = require('node:fs');
const cp = require('node:child_process');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const read = (ref, file) => cp.execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
const ci = read('00861b9ee7205cf9f1304a919a74adad1c32e72f', 'tests/worker_two_process_fencing_validation.ts');
const predicate = ci.slice(ci.indexOf('function leaksCredential(output: string)'), ci.indexOf('// Self-check of the predicate')).replace('output: string', 'output');
const results = [];
for (const [username, password] of [['postgres','postgres'], ['prefixabcdefghijklmnop','abcdefghijklmnop'], ['alice','alice-long-password'], ['u','x'], ['u','very-long-secret-123456'], ['u','p@ ss:"\\'], ['secret-suffix','secret']]) {
  const encoded = encodeURIComponent(password);
  for (const [form, output, expected] of [
    ['raw URL', `postgresql://${username}:${password}@localhost/db`, true],
    ['encoded URL', `postgresql://${encodeURIComponent(username)}:${encoded}@localhost/db`, true],
    ['password assignment', `password=${password}`, true],
    ['compact JSON', JSON.stringify({password}), true],
    ['spaced JSON', JSON.stringify({password}, null, 2), true],
    ['userinfo', `:${password}@`, true],
    ['redacted', `postgresql://${username}:***@localhost/db`, false]
  ]) {
    const actual = vm.runInNewContext(predicate + '\nleaksCredential(output)', { username, password, output });
    results.push({ area: 'credential', case: results.length + 1, form, expected, actual, pass: expected === actual });
  }
}
const request = read('00861b9ee7205cf9f1304a919a74adad1c32e72f', 'tests/request_id_canonical_authority_validation.ts');
const correlation = request.slice(request.indexOf('    const logIds ='), request.indexOf('    if (testCase.header !== null && !testCase.expectPreserved)'));
for (const [name, echoed, ids, expected] of [
  ['exact UUID', '00000000-0000-4000-8000-000000000000', ['00000000-0000-4000-8000-000000000000'], true],
  ['exact canonical short', 'abcdefgh', ['abcdefgh'], true],
  ['long', 'a'.repeat(160), ['a'.repeat(160)], true],
  ['prefix collision', 'abcdefgh', ['abcdefgh-suffix'], false],
  ['suffix collision', 'abcdefgh', ['prefix-abcdefgh'], false],
  ['contained ID', 'abcdefgh', ['xxabcdefghxx'], false],
  ['multiple IDs', 'abcdefgh', ['abcdefgh','ijklmnop'], false],
  ['wrong correlation', 'abcdefgh', ['ijklmnop'], false],
  ['control chars', 'abcdefgh', ['abc\u0001defgh'], false]
]) {
  const logs = ids.map(reqId => JSON.stringify({reqId})).join('\n');
  let actual = true;
  try { vm.runInNewContext(ts.transpile(correlation, {target:ts.ScriptTarget.ES2022}), { logs, echoed, assert }); } catch { actual = false; }
  results.push({ area: 'request correlation', name, expected, actual, pass: expected === actual });
}
const syntheticLog = JSON.stringify({reqId:'req:00000000-0000-4000-8000-000000000000', req:{url:'/deals/0abc0000-0000-4000-8000-000000000000'}});
assert(syntheticLog.includes('abc'), 'old substring failure must reproduce');
assert('postgresql://postgres:***@localhost/db'.includes('postgres'), 'old credential false positive must reproduce');
const db = read('82f9171490ae84fb85eeea198ae071c7e96d4f59', 'src/db.ts');
const guardSource = db.slice(db.indexOf('function attachClientErrorGuard'), db.indexOf('// Read-only view'));
const guard = ts.transpile(guardSource, {target:ts.ScriptTarget.ES2022});
const logs = [];
const client = { on(event, handler) { this.handler = handler; } };
vm.runInNewContext(guard + '\nattachClientErrorGuard(client,"web"); client.handler(new Error("password=SYNTHETIC_SENTINEL"));', { client, clientErrorObservations:[], CLIENT_ERROR_OBSERVATION_LIMIT:200, console:{error(...args){logs.push(args.join(' '));}} });
results.push({area:'pg logging', name:'code-less error message redaction', expected:false, actual:logs.join('').includes('SYNTHETIC_SENTINEL'), pass:!logs.join('').includes('SYNTHETIC_SENTINEL')});
const failures = results.filter(r => !r.pass);
console.log(JSON.stringify({reviewed:{preFinancial:'82f9171490ae84fb85eeea198ae071c7e96d4f59',ci:'00861b9ee7205cf9f1304a919a74adad1c32e72f'}, total:results.length, passed:results.length-failures.length, failed:failures.length, failures}, null, 2));
process.exitCode = failures.length ? 1 : 0;
