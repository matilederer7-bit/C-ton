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
// How it decides. The command is first split into words exactly as a POSIX
// shell (bash or zsh) would after quote removal, and every shell feature that
// could change those words or run something else is refused: operators,
// redirection, substitution, expansion, globbing, escapes and comments. Only
// then are the resulting argv words checked against a per-program allowlist.
// Checking the parsed words, not the raw string, is what closes bypasses such
// as `git diff --output"=x"` (quote removal glues the option back together).
//
// Fail closed: anything not positively recognised as a single read-only
// command is refused, including unparseable input.

const ALLOWED_GIT = new Set([
  'diff', 'status', 'log', 'show',
  'ls-files', 'ls-remote', 'ls-tree', 'rev-parse', 'merge-base',
  'rev-list', 'blame', 'grep', 'cat-file', 'for-each-ref', 'shortlog',
]);

// `git branch` is read-only only in listing form.
const GIT_BRANCH_READONLY_FLAGS = new Set(['-r', '-a', '--list', '-l', '-v', '-vv', '--remotes', '--all', '--contains', '--merged', '--no-merged', '--show-current']);
const GIT_BRANCH_LISTING_FLAGS = new Set(['--list', '-l', '--contains', '--merged', '--no-merged']);

// Long Git options that write files, run another program, or retarget the
// repository or configuration. Git's option parser accepts any unambiguous
// prefix of a long option (`--outp` for `--output`), so an argument is refused
// when it is a prefix of one of these as well as when it equals one.
const GIT_DANGEROUS_LONG = [
  '--output', '--ext-diff', '--textconv', '--exec', '--exec-path',
  '--upload-pack', '--receive-pack', '--open-files-in-pager', '--filters',
  '--config', '--config-env', '--git-dir', '--work-tree', '--namespace',
  '--paginate', '--pager',
];
// Short options of the same kind, per subcommand. `git grep -O<cmd>` opens the
// matches with an arbitrary program.
const GIT_DANGEROUS_SHORT = { grep: /O/ };

const ALLOWED_PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'stat', 'du']);

const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const RG_EXECUTING = /^--(pre|hostname-bin)(=|$)/;

// Characters that change meaning outside quotes: operators, redirection,
// subshells, substitution, globbing, brace/history expansion, escapes,
// comments.
const UNQUOTED_FORBIDDEN = new Set([';', '&', '|', '<', '>', '(', ')', '$', '`', '\\', '*', '?', '[', ']', '{', '}', '!', '#']);
// Inside double quotes the shell still expands these.
const DOUBLE_QUOTED_FORBIDDEN = new Set(['$', '`', '\\', '!']);
// Expansions that happen only at the start of an unquoted word
// (tilde expansion; zsh `=cmd` expansion).
const WORD_START_FORBIDDEN = new Set(['~', '=']);

// Split a command into argv words the way the shell will. Returns
// { words } or { error }.
function shellWords(command) {
  const words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== ' ' && ch !== '\t') || code === 0x7f) {
      return { error: 'control characters (including newlines) are not allowed' };
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (DOUBLE_QUOTED_FORBIDDEN.has(ch)) return { error: `\`${ch}\` is expanded inside double quotes; use single quotes` };
      else word += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    if (!inWord && WORD_START_FORBIDDEN.has(ch)) return { error: `a word may not start with an unquoted \`${ch}\`` };
    if (UNQUOTED_FORBIDDEN.has(ch)) {
      return { error: `unquoted \`${ch}\` is not allowed: only a single command, without pipes, chaining, redirection, substitution, globbing or escapes` };
    }
    inWord = true;
    if (ch === "'" || ch === '"') quote = ch;
    else word += ch;
  }
  if (quote) return { error: 'unterminated quote' };
  if (inWord) words.push(word);
  return { words };
}

function isDangerousGitLong(arg) {
  if (!arg.startsWith('--') || arg === '--') return false;
  const name = arg.split('=')[0];
  if (name.length < 3) return false;
  return GIT_DANGEROUS_LONG.some((option) => option.startsWith(name));
}

function evaluateGit(rest) {
  // Refuse global options before the subcommand (-C, -c, --git-dir, -p, ...):
  // they can point Git at another repository, inject configuration or start a
  // pager.
  const sub = rest[0];
  if (!sub || sub.startsWith('-')) {
    return { allow: false, reason: 'git global options are not allowed; call a read-only subcommand directly' };
  }
  const args = rest.slice(1);
  const end = args.findIndex((arg) => arg === '--' || arg === '--end-of-options');
  const options = end === -1 ? args : args.slice(0, end);
  const shortPattern = GIT_DANGEROUS_SHORT[sub];
  for (const arg of options) {
    if (isDangerousGitLong(arg)) return { allow: false, reason: `git option ${arg.split('=')[0]} can write files, run external programs or retarget the repository` };
    if (shortPattern && /^-[^-]/.test(arg) && shortPattern.test(arg.slice(1))) {
      return { allow: false, reason: `git ${sub} ${arg} can run an external program` };
    }
  }
  if (ALLOWED_GIT.has(sub)) return { allow: true };
  if (sub === 'branch') {
    const listing = args.some((arg) => GIT_BRANCH_LISTING_FLAGS.has(arg));
    const ok = args.every((arg) => (arg.startsWith('-') ? GIT_BRANCH_READONLY_FLAGS.has(arg) : listing));
    return ok ? { allow: true } : { allow: false, reason: 'git branch is allowed only in listing form' };
  }
  if (sub === 'fetch') {
    // Updates remote-tracking refs only; never the worktree or local branches
    // unless a refspec is given. Refuse any refspec or pruning.
    const extra = args.filter((arg) => arg !== 'origin' && arg !== '--quiet' && arg !== '-q');
    return extra.length === 0 ? { allow: true } : { allow: false, reason: 'git fetch is allowed only as `git fetch [origin]`' };
  }
  return { allow: false, reason: `git ${sub} is not a read-only command` };
}

function evaluate(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allow: false, reason: 'empty or missing command' };
  }
  const parsed = shellWords(command);
  if (parsed.error) return { allow: false, reason: parsed.error };
  const [program, ...rest] = parsed.words;
  if (!program) return { allow: false, reason: 'empty or missing command' };

  // Programs are called by name only, so a repository file such as `./git`
  // can never stand in for the real tool.
  if (/[\\/]/.test(program)) {
    return { allow: false, reason: 'call programs by name, not by path' };
  }

  if (program === 'git') return evaluateGit(rest);

  if (program === 'find' && rest.some((arg) => FIND_ACTIONS.test(arg))) {
    return { allow: false, reason: 'find actions that execute or write are not allowed' };
  }

  if (program === 'rg' && rest.some((arg) => RG_EXECUTING.test(arg))) {
    return { allow: false, reason: 'rg --pre / --hostname-bin run an external program' };
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

module.exports = { evaluate, shellWords };
