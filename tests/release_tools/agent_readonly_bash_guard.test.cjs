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

// The cloud Claude reviewer runs in its own job (cloud-agent-review.yml) on a
// fresh runner. The guard it loads is the canonical-master copy taken into
// $RUNNER_TEMP/control before the task patch is downloaded or applied, so
// neither a builder (different runner) nor the patch can replace it.
test('cloud Claude reviewers run under the canonical-master guard, copied before the patch, with no other settings source', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/cloud-agent-review.yml'), 'utf8');
  const manager = fs.readFileSync(path.join(root, '.github/workflows/cloud-agent-manager.yml'), 'utf8');
  const steps = workflow.split(/\n      - name: /);
  const index = (name) => steps.findIndex((step) => step.startsWith(`${name}\n`));
  const copy = index('Copy control scripts before the patch');
  const claude = index('Claude review');
  assert.ok(copy > index('Checkout canonical master at the task base') && copy > index('Node 22'));
  assert.ok(copy < index('Download task patch') && copy < index('Apply task patch and enforce control-plane boundary'), 'guard must be copied before the patch reaches the runner');
  assert.ok(copy < claude && copy < index('Codex review'));
  assert.match(steps[copy], /cp [^\n]*scripts\/agent_readonly_bash_guard\.cjs[^\n]* "\$CONTROL\/"/);
  assert.match(steps[copy], /rm -rf "\$CONTROL"/);
  // Fail-open self-tests: the guard itself, and the exact hook command the
  // settings file registers, must both refuse a writing git command.
  assert.match(steps[copy], /echo '\{"tool_input":\{"command":"git diff --output=x"\}\}' \| node "\$CONTROL\/agent_readonly_bash_guard\.cjs" && \{ echo "read-only guard failed open" >&2; exit 1; \} \|\| test "\$\?" = 2/);
  assert.match(steps[copy], /\| bash -c "\$hook_command" && \{ echo "read-only guard settings failed open" >&2; exit 1; \} \|\| test "\$\?" = 2/);
  // The copies are pinned by digest in a step output and re-checked after the
  // reviewer ran, before its output is extracted.
  assert.match(steps[copy], /echo "manifest_sha256=\$\(sha256sum "\$CONTROL\/SHA256SUMS" \| cut -d' ' -f1\)" >> "\$GITHUB_OUTPUT"/);
  const verify = index('Verify control copies are unchanged');
  assert.ok(verify > claude && verify < index('Extract Claude review'));
  assert.match(steps[verify], /sha256sum -c --quiet -/);
  // The Claude review loads only that settings file.
  assert.match(steps[claude], /\n        if: inputs\.reviewer == 'claude'\n/);
  assert.match(steps[claude], /--settings \$\{\{ runner\.temp \}\}\/control\/settings\.json/);
  // Without this, a patch-written .claude/settings*.json or
  // ~/.claude/settings.json with disableAllHooks switches the guard off
  // (proven with Claude Code 2.1.284).
  assert.match(steps[claude], /\n\s+--setting-sources=\n\s+--settings /);
  assert.match(steps[claude], /--disallowedTools Write Edit MultiEdit NotebookEdit/);
  // No Claude reviewer is left in the manager job chain, where builders run.
  assert.doesNotMatch(manager, /--setting-sources=|--disallowedTools Write Edit|siton-review-guard/);
});

// Run the review job's real control-copy step against this checkout and prove
// the settings it writes make Claude Code call the master guard, which blocks.
test('the review job control-copy step writes settings whose hook blocks writes and allows reads', { skip: process.platform === 'win32' }, () => {
  const os = require('node:os');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/cloud-agent-review.yml'), 'utf8');
  const step = workflow.split(/\n      - name: /).find((text) => text.startsWith('Copy control scripts before the patch\n'));
  const script = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length).split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-control-'));
  const output = path.join(temp, 'github-output');
  try {
    const run = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output } });
    assert.equal(run.status, 0, run.stderr);
    const control = path.join(temp, 'control');
    const settings = JSON.parse(fs.readFileSync(path.join(control, 'settings.json'), 'utf8'));
    const hook = settings.hooks.PreToolUse[0];
    assert.equal(hook.matcher, 'Bash');
    assert.equal(hook.hooks[0].command, `"${process.execPath}" "${path.join(control, 'agent_readonly_bash_guard.cjs')}"`);
    const call = (command) => spawnSync('bash', ['-c', hook.hooks[0].command], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
    assert.equal(call('git diff --output=x').status, 2);
    assert.equal(call('git push').status, 2);
    assert.equal(call('git diff HEAD').status, 0);
    assert.equal(fs.readFileSync(path.join(control, 'agent_readonly_bash_guard.cjs'), 'utf8'), fs.readFileSync(guard, 'utf8'));
    assert.match(fs.readFileSync(output, 'utf8'), /^manifest_sha256=[0-9a-f]{64}$/m);
    const sums = spawnSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: control, encoding: 'utf8' });
    assert.equal(sums.status, 0, sums.stderr);
  } finally {
    spawnSync('chmod', ['-R', 'u+w', temp]);
    fs.rmSync(temp, { recursive: true, force: true });
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
