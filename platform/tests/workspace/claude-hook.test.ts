// D-08 W01 AC2 (ADR-M84 §2.3, design/RULES.md): the Claude Code hook refuses the Bash commands
// that CLAUDE.md forbids for Claude, and lets every other command through.
// - checkCommand on a table of refused and allowed commands, each refusal with its rule ID;
// - the script itself, run with the hook's JSON on stdin: exit 2 and a reason, or exit 0;
// - .claude/settings.json runs the script before every Bash tool call.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();
const SCRIPT = path.join(root, 'platform/tools/claude-hooks/guard-bash.mjs');

interface Result {
  blocked: boolean;
  rule?: string;
  reason?: string;
}
// The script is an ES module; the tests are compiled as CommonJS, so it is loaded before the tests.
let checkCommand: (command: unknown) => Result;
beforeAll(async () => {
  ({ checkCommand } = (await import(SCRIPT)) as { checkCommand: (command: unknown) => Result });
});

const REFUSED: [string, string][] = [
  // R039, R078b: volumes of a dev stack
  ['docker volume prune', 'R039'],
  ['docker volume prune -f', 'R039'],
  ['docker system prune -a --volumes', 'R039'],
  ['docker compose -f platform/deploy/docker-compose.yml down -v', 'R078b'],
  ['docker compose down --volumes', 'R078b'],
  ['docker-compose down -v', 'R078b'],
  ['pnpm compose:down -v', 'R078b'],
  // R040: tags, releases, publishes
  ['git tag v0.5.0', 'R040'],
  ['git tag -a v0.5.0 -m release', 'R040'],
  ['git tag -d v0.4.0', 'R040'],
  ['git push --tags', 'R040'],
  ['git push origin --follow-tags', 'R040'],
  ['git push origin refs/tags/v0.5.0', 'R040'],
  ['gh release create v0.5.0', 'R040'],
  ['gh release delete v0.4.0 --yes', 'R040'],
  ['gh workflow run release-images.yml -f push=true', 'R040'],
  ['npm publish', 'R040'],
  ['pnpm publish --access public', 'R040'],
  ['pnpm -r publish', 'R040'],
  ['yarn publish', 'R040'],
  ['npm token create', 'R040'],
  // R125, R028b: history and the default branch
  ['git push --force origin task/x', 'R125'],
  ['git push -f origin task/x', 'R125'],
  ['git push -uf origin task/x', 'R125'],
  ['git push --force-with-lease origin task/x', 'R125'],
  ['git push origin +task/x', 'R125'],
  ['git push origin --delete task/x', 'R125'],
  ['git rebase origin/main', 'R125'],
  ['git rebase -i HEAD~3', 'R125'],
  ['git -C /tmp/repo rebase main', 'R125'],
  ['git push origin main', 'R028b'],
  ['git push origin HEAD:main', 'R028b'],
  ['git push origin task/x:refs/heads/main', 'R028b'],
  // R035: commands that print or take a secret
  ['pnpm openbao:bootstrap init', 'R035'],
  ['pnpm openbao:bootstrap unseal', 'R035'],
  ['pnpm openbao:bootstrap root-token', 'R035'],
  ['pnpm openbao:bootstrap worker-credentials', 'R035'],
  // O05: one admin token for every AppRole secret ID.
  ['pnpm openbao:bootstrap rotate-credentials', 'R035'],
  ['pnpm run openbao:bootstrap init', 'R035'],
  ['platform/deploy/openbao/bootstrap.sh init', 'R035'],
  ['pnpm sdlc ops bootstrap --tenant t1', 'R035'],
  ['pnpm sdlc ops token issue', 'R035'],
  // ADR-M100 §2.5: the new name, the bare binaries and `pnpm run` too
  ['pnpm adlc ops bootstrap --tenant t1', 'R035'],
  ['pnpm adlc ops token issue', 'R035'],
  ['pnpm run adlc ops token issue', 'R035'],
  ['adlc ops bootstrap --tenant t1', 'R035'],
  ['adlc ops token issue --tenant t1', 'R035'],
  ['sdlc ops token issue', 'R035'],
  ['/usr/local/bin/adlc ops bootstrap', 'R035'],
  ['SDLC_DB_URL=x adlc ops token issue', 'R035'],
  ['pnpm github-app:create --out /tmp/app.json', 'R035'],
  ['pnpm server:setup --settings /srv/settings.yaml', 'R035'],
  ['pnpm run server:setup --settings /srv/settings.yaml', 'R035'],
  ['node platform/deploy/server-setup/dist/main.js --settings /srv/s.yaml', 'R035'],
  ['pnpm test:pilot-live', 'R035'],
  ['pnpm test:sandbox-live', 'R035'],
  // R074e
  [
    "echo 's3.config.show' | docker compose exec -T seaweedfs weed shell -master=127.0.0.1:9333",
    'R074e',
  ],
  [
    "docker compose exec -T seaweedfs weed shell -master=127.0.0.1:9333 <<'EOF'\ns3.config.show\nEOF",
    'R074e',
  ],
  // R149: the runner host set-up (V18)
  ['sudo platform/deploy/scripts/runner-host-setup.sh --user sdlc-runner --mode vm', 'R149'],
  ['platform/deploy/scripts/runner-host-setup.sh --user u --mode vm --dry-run', 'R149'],
  ['sudo sh platform/deploy/scripts/runner-host-setup.sh --user u --mode vm', 'R149'],
  ['bash -c "sudo ./runner-host-setup.sh --user u --mode vm"', 'R149'],
  // Found inside a chain, after a prefix, or in `bash -c`
  ['cd platform && pnpm install && git push --force', 'R125'],
  ['FOO=1 sudo docker volume prune', 'R039'],
  ['/usr/bin/git tag v1', 'R040'],
  ['bash -c "npm publish"', 'R040'],
  ["sh -c 'git rebase main'", 'R125'],
];

const ALLOWED = [
  'git status',
  'git tag',
  'git tag -l',
  "git tag --list 'v0.*'",
  'git tag --contains HEAD',
  'git push -u origin task/W01-claude-hook',
  'git push',
  'git push origin HEAD',
  'git rebase --abort',
  'git commit -m "never run git push --force or npm publish"',
  "git commit -F - <<'EOF'\ndocs: mention npm publish\n\ngit rebase is refused\nEOF",
  // A script that only mentions the SeaweedFS command (W01 PR 2 met this case itself).
  "python3 - <<'PY'\nreason = 'never run weed shell s3.config.show'\nPY",
  'docker compose down',
  'docker compose ps',
  'docker system prune',
  'docker volume ls',
  'pnpm install',
  'pnpm test platform/tests/workspace',
  'pnpm openbao:bootstrap status',
  'pnpm openbao:bootstrap configure',
  'pnpm sdlc ops audit verify',
  'pnpm adlc ops audit verify',
  'adlc ops audit verify',
  'adlc whoami',
  'adlc intent list',
  'pnpm test:openbao',
  'pnpm compose:down',
  'npm view vitest version',
  'gh release list',
  'gh workflow run ci.yml',
  'grep -rn "npm publish" RELEASING.md',
  'echo done 2>&1',
  'shellcheck platform/deploy/scripts/runner-host-setup.sh',
  'sh platform/deploy/scripts/test-rootless-docker.sh /tmp/rootless',
];

describe('W01: the Claude Code hook refuses forbidden commands', () => {
  it.each(REFUSED)('refuses %s (%s)', (command, rule) => {
    const result = checkCommand(command);
    expect(result).toMatchObject({ blocked: true, rule });
    expect(result.reason).toMatch(/\w/);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(checkCommand(command)).toEqual({ blocked: false });
  });

  it('allows empty or missing input', () => {
    expect(checkCommand('')).toEqual({ blocked: false });
    expect(checkCommand(undefined)).toEqual({ blocked: false });
  });
});

function runHook(input: string) {
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });
}

describe('W01: guard-bash.mjs as a hook', () => {
  it('exits 2 with the rule and a reason for a forbidden command', () => {
    const r = runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' } }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('rule R125');
    expect(r.stderr).toContain('design/RULES.md');
    expect(r.stdout).toBe('');
  });

  it('exits 0 for an allowed command, another tool, or input it cannot read', () => {
    expect(
      runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } })).status,
    ).toBe(0);
    expect(
      runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } })).status,
    ).toBe(0);
    expect(runHook('not json').status).toBe(0);
  });
});

describe('W01: .claude/settings.json runs the hook', () => {
  it('runs guard-bash.mjs before every Bash tool call', () => {
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'),
    ) as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const bash = settings.hooks.PreToolUse.filter((h) => h.matcher === 'Bash');
    expect(bash).toHaveLength(1);
    expect(bash[0]!.hooks).toEqual([
      {
        type: 'command',
        command: 'node "$CLAUDE_PROJECT_DIR/platform/tools/claude-hooks/guard-bash.mjs"',
      },
    ]);
  });
});
