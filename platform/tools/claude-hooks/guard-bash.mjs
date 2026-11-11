#!/usr/bin/env node
// Claude Code hook (task W01 PR 2, ADR-M84 §2.3): refuses the Bash commands that CLAUDE.md
// forbids for Claude. `.claude/settings.json` runs it before every Bash tool call (`PreToolUse`).
//
// Input: the hook's JSON on stdin ({ tool_name, tool_input: { command } }).
// Output: exit 0 lets the command run; exit 2 refuses it and the reason on stderr goes to Claude.
// Input it cannot read is let through: the hook is a backstop, not a security boundary; the rules
// and the review stay. It never changes or runs a command and never reads a secret.
//
// Each refusal names its rule in design/RULES.md. Developer tooling, not a user-facing message,
// so the text is English without the message catalog.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REASONS = {
  R035: 'this command prints or takes a secret or token; only the owner runs it, in their own terminal',
  R039: 'this command deletes Docker volumes, which can wipe a dev stack',
  R078b: '`down -v` deletes the volumes; only the owner wipes a dev machine',
  R040: 'tags, releases, `push: true` runs and publishes are public actions done by the owner',
  R125: 'never rewrite history: no force-push and no rebase; merge `origin/main` instead',
  R028b: 'never push to the default branch; push a `task/…` branch and open a pull request',
  R074e: 'never run `weed shell s3.config.show`: it prints the S3 keys',
  R149: "`runner-host-setup.sh` changes the machine's system settings as root; only the owner runs it, in their own terminal",
};

// Words that may come before the real command in a segment.
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env']);
const DEFAULT_BRANCHES = new Set(['main', 'master']);

/** Removes heredoc bodies (text, not commands), keeping the line that opens them. */
function stripHeredocs(command) {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g,
    '$3',
  );
}

/** True when `weed` gets `s3.config.show`: on its own line of commands, or in a heredoc it reads. */
function showsS3Keys(command) {
  const SHOW = 's3.config.show';
  const WEED = /\bweed\b/;
  const outside = stripHeredocs(command);
  if (WEED.test(outside) && outside.includes(SHOW)) return true;
  const re =
    /^([^\n]*)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/gm;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    if (WEED.test(m[1]) && m[4].includes(SHOW)) return true;
  }
  return false;
}

/** Commands passed to a shell with `-c "…"`, checked like the outer command. */
function innerShellCommands(command) {
  const inner = [];
  const re = /\b(?:bash|sh|zsh)\s+(?:-[a-z]*c[a-z]*)\s+(['"])([\s\S]*?)\1/g;
  for (let m = re.exec(command); m; m = re.exec(command)) inner.push(m[2]);
  return inner;
}

/** Replaces quoted text by a placeholder, so words inside a message are not read as commands. */
function stripQuotes(command) {
  return command.replace(/'[^']*'/g, "'_'").replace(/"(?:[^"\\]|\\.)*"/g, '"_"');
}

function segments(command) {
  return command
    .split(/\n|;|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(segment) {
  const all = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < all.length && (PREFIXES.has(all[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[i]))) i++;
  return all.slice(i).map((w) => w.replace(/^['"]|['"]$/g, ''));
}

const base = (word) => word.split('/').pop();
const hasShortFlag = (args, letter) =>
  args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));

function checkDocker(cmd, args) {
  if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'prune') return 'R039';
  if (cmd === 'docker' && args[0] === 'system' && args[1] === 'prune' && args.includes('--volumes'))
    return 'R039';
  const compose =
    cmd === 'docker-compose'
      ? args
      : cmd === 'docker' && args[0] === 'compose'
        ? args.slice(1)
        : null;
  if (
    compose &&
    compose.includes('down') &&
    (compose.includes('--volumes') || hasShortFlag(compose, 'v'))
  )
    return 'R078b';
  return null;
}

function gitSubcommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-'))
    i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  return { sub: args[i], rest: args.slice(i + 1) };
}

function checkGit(args) {
  const { sub, rest } = gitSubcommand(args);
  if (sub === 'tag') {
    const listing = rest.some((a) =>
      /^(-l|--list|--contains|--no-contains|--points-at|--merged|--no-merged|--sort)(=|$)/.test(a),
    );
    const writes = rest.some((a) =>
      /^(-[dafsmFe]+|--delete|--annotate|--sign|--force|--message.*|--file.*)$/.test(a),
    );
    const names = rest.some((a) => !a.startsWith('-'));
    if (writes || (names && !listing)) return 'R040';
    return null;
  }
  if (sub === 'push') {
    if (rest.some((a) => a === '--tags' || a === '--follow-tags' || a.includes('refs/tags/')))
      return 'R040';
    if (
      rest.some(
        (a) => a.startsWith('--force') || a === '--mirror' || a === '--delete' || a.startsWith('+'),
      ) ||
      hasShortFlag(rest, 'f') ||
      hasShortFlag(rest, 'd')
    )
      return 'R125';
    const refspecs = rest.filter((a) => !a.startsWith('-')).slice(1);
    for (const spec of refspecs) {
      const dest = spec.includes(':') ? spec.split(':').pop() : spec;
      if (DEFAULT_BRANCHES.has(dest.replace(/^refs\/heads\//, ''))) return 'R028b';
    }
    return null;
  }
  if (sub === 'rebase' && !rest.includes('--abort')) return 'R125';
  return null;
}

function firstPositional(args) {
  return args.find((a) => !a.startsWith('-'));
}

/** The CLI's command names: `adlc`, and `sdlc` (the old name, ADR-M100 §2.5). */
const CLI_NAMES = new Set(['adlc', 'sdlc']);

/** `ops bootstrap …` and `ops token …` print a token once (rule R035). */
function printsOperatorSecret(cliArgs) {
  const [ops, action] = cliArgs.filter((a) => !a.startsWith('-'));
  return ops === 'ops' && (action === 'bootstrap' || action === 'token');
}

function checkPackageManager(cmd, args) {
  const first = firstPositional(args);
  if (first === 'publish') return 'R040';
  if (cmd === 'npm' && first === 'token') return 'R040';
  if (cmd !== 'pnpm') return null;
  // `pnpm run <script> …` and `pnpm <script> …` are the same.
  const rest =
    first === 'run' ? args.slice(args.indexOf('run') + 1) : args.slice(args.indexOf(first) + 1);
  const script = first === 'run' ? firstPositional(rest) : first;
  const scriptArgs = first === 'run' ? rest.slice(rest.indexOf(script) + 1) : rest;
  if (script === 'openbao:bootstrap') {
    const action = firstPositional(scriptArgs) ?? '';
    if (['init', 'unseal', 'root-token'].includes(action) || action.endsWith('-credentials'))
      return 'R035';
  }
  // `pnpm adlc …`; `pnpm sdlc …`, its alias in v0.9.x, stays refused for older checkouts (ADR-M100 §2.5).
  if (CLI_NAMES.has(script) && printsOperatorSecret(scriptArgs)) return 'R035';
  if (script === 'github-app:create') return 'R035';
  // `pnpm server:setup` shows key shares and asks for tokens (D-08 V16, QUESTIONS #616).
  if (script === 'server:setup') return 'R035';
  if (/^test:.*-live$/.test(script ?? '')) return 'R035';
  if (
    script === 'compose:down' &&
    (scriptArgs.includes('--volumes') || hasShortFlag(scriptArgs, 'v'))
  )
    return 'R078b';
  return null;
}

function checkGh(args) {
  if (args[0] === 'release' && ['create', 'edit', 'delete', 'upload'].includes(args[1]))
    return 'R040';
  if (args[0] === 'workflow' && args[1] === 'run' && args.some((a) => /push=true/.test(a)))
    return 'R040';
  return null;
}

function checkSegment(segment) {
  const [first, ...args] = words(segment);
  if (!first) return null;
  const cmd = base(first);
  if (cmd === 'docker' || cmd === 'docker-compose') return checkDocker(cmd, args);
  if (cmd === 'git') return checkGit(args);
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') return checkPackageManager(cmd, args);
  if (cmd === 'gh') return checkGh(args);
  if (CLI_NAMES.has(cmd) && printsOperatorSecret(args)) return 'R035';
  if (cmd === 'node' && args.some((a) => /server-setup\/(?:dist|src)\/main\.[jt]s$/.test(a)))
    return 'R035';
  // The runner host set-up (V18, ADR-M107): root changes to the machine, the owner's only.
  if (cmd === 'runner-host-setup.sh') return 'R149';
  if (
    ['sh', 'bash', 'dash'].includes(cmd) &&
    base(firstPositional(args) ?? '') === 'runner-host-setup.sh'
  )
    return 'R149';
  if (cmd === 'bootstrap.sh') {
    const action = firstPositional(args) ?? '';
    if (['init', 'unseal', 'root-token'].includes(action) || action.endsWith('-credentials'))
      return 'R035';
  }
  return null;
}

/**
 * Decides whether a Bash command may run.
 * @param {string} command
 * @returns {{ blocked: false } | { blocked: true, rule: string, reason: string }}
 */
export function checkCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return { blocked: false };
  // The keys of `s3.config.show` must never be printed, however `weed` gets the text. Text in a
  // heredoc for another program (a script, a commit message) only mentions it.
  if (showsS3Keys(command)) {
    return { blocked: true, rule: 'R074e', reason: REASONS.R074e };
  }
  const text = stripHeredocs(command);
  for (const inner of innerShellCommands(text)) {
    const result = checkCommand(inner);
    if (result.blocked) return result;
  }
  for (const segment of segments(stripQuotes(text))) {
    const rule = checkSegment(segment);
    if (rule) return { blocked: true, rule, reason: REASONS[rule] };
  }
  return { blocked: false };
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  if (input?.tool_name !== 'Bash') process.exit(0);
  const result = checkCommand(input?.tool_input?.command);
  if (!result.blocked) process.exit(0);
  process.stderr.write(
    `Refused by the repository hook (rule ${result.rule}, design/RULES.md): ${result.reason}. ` +
      'Ask the repository owner to run it if it is really needed.\n',
  );
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
