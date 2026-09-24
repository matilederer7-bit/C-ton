'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluate } = require('../../scripts/agent_readonly_bash_guard.cjs');

const root = path.resolve(__dirname, '../..');
const guard = path.join(root, 'scripts/agent_readonly_bash_guard.cjs');

function hook(command) {
  return spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
}

test('allows the read-only commands a reviewer and a scout need', () => {
  for (const command of [
    'git diff origin/master...HEAD',
    'git status',
    'git log --oneline -15',
    'git show HEAD:AGENTS.md',
    'git ls-remote origin',
    'git branch -r',
    'git branch --list claude/*',
    'git fetch',
    'git fetch origin',
    'git merge-base origin/master HEAD',
    'ls -la src',
    'grep -rn fee src',
    'rg platform_fee src',
    'find src -name *.ts',
  ]) assert.deepEqual(evaluate(command), { allow: true }, command);
});

test('refuses anything that writes, mutates Git state or runs another program', () => {
  for (const command of [
    'git checkout master',
    'git reset --hard HEAD~1',
    'git stash',
    'git commit -m x',
    'git push origin HEAD',
    'git clean -fdx',
    'git branch evil',
    'git branch -D master',
    'git fetch origin +refs/heads/*:refs/heads/*',
    'git fetch --prune',
    'git -C /tmp log',
    'git -c core.pager=sh log',
    'git diff --output=/tmp/x',
    'git diff --ext-diff',
    'git log --exec=sh',
    'rm -rf .',
    'node scripts/anything.cjs',
    'npm test',
    'npx something',
    'find . -delete',
    'find . -exec rm {} ;',
    'rg --pre sh x',
    'sed -i s/a/b/ AGENTS.md',
    'tee out.txt',
    'python3 -c 1',
  ]) assert.equal(evaluate(command).allow, false, command);
});

test('refuses chaining, pipes, redirection and substitution even around allowed commands', () => {
  for (const command of [
    'git status; rm -rf .',
    'git status && git push',
    'git log || git reset --hard',
    'git log | sh',
    'git diff > patch.diff',
    'cat < /etc/passwd',
    'ls $(rm -rf .)',
    'ls `rm -rf .`',
    'ls ${HOME}',
    'git status\nrm -rf .',
  ]) assert.equal(evaluate(command).allow, false, JSON.stringify(command));
});

test('fails closed on missing or malformed input', () => {
  assert.equal(evaluate(undefined).allow, false);
  assert.equal(evaluate('').allow, false);
  const r = spawnSync(process.execPath, [guard], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('hook exit codes follow the Claude Code contract', () => {
  assert.equal(hook('git status').status, 0);
  const blocked = hook('git push');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /read-only guard/);
});

test('both read-only specialists wire the guard, in both the installed and bootstrap copies', () => {
  for (const name of ['repo-scout', 'security-auditor']) {
    for (const rel of [`.claude/agents/${name}.md`, `docs/agent-team-bootstrap/agents/${name}.md`]) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const front = text.split('\n---\n')[0];
      assert.match(front, /\nhooks:\n  PreToolUse:\n    - matcher: "Bash"\n/, rel);
      assert.match(front, /scripts\/agent_readonly_bash_guard\.cjs/, rel);
      assert.match(front, /\ndisallowedTools: Write, Edit, NotebookEdit\n/, rel);
    }
  }
});
