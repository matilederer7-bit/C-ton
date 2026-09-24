#!/usr/bin/env node
'use strict';

// PreToolUse hook for read-only Claude specialists (repo-scout, security-auditor).
//
// A subagent's `tools`/`disallowedTools` frontmatter cannot restrict Bash to
// specific commands: listing Bash grants arbitrary shell execution, and a
// specifier on disallowedTools removes the whole tool. This guard is the
// command-level boundary. It mirrors the managed cloud reviewer, which is
// limited to `git diff/status/log/show`, and adds the read-only Git queries a
// scout needs for the collision check required by AGENTS.md.
//
// Contract (Claude Code hooks): the hook payload arrives as JSON on stdin with
// `tool_input.command`. Exit 0 allows the call. Exit 2 blocks it and the
// stderr text is returned to the agent.
//
// Fail closed: anything not positively recognised as a single read-only
// command is refused, including unparseable input.

const ALLOWED_GIT = new Set([
  'diff', 'status', 'log', 'show',
  'ls-files', 'ls-remote', 'ls-tree', 'rev-parse', 'merge-base',
  'rev-list', 'blame', 'grep', 'cat-file', 'for-each-ref', 'shortlog',
]);

// `git branch` and `git fetch` are read-only only in specific forms.
const GIT_BRANCH_READONLY_FLAGS = new Set(['-r', '-a', '--list', '-l', '-v', '-vv', '--remotes', '--all', '--contains', '--merged', '--no-merged', '--show-current']);

const ALLOWED_PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'stat', 'file', 'du']);

// Any of these makes the line more than one simple command, or redirects
// output to a file, or substitutes another command's output.
const SHELL_META = /[;&|<>`\n\r]|\$\(|\$\{/;

// Git flags that can write even under an otherwise read-only subcommand.
const GIT_WRITE_FLAGS = /(^|\s)(--output(=|\s)|-o\s|--ext-diff|--textconv|--exec(=|\s)|-c\s|--config-env)/;

function tokenize(command) {
  // Deliberately simple: quoting is allowed but not interpreted beyond
  // splitting, because metacharacters are already refused above.
  return command.trim().split(/\s+/).filter(Boolean);
}

function evaluate(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allow: false, reason: 'empty or missing command' };
  }
  if (SHELL_META.test(command)) {
    return { allow: false, reason: 'only a single command is allowed: no pipes, chaining, redirection or substitution' };
  }

  const argv = tokenize(command);
  let [program, ...rest] = argv;

  // Tolerate `env`-free leading paths like /usr/bin/git.
  program = program.replace(/^.*[\\/]/, '');

  if (program === 'git') {
    // Refuse global options before the subcommand (-C, -c, --git-dir, ...):
    // they can point Git at another repository or inject configuration.
    const sub = rest[0];
    if (!sub || sub.startsWith('-')) {
      return { allow: false, reason: 'git global options are not allowed; call a read-only subcommand directly' };
    }
    if (GIT_WRITE_FLAGS.test(' ' + rest.join(' '))) {
      return { allow: false, reason: 'git option that can write files or run external programs' };
    }
    if (ALLOWED_GIT.has(sub)) return { allow: true };
    if (sub === 'branch') {
      const flags = rest.slice(1);
      const ok = flags.length === 0 || flags.every(f => GIT_BRANCH_READONLY_FLAGS.has(f) || (!f.startsWith('-') && flags.some(g => g === '--list' || g === '-l' || g === '--contains' || g === '--merged' || g === '--no-merged')));
      return ok ? { allow: true } : { allow: false, reason: 'git branch is allowed only in listing form' };
    }
    if (sub === 'fetch') {
      // Updates remote-tracking refs only; never the worktree or local branches
      // unless a refspec is given. Refuse any refspec or pruning.
      const extra = rest.slice(1).filter(a => a !== 'origin' && a !== '--quiet' && a !== '-q');
      return extra.length === 0 ? { allow: true } : { allow: false, reason: 'git fetch is allowed only as `git fetch [origin]`' };
    }
    return { allow: false, reason: `git ${sub} is not a read-only command` };
  }

  if (program === 'find') {
    if (rest.some(a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) {
      return { allow: false, reason: 'find actions that execute or write are not allowed' };
    }
    return { allow: true };
  }

  if (program === 'rg' && rest.some(a => a === '--pre' || a.startsWith('--pre='))) {
    return { allow: false, reason: 'rg --pre runs an external program' };
  }

  if (ALLOWED_PLAIN.has(program)) return { allow: true };

  return { allow: false, reason: `\`${program}\` is not on the read-only allowlist` };
}

function readStdin() {
  try {
    return require('node:fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (require.main === module) {
  let command;
  try {
    command = JSON.parse(readStdin())?.tool_input?.command;
  } catch {
    command = undefined;
  }
  const verdict = evaluate(command);
  if (!verdict.allow) {
    process.stderr.write(`Blocked by read-only guard: ${verdict.reason}. This specialist is read-only; use Read/Grep/Glob, or report what needs running to the supervisor.\n`);
    process.exit(2);
  }
  process.exit(0);
}

module.exports = { evaluate };
