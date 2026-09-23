const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, agents } = require('../../docs/agent-team-bootstrap/install.cjs');
const root = path.resolve(__dirname, '../..');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-bootstrap-test-'));
  fs.cpSync(path.join(root, 'docs/agent-team-bootstrap'), path.join(dir, 'docs/agent-team-bootstrap'), { recursive: true });
  // Keep fixtures as evidence; never recursively delete an inferred Windows path.
  return dir;
}

test('installs ten agents and a PR template; repeat install is a no-op', () => {
  const dir = fixture();
  assert.equal(install(dir), 11);
  assert.equal(install(dir), 0);
  for (const name of agents) assert.deepEqual(
    fs.readFileSync(path.join(dir, `.claude/agents/${name}.md`)),
    fs.readFileSync(path.join(dir, `docs/agent-team-bootstrap/agents/${name}.md`)));
  assert.ok(fs.existsSync(path.join(dir, 'docs/agent-team-bootstrap/install.sh')));
});

test('late destination conflict stops before ANY agent is created', () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, '.github'));
  const file = path.join(dir, '.github/pull_request_template.md');
  fs.writeFileSync(file, 'existing local template');
  assert.throws(() => install(dir), /Conflict/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing local template');
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('retains local settings, shared docs, Git index and unrelated files byte-for-byte', () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.mkdirSync(path.join(dir, '.git'));
  const paths = ['AGENTS.md', 'CLAUDE.md', 'PROJECT_STATUS.md', '.claude/settings.json', '.git/HEAD', '.git/index', 'untracked-note.txt'];
  const bytes = Buffer.from([0, 13, 10, 255, 42]);
  for (const file of paths) fs.writeFileSync(path.join(dir, file), bytes);
  install(dir);
  for (const file of paths) assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
});

test('missing payload fails before modifying destinations', () => {
  const dir = fixture();
  fs.renameSync(path.join(dir, 'docs/agent-team-bootstrap/pull_request_template.md'), path.join(dir, 'saved-template.md'));
  assert.throws(() => install(dir), /ENOENT/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('rejects a linked destination directory without writing outside the checkout', () => {
  const dir = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-bootstrap-outside-'));
  fs.symlinkSync(outside, path.join(dir, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => install(dir), /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('specialist payload preserves manager ownership and current product policy', () => {
  for (const name of agents) {
    const text = fs.readFileSync(path.join(root, `docs/agent-team-bootstrap/agents/${name}.md`), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(text, /\nmodel: (haiku|sonnet|opus)\n/);
    assert.match(text, /cloud manager alone owns status, commit, push and PR lifecycle/);
  }
  const frontend = fs.readFileSync(path.join(root, 'docs/agent-team-bootstrap/agents/frontend-ux.md'), 'utf8');
  assert.match(frontend, /public Siton Mall/);
  assert.doesNotMatch(frontend, /there is no marketplace and no search/);
  const status = fs.readFileSync(path.join(root, 'docs/agent-team-bootstrap/agents/status-keeper.md'), 'utf8');
  assert.match(status, /Do not edit files/);
});
