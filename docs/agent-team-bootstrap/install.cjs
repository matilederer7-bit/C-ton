#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const agents = ['backend-core', 'codex-liaison', 'db-migrations', 'devops-release',
  'frontend-ux', 'payments-money', 'repo-scout', 'security-auditor', 'status-keeper', 'test-engineer'];

function safePath(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${relative}`);
    if (current !== path.join(root, relative) && !stat.isDirectory()) {
      throw new Error(`Not a directory: ${relative}`);
    }
  }
  return current;
}

function install(root) {
  const entries = agents.map(name => [`agents/${name}.md`, `.claude/agents/${name}.md`]);
  entries.push(['pull_request_template.md', '.github/pull_request_template.md']);
  // Preflight EVERY file before writing any destination. Existing differing
  // content is a real conflict, including untracked/ignored local files.
  const plan = entries.map(([source, target]) => {
    const payload = fs.readFileSync(safePath(root, `docs/agent-team-bootstrap/${source}`));
    const destination = safePath(root, target);
    if (fs.existsSync(destination)) {
      if (!fs.statSync(destination).isFile() || !fs.readFileSync(destination).equals(payload)) {
        throw new Error(`Conflict: ${target}. No existing files were overwritten. Reconcile manually.`);
      }
      return null;
    }
    return { destination, payload };
  }).filter(Boolean);
  for (const { destination, payload } of plan) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Exclusive creation also protects a file created after preflight.
    fs.writeFileSync(destination, payload, { flag: 'wx' });
  }
  return plan.length;
}

if (require.main === module) {
  try {
    const count = install(path.resolve(__dirname, '../..'));
    console.log(`Bootstrap complete: ${count} new files; existing identical files retained.`);
    console.log('Branch, index, local settings and source package retained. Review, commit and push via AGENTS.md.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { install, agents };
