# ADR-M107. One command to set up the runner host

| Item | Value |
|---|---|
| Status | **Accepted** (task V18) |
| Date | 2026-11-12 |
| Decided by | Harry (V18–V20 plan approved 2026-11-11, QUESTIONS #671–#673) |
| Related | D-08 V18; QUESTIONS #672, #673; ADR-M91 (the runner on its own Engine); ADR-M105 (the AuthZ plugin, H07); ADR-M98 (`pnpm server:setup`, which does the platform host's side of the link, V20); ADR-M25 §2.4 (sandbox limits); runbook T11 §5g-1; `platform/deploy/README.md` "The runner on its own Docker Engine"; rule R149 |

## 1. Context

The runner runs on its own rootless Docker Engine on the server (ADR-M91). Before V18, the runner host took steps 1, 2 and 5 of the deploy README by hand: subordinate IDs, an AppArmor profile, cgroup delegation, linger, `dockerd-rootless-setuptool.sh install`, the check of `docker info`, the AuthZ plugin (H07), on the same server a dummy interface, and the runner host's `.env`. The CI script `test-rootless-docker.sh` did the same steps in its own copy, so the README, CI and a server could drift apart. `pnpm server:setup` (V20) already does the platform host's side of the link.

## 2. Decision

### 2.1 One step code, two callers

- `platform/deploy/scripts/rootless-engine.sh` holds the steps of the Engine as shell functions: `re_subids`, `re_apparmor`, `re_delegate`, `re_linger`, `re_engine`, `re_check`, `re_authz`. It is sourced, never run.
- `runner-host-setup.sh` (a server) and `test-rootless-docker.sh` (the CI jobs `runner-rootless` and `runner-split`) call the same functions in the same order. So CI tests the server's steps. What stays CI only: the containerd image store, the AuthZ boot probe, and `GITHUB_ENV`.
- Shell, not TypeScript: the runner host needs no platform build besides the AuthZ plugin, and the CI script was already shell.

### 2.2 The command

`sudo platform/deploy/scripts/runner-host-setup.sh --user <user> --mode same-server|vm [--link-addr <IPv4>] [--project <name>] [--ca-file <path>] [--bin <folder>] [--dry-run]`

1. Checks before any change:
   - the arguments;
   - root (unless `--dry-run`);
   - the user exists (it never creates one);
   - Docker's packages and Node.js, named when missing. It installs no package (QUESTIONS #672).
   - the checkout belongs to the user;
   - every `.env` key and every file it would write. A key or a file that holds another value is refused, before anything changes.
   - on the same server, systemd-networkd runs.
2. The Engine's steps (§2.1), as root or as the user. Each step checks the state first and says when it is already done.
3. The AuthZ plugin: root writes the discovery file `/etc/docker/plugins/sdlc-authz.spec` (the runner user has no `sudo`), then the user runs `install-rootless.sh` (H07). `enable.sh` keeps a discovery file that is already in place.
4. On the same server: the dummy interface `sdlc-link` with the link address. It writes two systemd-networkd files, then runs `networkctl reload`.
5. The runner host's `.env`: `runner-host.sh env` when the file is missing, then only empty keys or the template's defaults. It sets `SDLC_DOCKER_SOCKET`, and also, when they are given, `SDLC_RUNNER_LINK_ADDR`, `COMPOSE_PROJECT_NAME` and `SDLC_OPENBAO_CA_FILE`.
6. At the end it lists what stays by hand:
   - WireGuard on a VM;
   - OpenBao's `ca.pem`;
   - the platform host's steps 3, 4 and 6;
   - `runner-host.sh up`.

### 2.3 Limits

- It never sets `kernel.apparmor_restrict_unprivileged_userns=0`. The profile allows user namespaces for `rootlesskit` only.
- It never touches the machine's own (rootful) Engine. `dockerd-rootless-setuptool.sh install --force` keeps it running.
- It refuses an Engine that holds the platform's data (the volume `postgres-data`).
- It handles no secret. The AuthZ operator key is made and kept by `install-rootless.sh` (mode 600, never printed).
- It changes the machine as root, so only the owner runs it, in their own terminal. The Claude Code hook refuses it (rule R149).

### 2.4 Tests

`platform/tests/deploy/runner-host-setup.test.ts` runs the real script on a simulated host. A host root folder (`SDLC_HOST_ROOT`, for tests only) holds the files it reads and writes. Every program that would change the machine is a stub that records its call. The test runs these cases:

- a first run;
- a second run that changes nothing;
- a conflicting `.env` value;
- a file with other settings;
- `--dry-run` without root;
- AppArmor present and absent;
- missing packages;
- an Engine with the platform's data;
- a VM;
- bad arguments.

The test also checks that the CI script and the server script call the same steps, and that the README is in step with them. The CI job `runner-rootless` runs the shared steps on a real rootless Engine.

## 3. Consequences

- The runner host is one command after the packages are installed, and a second run is safe.
- A change of a step changes `rootless-engine.sh`, so CI tests it the next time `platform/deploy/` changes.
- Still by hand:
  - the packages;
  - the user;
  - the checkout and the plugin's build;
  - WireGuard on a VM;
  - the copy of `ca.pem`;
  - `runner-host.sh up`.
- Without systemd-networkd, the same-server mode refuses. The dummy interface is then made by hand.
