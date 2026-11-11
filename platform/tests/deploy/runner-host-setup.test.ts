// D-08 V18 (design/ADR-M107): `runner-host-setup.sh` on a simulated host. The script runs for real
// against a copy of its files; every program that would change the machine is a stub that records
// its call and changes a state folder instead. No Docker, no root.
// - First run: every step of the deploy README's runner steps 1, 2 and 5, in order.
// - Second run: nothing changes; each step says it is already done.
// - A conflicting .env value, a file with other settings, an Engine with the platform's data,
//   missing packages: refused before anything changes.
// - --dry-run changes nothing; the AppArmor profile is only for rootlesskit, and the machine-wide
//   switch is never touched.
// - The CI script and the server script use the same step code; the README is in step with it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const SCRIPTS = path.join(root, 'platform/deploy/scripts');
const UID = 1001;
const LINK = '10.203.0.1';
/** The real programs the scripts need besides the stubs. */
const TOOLS = [
  'sh',
  'sed',
  'awk',
  'grep',
  'cat',
  'mkdir',
  'tee',
  'cut',
  'sort',
  'tr',
  'dirname',
  'env',
  'test',
  'sleep',
  'tail',
  'cp',
  'chmod',
  'touch',
];
/** Stubs that change the simulated machine. */
const CHANGES = [
  'usermod',
  'apparmor_parser',
  'systemctl daemon-reload',
  'loginctl',
  'systemctl stop',
  'systemctl start',
  'dockerd-rootless-setuptool.sh',
  'install-rootless.sh',
  'networkctl',
  'tee',
];

interface Host {
  dir: string;
  host: string;
  bin: string;
  repo: string;
  state: string;
  log: string;
  envFile: string;
}

const hosts: string[] = [];
afterEach(() => {
  for (const dir of hosts.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function which(tool: string): string {
  const r = spawnSync('which', [tool], { encoding: 'utf8' });
  const found = r.stdout.trim();
  if (!found) throw new Error(`${tool} not found`);
  return found;
}

/** A stub: records its name and arguments, then runs `body` (sh). */
function stub(h: Host, name: string, body = ''): void {
  write(
    path.join(h.bin, name),
    `#!/bin/sh\necho "${name} $*" >>"${h.log}"\nS="${h.state}"\nR="${h.host}"\n${body}\nexit 0\n`,
    0o755,
  );
}

function makeHost(options: { apparmor?: boolean } = {}): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v18-'));
  hosts.push(dir);
  const h: Host = {
    dir,
    host: path.join(dir, 'root'),
    bin: path.join(dir, 'bin'),
    repo: path.join(dir, 'repo'),
    state: path.join(dir, 'state'),
    log: path.join(dir, 'calls.log'),
    envFile: path.join(dir, 'repo/platform/deploy/runner-host/.env'),
  };
  fs.mkdirSync(h.state, { recursive: true });
  fs.mkdirSync(h.bin, { recursive: true });
  fs.writeFileSync(h.log, '');
  for (const tool of TOOLS) fs.symlinkSync(which(tool), path.join(h.bin, tool));
  // The checkout: the scripts under test, the .env template, a built AuthZ plugin.
  const deploy = path.join(h.repo, 'platform/deploy');
  for (const file of ['runner-host-setup.sh', 'rootless-engine.sh', 'runner-host.sh'])
    fs.copyFileSync(path.join(SCRIPTS, file), path.join(write2(deploy, 'scripts'), file));
  fs.copyFileSync(
    path.join(root, 'platform/deploy/runner-host/.env.example'),
    path.join(write2(deploy, 'runner-host'), '.env.example'),
  );
  write(path.join(deploy, 'docker-authz/dist/main.js'), '// built\n');
  write(
    path.join(deploy, 'docker-authz/scripts/install-rootless.sh'),
    `echo "install-rootless.sh $*" >>"${h.log}"\ntouch "${h.state}/authz"\n`,
  );
  // The machine: dbus-user-session installed; AppArmor restricts user namespaces.
  write(path.join(h.host, 'usr/lib/systemd/user/dbus.socket'), '');
  if (options.apparmor !== false)
    write(path.join(h.host, 'proc/sys/kernel/apparmor_restrict_unprivileged_userns'), '1\n');

  stub(h, 'id', '[ "$1" = -u ] && echo "${FAKE_UID:-0}" || echo root');
  stub(
    h,
    'getent',
    `[ "$2" = sdlc-runner ] && echo "sdlc-runner:x:${UID}:${UID}::${dir}/home:/bin/bash" || exit 2`,
  );
  // sudo -u <user> -H <command> and sudo <command>: run the command as this test's user.
  stub(h, 'sudo', '[ "$1" = -u ] && shift 3\nexec "$@"');
  stub(
    h,
    'usermod',
    'mkdir -p "$R/etc"; echo "$5:200000:65536" >>"$R/etc/subuid"; echo "$5:200000:65536" >>"$R/etc/subgid"',
  );
  stub(h, 'apparmor_parser');
  stub(
    h,
    'systemctl',
    `case "$*" in
  "is-active --quiet systemd-networkd") [ -e "$S/networkd-off" ] && exit 1 ;;
  "start user@${UID}.service")
    mkdir -p "$R/run/user/${UID}" "$R/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service"
    touch "$R/run/user/${UID}/bus"
    echo "cpuset cpu io memory pids" >"$R/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service/cgroup.controllers" ;;
esac`,
  );
  stub(h, 'loginctl', 'mkdir -p "$R/var/lib/systemd/linger"; touch "$R/var/lib/systemd/linger/$2"');
  stub(h, 'dockerd-rootless-setuptool.sh', 'touch "$S/engine"');
  stub(
    h,
    'docker',
    `case "$*" in
  *Plugins.Authorization*) [ -e "$S/authz" ] && echo '["sdlc-authz"]' || echo null ;;
  *SecurityOptions*) echo "[name=seccomp name=rootless name=cgroupns] cgroup=2 driver=systemd version=28.5.1" ;;
  "volume ls"*) [ -e "$S/volumes" ] && cat "$S/volumes" ;;
  info) [ -e "$S/engine" ] || exit 1 ;;
esac`,
  );
  stub(
    h,
    'ip',
    `[ -e "$S/link" ] && echo "7: sdlc-link    inet ${LINK}/32 scope global sdlc-link\\       valid_lft forever"`,
  );
  stub(h, 'networkctl', 'touch "$S/link"');
  for (const name of ['rootlesskit', 'dockerd', 'newuidmap', 'newgidmap', 'node']) stub(h, name);
  return h;
}

function write2(base: string, sub: string): string {
  const d = path.join(base, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(h: Host, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(
    path.join(h.bin, 'sh'),
    [path.join(h.repo, 'platform/deploy/scripts/runner-host-setup.sh'), ...args],
    {
      encoding: 'utf8',
      env: { PATH: h.bin, HOME: path.join(h.dir, 'home'), SDLC_HOST_ROOT: h.host, ...env },
    },
  );
  const calls = fs.readFileSync(h.log, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(h.log, '');
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

const SAME = ['--user', 'sdlc-runner', '--mode', 'same-server', '--link-addr', LINK];
const read = (h: Host, rel: string) => fs.readFileSync(path.join(h.host, rel), 'utf8');
const changes = (calls: string[]) =>
  calls.filter((c) => CHANGES.some((name) => c.startsWith(`${name} `) || c === name));

describe('V18: runner-host-setup.sh on a simulated host', () => {
  it('first run: the Engine, the AuthZ plugin, the link and the .env, in the order of the README', () => {
    const h = makeHost();
    const r = run(h, [...SAME, '--project', 'acme', '--ca-file', '/etc/sdlc/ca.pem']);
    expect(r.out).not.toContain('refused');
    expect(r.status).toBe(0);
    const order = [
      'usermod --add-subuids 200000-265535 --add-subgids 200000-265535 sdlc-runner',
      `apparmor_parser -r ${h.host}/etc/apparmor.d/sdlc-rootlesskit`,
      'systemctl daemon-reload',
      'loginctl enable-linger sdlc-runner',
      `systemctl stop user@${UID}.service`,
      `systemctl start user@${UID}.service`,
      `dockerd-rootless-setuptool.sh install --force`,
      'install-rootless.sh --dist',
      'networkctl reload',
    ];
    const at = order.map((call) => r.calls.findIndex((c) => c.startsWith(call)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    expect(read(h, 'etc/systemd/system/user@.service.d/delegate.conf')).toBe(
      '[Service]\nDelegate=cpu cpuset io memory pids\n',
    );
    expect(read(h, 'etc/docker/plugins/sdlc-authz.spec')).toBe(
      `unix://${h.dir}/home/.local/share/sdlc-docker-authz/sdlc-authz.sock\n`,
    );
    expect(read(h, 'etc/systemd/network/50-sdlc-link.netdev')).toContain('Kind=dummy');
    expect(read(h, 'etc/systemd/network/50-sdlc-link.network')).toContain(`Address=${LINK}/32`);

    const env = fs.readFileSync(h.envFile, 'utf8');
    expect(env).toContain(`SDLC_DOCKER_SOCKET=/run/user/${UID}/docker.sock\n`);
    expect(env).toContain(`SDLC_RUNNER_LINK_ADDR=${LINK}\n`);
    expect(env).toContain('COMPOSE_PROJECT_NAME=acme\n');
    expect(env).toContain('SDLC_OPENBAO_CA_FILE=/etc/sdlc/ca.pem\n');
    expect(env).toContain('SDLC_DOCKER_GID=\n'); // other keys stay as in the template
    expect(fs.statSync(h.envFile).mode & 0o777).toBe(0o600);
    // The steps that stay by hand.
    expect(r.out).toContain('runner-host.sh up');
    expect(r.out).toContain("OpenBao's ca.pem");
  });

  it('never touches the machine-wide AppArmor switch or the rootful Engine', () => {
    const h = makeHost();
    const r = run(h, SAME);
    expect(r.status).toBe(0);
    expect(read(h, 'proc/sys/kernel/apparmor_restrict_unprivileged_userns')).toBe('1\n');
    expect(r.calls.join('\n')).not.toMatch(/sysctl|apparmor_restrict/);
    // No system-level docker.service call: only the user's own Engine.
    expect(r.calls.filter((c) => /^systemctl .*docker/.test(c))).toEqual([]);
    const profile = read(h, 'etc/apparmor.d/sdlc-rootlesskit');
    expect(profile).toContain(`"${h.bin}/rootlesskit" flags=(unconfined) {`);
    expect(profile).toContain('  userns,');
  });

  it('second run: changes nothing and says each step is already done', () => {
    const h = makeHost();
    expect(run(h, SAME).status).toBe(0);
    const env = fs.readFileSync(h.envFile, 'utf8');
    const r = run(h, SAME);
    expect(r.status).toBe(0);
    expect(changes(r.calls)).toEqual([]);
    expect(fs.readFileSync(h.envFile, 'utf8')).toBe(env);
    for (const done of [
      'subordinate IDs of sdlc-runner: already done',
      'cgroup delegation to user services: already done',
      'linger for sdlc-runner: already done',
      'already running',
      'sdlc-authz: already enabled',
      `link address ${LINK} on sdlc-link: already done`,
      '.env: already done',
    ])
      expect(r.out).toContain(done);
  });

  it('refuses an .env key that holds another value, before anything changes', () => {
    const h = makeHost();
    write(h.envFile, 'COMPOSE_PROJECT_NAME=sdlc\nSDLC_RUNNER_LINK_ADDR=10.66.0.1\n', 0o600);
    const r = run(h, SAME);
    expect(r.status).toBe(1);
    expect(r.out).toContain('SDLC_RUNNER_LINK_ADDR already holds another value');
    expect(changes(r.calls)).toEqual([]);
    expect(fs.readFileSync(h.envFile, 'utf8')).toBe(
      'COMPOSE_PROJECT_NAME=sdlc\nSDLC_RUNNER_LINK_ADDR=10.66.0.1\n',
    );
  });

  it("replaces only the template's defaults and empty keys", () => {
    const h = makeHost();
    write(
      h.envFile,
      'COMPOSE_PROJECT_NAME=sdlc\nSDLC_RUNNER_LINK_ADDR=\nSDLC_DOCKER_SOCKET=/var/run/docker.sock\n',
      0o600,
    );
    const r = run(h, [...SAME, '--project', 'acme']);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(h.envFile, 'utf8')).toBe(
      `COMPOSE_PROJECT_NAME=acme\nSDLC_RUNNER_LINK_ADDR=${LINK}\nSDLC_DOCKER_SOCKET=/run/user/${UID}/docker.sock\n`,
    );
  });

  it('refuses a file that already holds other settings', () => {
    const h = makeHost();
    write(path.join(h.host, 'etc/systemd/network/50-sdlc-link.network'), '[Match]\nName=x\n');
    const r = run(h, SAME);
    expect(r.status).toBe(1);
    expect(r.out).toContain('already holds other settings');
    expect(changes(r.calls)).toEqual([]);
  });

  it('--dry-run changes nothing, also without root', () => {
    const h = makeHost();
    const r = run(h, [...SAME, '--dry-run'], { FAKE_UID: '1000' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('dry run: nothing changes');
    expect(r.out).toContain('would: install the rootless Engine');
    expect(r.out).toContain('would: enable the AuthZ plugin');
    expect(changes(r.calls)).toEqual([]);
    expect(fs.existsSync(h.envFile)).toBe(false);
    expect(fs.existsSync(path.join(h.host, 'etc/systemd'))).toBe(false);
  });

  it('refuses to change the machine without root', () => {
    const h = makeHost();
    const r = run(h, SAME, { FAKE_UID: '1000' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('run it as root');
    expect(changes(r.calls)).toEqual([]);
  });

  it('AppArmor: nothing to do when user namespaces are not restricted', () => {
    const h = makeHost({ apparmor: false });
    const r = run(h, SAME);
    expect(r.status).toBe(0);
    expect(r.out).toContain('AppArmor: user namespaces are not restricted');
    expect(r.calls.some((c) => c.startsWith('apparmor_parser'))).toBe(false);
    expect(fs.existsSync(path.join(h.host, 'etc/apparmor.d'))).toBe(false);
  });

  it('names the missing packages and installs none', () => {
    const h = makeHost();
    fs.rmSync(path.join(h.bin, 'newuidmap'));
    fs.rmSync(path.join(h.bin, 'dockerd-rootless-setuptool.sh'));
    fs.rmSync(path.join(h.host, 'usr/lib/systemd/user/dbus.socket'));
    const r = run(h, SAME);
    expect(r.status).toBe(1);
    expect(r.out).toContain('docker-ce-rootless-extras');
    expect(r.out).toContain('uidmap');
    expect(r.out).toContain('dbus-user-session');
    expect(r.calls.join('\n')).not.toMatch(/apt|dpkg|install/);
  });

  it('refuses an Engine that holds the platform data', () => {
    const h = makeHost();
    fs.writeFileSync(path.join(h.state, 'volumes'), 'sdlc_postgres-data\n');
    const r = run(h, SAME);
    expect(r.status).toBe(1);
    expect(r.out).toContain("holds the platform's data");
    expect(r.calls.some((c) => c.startsWith('install-rootless.sh'))).toBe(false);
  });

  it('a VM: no dummy interface, and WireGuard stays by hand', () => {
    const h = makeHost();
    const r = run(h, ['--user', 'sdlc-runner', '--mode', 'vm']);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('networkctl'))).toBe(false);
    expect(fs.existsSync(path.join(h.host, 'etc/systemd/network'))).toBe(false);
    expect(r.out).toContain('WireGuard');
    expect(r.out).toContain('SDLC_RUNNER_LINK_ADDR in');
  });

  it('refuses bad arguments and an unknown user', () => {
    const h = makeHost();
    for (const [args, text] of [
      [['--mode', 'vm'], '--user is required'],
      [['--user', 'sdlc-runner', '--mode', 'same-server'], 'needs --link-addr'],
      [['--user', 'sdlc-runner', '--mode', 'cloud'], '--mode must be'],
      [['--user', 'sdlc-runner', '--mode', 'vm', '--link-addr', '10.0.0.0/24'], 'IPv4 address'],
      [['--user', 'nobody-here', '--mode', 'vm'], 'useradd'],
    ] as const) {
      const r = run(h, [...args]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(text);
      expect(changes(r.calls)).toEqual([]);
    }
  });
});

describe('V18: one step code for the server and CI; the README in step', () => {
  const STEPS = ['re_subids', 're_apparmor', 're_delegate', 're_linger', 're_engine', 're_check'];
  const text = (file: string) => fs.readFileSync(path.join(SCRIPTS, file), 'utf8');

  it('test-rootless-docker.sh and runner-host-setup.sh run the same steps from rootless-engine.sh', () => {
    for (const file of ['test-rootless-docker.sh', 'runner-host-setup.sh']) {
      const script = text(file);
      expect(script).toContain('rootless-engine.sh"');
      const at = STEPS.map((s) => script.indexOf(`\n${s}\n`));
      expect(at.every((i) => i > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(script).toContain('re_authz "');
    }
    // The steps themselves live in one place only.
    expect(text('test-rootless-docker.sh')).not.toContain('usermod');
    const code = (file: string) =>
      text(file)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
    for (const file of ['rootless-engine.sh', 'runner-host-setup.sh'])
      expect(code(file)).not.toMatch(/apparmor_restrict_unprivileged_userns\s*=\s*0|sysctl/);
  });

  it('the deploy README points at the command and keeps the same settings', () => {
    const readme = fs.readFileSync(path.join(root, 'platform/deploy/README.md'), 'utf8');
    const start = readme.indexOf('## The runner on its own Docker Engine');
    const section = readme.slice(start, readme.indexOf('\n## ', start + 10));
    expect(section).toContain(
      'sudo platform/deploy/scripts/runner-host-setup.sh --user sdlc-runner --mode same-server --link-addr 10.203.0.1',
    );
    expect(section).toContain('--mode vm');
    expect(section).toContain('--dry-run');
    expect(section).toContain('Delegate=cpu cpuset io memory pids');
    expect(text('rootless-engine.sh')).toContain('Delegate=cpu cpuset io memory pids');
    expect(section).toContain('--add-subuids 200000-265535 --add-subgids 200000-265535');
    expect(text('rootless-engine.sh')).toContain(
      '--add-subuids 200000-265535 --add-subgids 200000-265535',
    );
    expect(section).toContain('50-sdlc-link.netdev');
  });
});
