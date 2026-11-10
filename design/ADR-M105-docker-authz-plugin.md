# ADR-M105. Docker authorization plugin for create bodies (H07)

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-11-10, in the H07 plan; QUESTIONS #656–#660) |
| Date | 2026-11-10 |
| Decided by | Harry (H07 plan approved on 2026-11-10) |
| Related | D-08 H07 AC1–AC4; D-02 NFR-03; ADR-M25 §2.5 item 3; ADR-M80 §5 gap G-7; ADR-M91; QUESTIONS #455, #656–#660 |

## 1. Context

The runner reaches Docker only through the socket proxy. The proxy limits **method and path**, not the body of `POST /containers/create` or `POST /networks/create` (ADR-M25 §2.5 "honest limit"). Only `docker/guard.ts` inside the runner process checks the body. ADR-M80 gap G-7 follows: a compromised runner can still ask for a privileged container, a host namespace, devices, capabilities, a bind mount or a non-internal network.

Mitigations 1 and 2 (own Engine, rootless) are ADR-M91 / O01. Mitigation 3 — an authorization plugin that reads create bodies — is this ADR (task H07).

## 2. Decision

### 2.1. A Node AuthZ plugin, not OPA (QUESTIONS #656)

The Engine behind the socket proxy loads a **legacy Docker authorization plugin** (Plugin API: `/Plugin.Activate`, `/AuthZPlugin.AuthZReq`, `/AuthZPlugin.AuthZRes`). The plugin is a small Node HTTP server on a Unix socket.

OPA (or Rego) is not used: the same TypeScript evaluator must decide for the guard and for the plugin (AC2). Two policy languages would drift.

### 2.2. One denylist, shared as data (QUESTIONS #657)

One JSON file and one TypeScript evaluator are the source of the body rules:

- `platform/deploy/docker-authz/src/authz-rules.json`
- `platform/deploy/docker-authz/src/authz-eval.ts` → `evaluateAuthz(method, path, body)`

The evaluator is a **denylist** of host-escape options on create:

| Request | Refused when |
|---|---|
| `POST …/containers/create` | `Privileged`, host `PidMode` / `IpcMode` / `UTSMode` / `NetworkMode`, any `CapAdd`, any `Devices`, any `DeviceCgroupRules`, any `Binds`, any bind `Mounts`, `PublishAllPorts`, non-empty `PortBindings`, or `SecurityOpt` containing `seccomp:unconfined` / `apparmor:unconfined` |
| `POST …/networks/create` | `Internal` is not `true`, or `Driver` is `host` |

Every other method and path is allowed (the runner still needs pull, start, logs, connect, remove). The socket proxy and the endpoint allowlist stay as they are.

`docker/guard.ts` keeps its full allowlist and **also** refuses any create body that `evaluateAuthz` would deny, so the two cannot disagree on the denylist (AC2).

### 2.3. Host process on the runner Engine (QUESTIONS #658, #659)

The plugin runs as a **host process** (systemd user service on a rootless Engine; system or user service on a rootful Engine), started **before** dockerd loads `--authorization-plugin=…`.

It is **not** a container on the Engine it guards: dockerd would need the plugin to authorize creating that container (chicken-egg). It is therefore **not** one of the six platform Compose images in `images.lock` (R089). A Dockerfile under `platform/deploy/docker-authz/` pins its Node base by digest for optional offline extract; CI and the company server run the compiled JS from the deploy tree (`node …/dist/main.js`).

**Required** on the runner's own Engine (runner-host / company server). On a developer machine or trial that shares one Engine: document + `pnpm doctor` **warning** when the plugin is missing; do not reconfigure Docker Desktop.

### 2.4. AuthZRes always allows (QUESTIONS #660)

`/AuthZPlugin.AuthZRes` always returns `Allow: true`. Denial is only on the request path. Responses carry no create-body risk the denylist must stop.

### 2.5. Install and tests

- Install helpers under `platform/deploy/docker-authz/scripts/` and T11: start the plugin, write the `.spec` (or pass the socket path), add `--authorization-plugin=sdlc-authz` to the runner Engine, restart dockerd.
- CI rootless job (`test-rootless-docker.sh`) starts the plugin and enables it before `pnpm test:runner`.
- AC3: a privileged `containers/create` sent through the socket proxy (guard bypassed) is refused by the Engine (HTTP 403 from dockerd).

## 3. Rules and where they live

| Rule | Where |
|---|---|
| Create-body denylist | `authz-rules.json` + `authz-eval.ts`; guard calls `evaluateAuthz`; plugin calls the same |
| Plugin on the runner Engine | T11, deploy README, `test-rootless-docker.sh`, doctor `runner.authz` |
| Never a container on the guarded Engine | This ADR §2.3; install scripts |

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| OPA / Rego AuthZ plugin | Two policy languages; AC2 needs one evaluator |
| Managed Docker plugin package | Heavier packaging; legacy socket plugin is enough and works rootless |
| Plugin as a Compose service on the runner Engine | Chicken-egg with `--authorization-plugin` |
| Require AuthZ on Docker Desktop / shared trial Engine | Breaks developer machines; doctor warns instead |

## 5. Consequences

- Gap G-7's code mitigation (body checks outside the runner process) is closed when the plugin is installed on the runner Engine. Own Engine + rootless (ADR-M91) stay required for the company server.
- ADR-M25 §2.5 item 3 points here.
- Handbook T11: install, update, and what to do when the plugin refuses a legitimate run.
- `pnpm doctor` check `runner.authz`: warning when the sandbox Engine has no authorization plugin (non-blocking on developer machines).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-11-10 | Claude, approved by Harry | H07: shared denylist, Node legacy AuthZ plugin as a host process, doctor warn, T11 |
