import { strict as assert } from "node:assert";
import { leaksCredential, assertRequestCorrelation } from "./support/log_security_assertions.js";
let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log("PASS " + name); }
const cases = [
  ["postgres", "postgres"], ["prefixabcdefghijklmnop", "abcdefghijklmnop"],
  ["alice", "alice-long-password"], ["u", "x"], ["u", "very-long-secret-123456"],
  ["u", 'p@ ss:"\\'], ["secret-suffix", "secret"], ["p@ ss-prefix", "p@ ss"],
  ["u", "unicode-\u05d0-\u00e9@pass"], ["u", "a+b%2F&?=#"], ["u", '"quoted'], ["u", " leading space"]
];
for (const [index, pair] of cases.entries()) {
  const [username, password] = pair as [string, string];
  const variants: Array<[string, string, boolean]> = [
    ["raw URL", 'postgresql://' + username + ':' + password + '@localhost/db', true],
    ["encoded URL", 'postgresql://' + encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@localhost/db', true],
    ["lowercase encoding", 'postgresql://' + encodeURIComponent(username) + ':' + encodeURIComponent(password).replace(/%[0-9A-F]{2}/g, value => value.toLowerCase()) + '@localhost/db', true],
    ["Unicode-escaped JSON", JSON.stringify({password}).replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')), true],
    ["assignment", 'password=' + password, true],
    ["quoted assignment", "password: '" + password + "'", true],
    ["compact JSON", JSON.stringify({password}), true],
    ["spaced JSON", JSON.stringify({password}, null, 2), true],
    ["userinfo", ':' + password + '@', true],
    ["redacted", 'postgresql://' + username + ':***@localhost/db', false],
    ["encoded redacted", 'postgresql://' + encodeURIComponent(username) + ':***@localhost/db', false],
    ["redacted JSON", JSON.stringify({username, password: "[REDACTED]"}), false],
    ["redacted assignment", 'password=*** user=' + username, false]
  ];
  for (const [form, output, expected] of variants) check('credential case ' + index + ' ' + form, () => {
    assert.equal(leaksCredential(output, username, password), expected, form);
  });
}
for (const id of ['abcdefgh', '00000000-0000-4000-8000-000000000000', 'a'.repeat(160)]) {
  const logs = JSON.stringify({reqId:id, req:{url:'/deals/0abc0000'}}) + '\n' + JSON.stringify({reqId:id, msg:'complete'});
  check('exact correlation length ' + id.length, () => assertRequestCorrelation(logs, id));
  for (const wrong of [id + '-suffix', 'prefix-' + id, 'xx' + id + 'xx', 'wrong-id', 'abc\u0001defgh']) {
    check('negative correlation length ' + id.length + ' ' + wrong.length, () => assert.throws(() => assertRequestCorrelation(JSON.stringify({reqId:wrong}), id)));
  }
  check('mixed stream length ' + id.length, () => assert.throws(() => assertRequestCorrelation(logs + '\n' + JSON.stringify({reqId:'another-id'}), id)));
}
check('no ids is not evidence', () => assert.throws(() => assertRequestCorrelation('{}', 'abcdefgh')));
check('abc is not canonical', () => assert.throws(() => assertRequestCorrelation('{"reqId":"abc"}', 'abc')));
check('old short-id false positive reproduced', () => assert.ok(JSON.stringify({reqId:'abcdefgh',url:'/0abc0000'}).includes('abc')));
check('old equal-credential false positive reproduced', () => assert.ok('postgresql://postgres:***@localhost/db'.includes('postgres')));
console.log('SUMMARY ci_log_security passed=' + passed + ' failed=0');
