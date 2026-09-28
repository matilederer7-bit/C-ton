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
    "git branch --list 'claude/*'",
    'git branch --contains HEAD',
    'git fetch',
    'git fetch origin',
    'git merge-base origin/master HEAD',
    'ls -la src',
    'grep -rn fee src',
    'rg platform_fee src',
    "find src -name '*.ts'",
    'git log --format=%h -n 3',
    'git log --output-indicator-new=+ -1',
    'git diff --no-ext-diff HEAD~1',
    'git show HEAD^:AGENTS.md',
    'grep -rn "platform fee" src',
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

// Claude Code skips frontmatter hooks for an untrusted project folder but still
// grants the listed tools (observed 2026-09-28, Claude Code 2.1.284: "Skipping
// frontmatter hooks for agent 'repo-scout': the folder ... is not trusted").
// A hook-guarded Bash therefore fails open, so read-only specialists get no
// Bash at all.
test('read-only specialists fail closed: no Bash, and no reliance on frontmatter hooks', () => {
  for (const name of ['repo-scout', 'security-auditor', 'status-keeper']) {
    const text = fs.readFileSync(path.join(root, `.claude/agents/${name}.md`), 'utf8');
    const front = text.split('\n---\n')[0];
    assert.match(front, /\ntools: Read, Grep, Glob\n/, name);
    assert.match(front, /\ndisallowedTools: (Bash, )?Write, Edit, NotebookEdit\n/, name);
    if (name !== 'status-keeper') assert.match(front, /\ndisallowedTools: Bash, /, name);
    assert.doesNotMatch(front, /\nhooks:/, name);
  }
});

test('cloud Claude reviewers run under the guard, re-materialized from an immutable step output right before each review', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/cloud-agent-manager.yml'), 'utf8');
  const pin = workflow.indexOf('- name: Pin read-only review guard');
  const firstAgent = workflow.indexOf('uses: anthropics/claude-code-action@v1');
  const codexAgent = workflow.indexOf('uses: openai/codex-action@v1');
  assert.ok(pin > workflow.indexOf('- name: Checkout canonical master'));
  assert.ok(pin > 0 && pin < firstAgent && pin < codexAgent, 'guard must be captured before any builder can modify the checkout');
  assert.match(workflow, /echo "guard_b64=\$\(base64 -w0 scripts\/agent_readonly_bash_guard\.cjs\)" >> "\$GITHUB_OUTPUT"/);
  const steps = workflow.split(/\n      - name: /);
  for (const pass of [1, 2]) {
    const index = steps.findIndex((step) => step.startsWith(`Claude review pass ${pass}`));
    assert.ok(index > 0, `review pass ${pass}`);
    const materialize = steps[index - 1];
    assert.ok(materialize.startsWith(`Materialize read-only review guard (pass ${pass})`), 'guard must be re-materialized immediately before the reviewer');
    assert.match(materialize, /GUARD_B64: \$\{\{ steps\.review_guard\.outputs\.guard_b64 \}\}/);
    assert.match(materialize, /sha256sum -c --quiet -/);
    assert.match(materialize, /rm -rf "\$dir"/);
    assert.match(steps[index], /--settings \$\{\{ runner\.temp \}\}\/siton-review-guard\/settings\.json/);
    assert.match(steps[index], /--disallowedTools Write Edit MultiEdit NotebookEdit/);
    const condition = (text) => /\n        if: (.*)\n/.exec(text)[1];
    assert.equal(condition(materialize), condition(steps[index]));
  }
});

// Bypasses found in review of PR #79: the old guard checked the raw string,
// but the shell performs quote removal before Git parses its options.
test('refuses option spellings that only become dangerous after shell quote removal', () => {
  for (const command of [
    'git diff --output"=proof.txt"',
    "git diff '--output=proof.txt'",
    'git diff --ou"tput"=proof.txt',
    'git diff --outp=proof.txt',
    'git log --output proof.txt',
    'git grep --open-files-in-pager=sh invoked',
    'git grep --open-files=sh invoked',
    'git grep -Osh invoked',
    'git grep -nO sh invoked',
    "git ls-remote '--upload-pack=touch x' origin",
    'git cat-file --filters HEAD:AGENTS.md',
    'git show --textconv HEAD:AGENTS.md',
    'git log --ext-diff -p',
    'git log --exec-path',
    "find . '-delete'",
    'find . -ex"ec" rm {} +',
    "rg '--pre=sh' x",
    'rg --hostname-bin=sh x',
    // Independent review of PR #124: a value-taking option consumes `--` or
    // `--end-of-options` as its value and Git keeps parsing options after it.
    'git log --author --end-of-options --output=pwned1 -p',
    'git show -S --end-of-options --output=pwned3',
    'git diff -S --end-of-options --output=pwned5 HEAD~1',
    'git diff --src-prefix --end-of-options --output=pwnA HEAD~1',
    "git diff --line-prefix '[core] fsmonitor = touch x #' --src-prefix --end-of-options --output=.git/config HEAD~1",
    'git diff --src-prefix -- --output=pwnB HEAD~1',
    "git grep -e -- '-Otouch touched_marker'",
    'git diff HEAD -- --output=looks-like-a-path',
  ]) assert.equal(evaluate(command).allow, false, command);
});

test('refuses shell features that rewrite or add words', () => {
  for (const command of [
    'ls *',
    'ls src/*.ts',
    'cat ?',
    'ls [a]',
    'ls {a,b}',
    'ls ~',
    'ls =ls',
    'cat \\/etc/passwd',
    'git log "$HOME"',
    'git log "`id`"',
    'git log !!',
    'git status # comment',
    'git status\rrm -rf .',
    "git log 'unterminated",
    'git log "unterminated',
    'ls (x)',
  ]) assert.equal(evaluate(command).allow, false, JSON.stringify(command));
});

test('refuses programs called by path, so a repository file cannot impersonate git', () => {
  for (const command of ['./git status', '/usr/bin/git status', 'scripts/git status', '.\\git status', 'file -C -m x']) {
    assert.equal(evaluate(command).allow, false, command);
  }
});

test('git branch creates nothing: non-flag arguments need an explicit listing flag', () => {
  assert.equal(evaluate('git branch -r evil').allow, false);
  assert.equal(evaluate('git branch -a -m x y').allow, false);
  assert.equal(evaluate("git branch --list 'x'").allow, true);
});

// End to end: run the reproductions from PR #79 through a real shell in a
// disposable repository. Whatever the old guard let through wrote a file;
// every command the new guard allows must leave the repository unchanged.
test('allowed commands leave a disposable repository byte-for-byte unchanged; refused ones would have written', { skip: process.platform === 'win32' }, () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-guard-'));
  const run = (cmd) => spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', PAGER: 'cat' } });
  try {
    run('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
    fs.writeFileSync(path.join(dir, 'fixture.sh'), 'echo invoked > pager-marker.txt\n');
    run('git add fixture.sh && git -c user.email=t@t -c user.name=t commit -q -m fixture && echo change >> fixture.sh');
    const snapshot = () => fs.readdirSync(dir).sort().join(',');
    const before = snapshot();

    const bypasses = ['git diff --output"=proof.txt"', 'git grep --open-files-in-pager=sh invoked', 'git diff --src-prefix --end-of-options --output=eoo.txt'];
    for (const cmd of bypasses) assert.equal(evaluate(cmd).allow, false, cmd);
    // Prove the refused spellings are real write/execute paths, not theory.
    run(bypasses[0]);
    assert.ok(fs.existsSync(path.join(dir, 'proof.txt')), 'quoted --output writes a file when executed');
    run(bypasses[1]);
    assert.ok(fs.existsSync(path.join(dir, 'pager-marker.txt')), '--open-files-in-pager executes a program');
    run(bypasses[2]);
    assert.ok(fs.existsSync(path.join(dir, 'eoo.txt')), '--end-of-options as an option value still lets --output write');
    fs.rmSync(path.join(dir, 'eoo.txt'));
    fs.rmSync(path.join(dir, 'proof.txt'));
    fs.rmSync(path.join(dir, 'pager-marker.txt'));
    assert.equal(snapshot(), before);

    for (const cmd of ['git diff', 'git diff --stat', 'git status', 'git log --oneline', 'git grep invoked', "git branch --list 'm*'", 'ls -la', 'cat fixture.sh', "find . -name '*.sh'", 'git show HEAD:fixture.sh', 'git log --output-indicator-new=+ -p -1']) {
      assert.deepEqual(evaluate(cmd), { allow: true }, cmd);
      run(cmd);
      assert.equal(snapshot(), before, `${cmd} changed the repository`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
