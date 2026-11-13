# ADR-M25. Runner: sandbox egress, image, workspace, Docker access, clean-up

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task C04) |
| Date | 2026-09-27 |
| Decided by | Harry (C04 plan approved 2026-09-27; session 3 plan approved 2026-09-27; QUESTIONS #44, #52, #53, #54, #55, #59) |
| Related | D-02 FR-30, FR-33, FR-34, FR-50; D-03 sections 4, 5.1, 6.5, 7.2, 8, 8.2, 9, 10, 10.1, 13 (version 1.6); D-05 section 6.4; D-08 tasks C04, C05, C06, C08, C09, C11, R01; ADR-M10, ADR-M17, ADR-M19, ADR-M21, ADR-M22, ADR-M23, ADR-M24 |

## 1. Context

Task C04 builds the runner: it receives a Run Contract, creates one sandbox per run, and removes it afterwards. The C01 PoC (ADR-M10) proved the hardening flags and found open points:

- A Docker network works on IP level; it cannot allow "GitHub only" by domain (ADR-M10 §4.3).
- The pinned Agent Server image has no project toolchain, and the sandbox cannot install one (QUESTIONS #59).
- The runner needs the Docker socket, which is root-equivalent on the host (D-03 §13).
- Who holds the GitHub App key, and how the single-repository token reaches the runner (QUESTIONS #44).
- How the worker talks to the runner, and where extra runs wait (D-03 §10.1).

C04 is split into three sessions. Session 1 (this ADR, first version) delivers the Docker layer, the hardening, the egress layout, the slot pool, the run claim and the run event types. Session 2 adds the token handoff, the clone and the full provisioning flow. Session 3 adds the runner process and image, the Compose profile `sandbox` (socket proxy, package proxy, local registry), the clean-up after a restart, the periodic sweep and the first sandbox image `node24`. The Temporal side of the handoff moves to C06 (§2.7).

## 2. Decision

### 2.1. GitHub is reached by the runner, never by the sandbox (QUESTIONS #52)

- The runner clones the repository before the sandbox starts (session 2). C05/C08 push `agent/INT-…` from the runner, with an explicit refspec, after G5.
- The sandbox holds no GitHub credential at all. It cannot push to `main` (N6 is stronger than branch protection alone), and the kill switch (C11) has one credential fewer to revoke.
- Consequence for C08: D-03 §4, diagram D11 and the D-02 §5 flow show "agent pushes branch". C08 updates them (backlog note, D-08 1.3).

### 2.2. Egress: one internal Docker network per run

D-03 §9 (version 1.6): the sandbox reaches **LiteLLM and the package proxy only**.

- Each run gets its own network `sdlc-run-<run_id>`: bridge, `internal: true`, no IPv6, not attachable, and `com.docker.network.bridge.inhibit_ipv4=true`. Docker gives an internal network no route out, and its DNS resolves only containers attached to it.
- **The bridge gets no IP address** (`inhibit_ipv4`). Without it, Docker gives the bridge the network's gateway address, and a sandbox can reach every service listening in the host's network namespace through that address. The first CI run found this on Linux; on Docker Desktop the probe had not covered the VM's own namespace. With the option, the host has no address on the run's network. The guard refuses a network without it.
- The sandbox joins that network only.
- The runner attaches exactly the services the contract allows, under their aliases (`litellm`, `npm-proxy`), and detaches them at clean-up.
- Two runs never share a network, so two sandboxes (maybe of two tenants) cannot reach each other.
- The contract's `egress_allowlist` holds `alias:port` entries. The runner maps each entry to a configured service. An entry it cannot enforce (an internet host such as `github.com`, an unknown alias, a wrong port) refuses the run: `provisioning_failed` with reason `egress_not_enforceable`. The runner never opens more than it was asked, and never silently less.
- No firewall rules and no domain-filtering proxy are needed. The same layout works on Docker Desktop (development) and Linux (CI, server).

Tested live (`pnpm test:runner`) from inside a sandbox. Reachable: LiteLLM and the package proxy (also under the LiteLLM container's own name: the same service and port). Not reachable:

- an internet IP and `api.github.com`;
- `host.docker.internal`;
- a service in the host's network namespace, on every host address (loopback, LAN, every Docker bridge), with a positive control that the service is reachable from an ordinary network;
- a service of the test process on the same addresses;
- a stub OpenBao on the platform network (by name and alias);
- another run's sandbox (by name and by IP).

There is no default route.

### 2.3. Names, labels and the workspace

- Names come from the run ID (a lowercase UUID): container `sdlc-sandbox-<id>`, network `sdlc-run-<id>`, volume `sdlc-ws-<id>`. Labels: `sdlc.managed-by=sdlc-runner`, `sdlc.runner-instance`, `sdlc.run-id`, `sdlc.tenant-id`.
- The workspace is a **per-run Docker volume** mounted at `/workspace`. A tmpfs (ADR-M10) cannot receive an archive before the start.
- **What goes into the archive (packing the clone):**
  - A symbolic link is stored as a link entry, holding only its target path. The target is never read or followed, wherever it points (`/etc/passwd`, `../..`, the runner's own files). The runner uses `lstat`, never descends into a linked directory, and opens each regular file with `O_NOFOLLOW`. The open file must be the same file (device and inode) the walk saw, so a swap after `lstat` is refused.
  - Hard links, devices, FIFOs and sockets are refused (`workspace_invalid`). A root that is itself a link is refused too.
  - Every entry path is relative and stays inside the workspace after normalisation: no `..`, no `.` segment, no `//`, no backslash, no absolute path (`workspace_invalid`).
  - Inside the sandbox a link resolves in the sandbox's own file system, never on the runner's host.
  - Tests: a repository with an absolute link, a `../` link, a link to `/etc/passwd` and a link to a directory outside the clone packs as link entries with none of the targets' bytes. Hard links, sockets, FIFOs and escaping entry names are refused.
- The runner uploads the working copy as a tar archive into the created (not yet started) container, through the Docker archive API with `copyUIDGID`. Every entry belongs to the sandbox user 10001. The runner's own tar writer fixes owners, modes and times, so nothing from the runner's host leaks into the archive.
- **Image contract:** the project image must define a Docker `HEALTHCHECK` that passes when the Agent Server is ready (the runner waits for it and refuses an image without one: `image_has_no_healthcheck`), and it must own `/workspace` as `10001:10001`. Docker copies that owner into the run's empty volume when the sandbox is created; the archive cannot change the owner of the volume root (found in the live test). The session 3 images do this in their Dockerfile.
- Creation order: volume → network → attach services → container → archive → start. A failure at any step removes everything created so far.

### 2.4. Sandbox hardening

Built by one function (`buildSandboxSpec`), from ADR-M10 §2.4:

| Setting | Value |
|---|---|
| Image | Project image pinned by digest (§2.9) |
| User | `10001:10001` |
| Root filesystem | Read-only |
| tmpfs | `/tmp` (`exec`, needed by the Agent Server), `/home/openhands` (`noexec`); `nosuid,nodev`, size from settings |
| Capabilities | All dropped; `no-new-privileges` (so `sudo` in the image cannot work) |
| Limits | Memory (swap = memory, so no extra swap), CPUs, processes: runner settings. Defaults 2 GiB, 1.5 CPUs, 512 |
| Mounts | The run's workspace volume only. No bind mount, no Docker socket |
| Ports | None published |
| Restart | Never; `init` process on |
| Environment | Allowlist: `SESSION_API_KEY` and `OH_SECRET_KEY` (random per run), fixed Agent Server flags, `NPM_CONFIG_REGISTRY` |

The sandbox never receives a provider key, the LiteLLM master key, an OpenBao address or token, or a GitHub token (FR-33, FR-50, §2.1). The only model credential is the run's LiteLLM virtual key, which C05 passes to the Agent Server through its API.

### 2.5. The runner's Docker access (D-03 §13)

- Own client on `node:http` over the Unix socket, no dependencies (like ADR-M21, ADR-M23). API version 1.44 (Docker Engine 25 or later).
- **Endpoint allowlist:** ping, image inspect/pull, containers (list, create, inspect, start, wait, logs, archive upload, remove), networks (list, create, inspect, connect, disconnect, remove), volumes (list, create, remove). No exec, build, commit, swarm, plugins or system calls. Anything else is refused before it reaches the socket.
- **Guard:** every container and network definition is checked again just before the socket, as an allowlist of keys. Refused: any unknown option (so `Privileged`, `Binds`, `PidMode`, `CapAdd`, `Devices`, `PortBindings`… can never slip through), a bind mount, a second mount, a writable root, kept capabilities, extra swap, a missing limit, a restart policy, an image without digest, a user other than 10001, an environment variable outside the allowlist, a command override, and a network that is not the run's own internal network.
- Errors never contain Docker's own text (it can echo request data); only the method, the status code or a Node error code.
- **Socket proxy (session 3):** in Compose the runner never gets the Docker socket. It reaches Docker through **wollomatic/socket-proxy** 1.13.1 (MIT, a few files Apache-2.0; Go, built from scratch with no OS; pinned by digest), service `docker-socket-proxy`:
  - It is the only service that mounts `/var/run/docker.sock`, read-only. It joins no network (`network_mode: none`), runs as uid 65534 with the socket's group (`SDLC_DOCKER_GID`, filled in by `init-env.sh`), with a read-only root and no capabilities.
  - It listens on a Unix socket (mode 0660) in the in-memory volume `docker-proxy`, which only the proxy and the runner mount. The runner joins the socket's group.
  - Its allowlist is one regular expression per method, the same list as the client's `ALLOWED_ENDPOINTS` with the API version `/v1.44`: GET ping, image inspect, container list/inspect/logs, network list/inspect, volume list; POST image pull, container create/start/wait, network create/connect/disconnect, volume create; PUT container archive; DELETE container, network, volume. Nothing else: no exec, attach, build, commit, push, image delete, prune, events, info, swarm, plugins or secrets. A static test sends the same list of requests through both allowlists and fails when they differ (`platform/tests/deploy/sandbox-profile.test.ts`).
  - `-allowbindmountfrom` names a folder that does not exist, so the proxy refuses every bind mount in a container definition (checked live: HTTP 403).
- **Honest limit of the proxy:** a method-and-path proxy cannot read the body of `POST /containers/create`. Apart from bind mounts, it lets through what the body asks for: `Privileged`, host namespaces, devices, capabilities, a host network (checked live: a privileged container definition is accepted by the proxy). Only `docker/guard.ts` inside the runner checks the container definition. The proxy therefore limits the *endpoints* a compromised runner can reach (no exec into other containers, no image push, no reading the host's system information), not what it can create.
- **Residual risk and mitigations:** whoever controls the runner process can still create a privileged container through `containers/create`. Mitigations, in order of effect:
  1. Run the runner (and its Docker Engine) in a **separate VM** from the platform (D-03 §10.1), so root on that host reaches only sandboxes and the runner itself.
  2. **Rootless Docker** or `userns-remap` for that Engine, so a privileged container is not root on the host.
  3. A Docker **authorization plugin** that inspects request bodies with the same denylist as the guard (task H07, ADR-M105): a Node legacy AuthZ plugin as a host process on the runner Engine, shared `authz-rules.json` + `evaluateAuthz`.

  Items 1 and 2 are task O01, decided in ADR-M91: the runner and the sandboxes get their own Docker Engine (a separate VM or a second Engine), rootless in both cases, because rootless Docker on the platform's one Engine still lets the runner mount the platform's volumes. Item 3 is task H07 (ADR-M105).

**Scoring containers (task L04, ADR-M81 §2.5, QUESTIONS #463).** The runner scores an evaluation run with the sandbox image, with no new endpoint (still no exec, no build, no archive read). A new guard rule `assertSafeScoringSpec` accepts a container only if it is a hardened sandbox of the run (same name, labels, image by digest, user, capabilities, read-only root, limits, the one volume of the run) with **one fixed command**: `Entrypoint` `/bin/sh -c` and `Cmd` `sh /workspace/in/install.sh` or `sh /workspace/in/score.sh`, never another. The `install` step is on the run's own internal network with the package proxy; the `score` step, which runs the agent's diff and the hidden tests, must have `NetworkMode: none`. Its environment allowlist is its own (`HOME`, `CI`, the proxy, the pnpm store and the corepack cache, both on the volume); a provider key or token is refused. The result is read from the container's standard output (the logs endpoint is already allowed), never from a file the agent's code could have rewritten after the script. Tests: `tests/runner/guard-scoring.test.ts` (every refusal), `score-evaluation.test.ts` (the order of Docker calls, with the stub) and the live `pnpm test:eval-score` (no network, same score as the developer machine).

### 2.6. Settings

Deployment settings come from the environment (`SDLC_RUNNER_*`), not from the project configuration: they describe the Docker host. They choose sizes and reachable services; nothing can loosen §2.4.

| Setting | Default | Notes |
|---|---|---|
| `SDLC_RUNNER_DOCKER_SOCKET` | `/var/run/docker.sock` | Absolute path; in Compose the socket proxy |
| `SDLC_RUNNER_INSTANCE` | `sdlc` | Label value; separates runner deployments on one Docker host |
| `SDLC_RUNNER_MAX_SANDBOXES` | `1` | 1–16. D-03 §10.1: 1–2 on the internal server |
| `SDLC_RUNNER_MAX_EVAL_SANDBOXES` | `1` | 0 to `SDLC_RUNNER_MAX_SANDBOXES`. Evaluation runs (ADR-M81 §2.3): free slots only; 0 turns them off |
| `SDLC_RUNNER_SANDBOX_MEMORY_MB`, `_CPUS`, `_PIDS`, `_TMP_MB` | 2048, 1.5, 512, 512 | ADR-M10 §2.5 |
| `SDLC_RUNNER_EGRESS_SERVICES` | none | `alias=container:port,…`, for example `litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873` |
| `SDLC_RUNNER_NPM_REGISTRY` | none | For example `http://npm-proxy:4873/`; its host and port must be an egress service |
| `SDLC_RUNNER_GIT_BASE_URL` | `https://github.com` | Git host origin the runner clones from; no user, password or path |
| `SDLC_RUNNER_GIT_ALLOW_PLAINTEXT` | off | `1` allows an `http://` Git host: development and tests only |
| `SDLC_RUNNER_GIT_TIMEOUT_SECONDS` | 300 | Per git command |
| `SDLC_RUNNER_WORK_DIR` | `<tmp>/sdlc-runner` | Absolute path; each run clones into its own subfolder, removed right after the upload |
| `SDLC_RUNNER_WORKSPACE_MAX_MB` | 1024 | Largest workspace (file content, `.git` included) the runner uploads |
| `SDLC_RUNNER_READY_TIMEOUT_SECONDS` | 120 | How long the runner waits for the sandbox health check |
| `SDLC_RUNNER_SWEEP_INTERVAL_SECONDS` | 300 | 30–3600. How often the runner removes the objects of runs it does not hold (§2.8) |
| `SDLC_RUNNER_DB_HOST`, `_DB_PORT`, `_DB_NAME`, `_DB_SECRET_PATH` | `postgres`, 5432, `platform`, `runner/database` | The runner connects as `platform_app`; the password is read from OpenBao (`kv/runner/database`, written by `openbao:bootstrap runner-credentials`), never from the environment |
| `SDLC_RUNNER_HEARTBEAT_FILE` | `<tmp>/sdlc-runner-heartbeat` | Written after each clean-up; the container health check fails when it is older than two sweep intervals plus 30 seconds. In Compose `/tmp` is a tmpfs (read-only root) |

- **One runner process per instance label.** The clean-up at start removes every object with the instance's label, so two processes with the same `SDLC_RUNNER_INSTANCE` on one Docker host would remove each other's sandboxes. Compose runs one `sdlc-runner` per project; the label is `COMPOSE_PROJECT_NAME`.

### 2.7. Worker ↔ runner, and where extra runs wait (QUESTIONS #53)

- The runner is a Temporal worker on the task queue `sdlc-runner`. One long-running activity per run sends heartbeats while the sandbox lives. **Built in C06** (QUESTIONS #55, D-08 1.5 C06 AC4): no workflow calls the runner before C06, so C04 has nothing to test the activity against. C04 delivers the process the activity will run in (`Runner`: slot pool, held runs, clean-up, sweep).
- The limit is the activity slot count of that worker (`maxConcurrentActivityTaskExecutions` = `SDLC_RUNNER_MAX_SANDBOXES`), so extra runs wait in Temporal, as D-03 §10.1 says.
- Inside the process, a **slot pool** (FIFO) is the backstop: at most `SDLC_RUNNER_MAX_SANDBOXES` sandboxes exist at once. `Runner.provision` takes a slot before provisioning and keeps it while the sandbox lives; `Runner.release` frees it, and a failed provisioning frees it at once (tested on PostgreSQL: with one slot, the second run waits until the first is released).
- A contract can expire while its run waits (15 minutes by default). The runner refuses it (`expired`, ADR-M22); the workflow then sets that run to `cancelled` with `contract_expired` and issues a new attempt (C06).

### 2.8. Claim, clean-up, run events

- **Provisioning order (`provisionRun`, session 2):**
  1. verify the Run Contract (ADR-M22; a refused contract is recorded there, and nothing else happens: no claim, no unwrap);
  2. hold the run in this process (a second provisioning of a held run is refused before Docker) and **reserve its labelled workspace volume** (session 3);
  3. claim the run;
  4. unwrap the GitHub token (§2.11);
  5. check that the egress list can be enforced;
  6. load `sandbox.image` from the project configuration;
  7. clone and pack the workspace → `workspace_prepared`;
  8. create the sandbox (network, services, container, archive) → `sandbox_created`;
  9. wait for its health check, then `provisioning → running` → `sandbox_ready`.

  Any failure after the claim removes what was created (the reserved volume included), records `provisioning_failed` (and `sandbox_removed` when a sandbox was started), and ends the run as `failed` with the reason as `stop_reason`.
- **Workspace reserved before the claim (session 3):** every claimed run has at least one labelled Docker object from the start, so a crash at any later step leaves something the clean-up can find. Docker's volume create is idempotent, so the runner lists first. A volume that it created is removed again when the claim fails; a volume that already existed is left alone (another provisioning of the run). No crash window is left: a crash between the reservation and the claim leaves a volume and a `queued` run, which the clean-up removes without changing the run. The clone on the runner's disk is removed in every case. `releaseSandbox` removes the sandbox at the end of a run (C05) or on a kill (C11) and records `sandbox_removed`; the run status stays the caller's.
- **Claim (QUESTIONS #35):** after the contract is verified, the runner moves the run `queued → provisioning` with one conditional update (`RunRepository.claimForProvisioning`) and checks the row count. Zero rows → no sandbox. Tested with concurrent claims on PostgreSQL: exactly one wins.
- **Clean-up (`teardownSandbox`):** remove the container, detach the shared services, remove the network, remove the workspace volume. Idempotent (objects already gone are skipped), every step runs even when one fails, and the first error is reported at the end. Used after success and failure (session 2), and for orphans (session 3).
- **Restart (session 3, `reconcileOnStart`):** at start, the runner lists the containers, networks and volumes with its `sdlc.managed-by` and instance labels, and groups them by run. The `sdlc.run-id` and `sdlc.tenant-id` labels are trusted only on objects that carry this runner's instance label and have well-formed UUIDs (`runOfLabels`); anything else is left alone. For each run: `teardownSandbox`, then, in the run's tenant scope:
  - `provisioning`, `running` or `stopping` → `failed` with `stop_reason` `runner_restarted`; events `run_abandoned {previous_status}` and `sandbox_removed {reason: runner_restarted}`. Their outputs are lost.
  - a final status → `sandbox_removed {reason: orphan}`.
  - `queued` (workspace reserved, never claimed) or no row → objects removed, nothing recorded.

  Old clone folders (`run-*`, and the `publish-*` folders of a push the old process did not finish, ADR-M38 §2.2) in the work folder are removed too; other entries stay. An error on one run is counted and the next run is still handled.
- **Sweep (session 3, `sweepOrphans`):** every `SDLC_RUNNER_SWEEP_INTERVAL_SECONDS`, the same for runs this process does **not** hold; a run that has not reached a final status becomes `failed` with `sandbox_lost` (`run_abandoned` + `sandbox_removed {reason: orphan}`). Held runs are never touched. A sweep that fails as a whole (Docker unreachable) is logged and retried at the next interval.
- Tests: unit tests (labels, instance filter), PostgreSQL tests with stub Docker (every branch, one broken run does not block the others, held runs untouched) and a live test on Docker (`pnpm test:runner`: a real sandbox, then a new process cleans up; objects of another instance survive).
- **Run events** (coded payloads only, ADR-M22 §2.5): `workspace_prepared {base_sha, duration_ms}`, `sandbox_created {image_sha256}`, `sandbox_ready {duration_ms}`, `provisioning_failed {reason}`, `sandbox_removed {reason, duration_ms}`, `run_abandoned {previous_status}` (session 3). Reasons are codes. `provisioning_failed`: `token_unavailable`, `config_unavailable`, `egress_not_enforceable`, `clone_failed`, `base_sha_not_found`, `token_leaked`, `workspace_too_large`, `workspace_invalid`, `image_unavailable`, `image_has_no_healthcheck`, `sandbox_unhealthy`, `sandbox_not_ready`, `run_stopped`, `docker_error`. `sandbox_removed`: `finished`, `failed`, `provisioning_failed`, `killed`, `orphan`, `runner_restarted`. Stop reasons added in session 3: `runner_restarted`, `sandbox_lost`.

### 2.9. Sandbox image per project (QUESTIONS #59 option A, #54)

- Project configuration `sandbox.image`: a reference **pinned by digest** (`[registry/]name[:tag]@sha256:<64 hex>`); a tag alone is refused. Default: the pinned Agent Server base of ADR-M10 §2.1 (no project toolchain). The default `config_hash` changes.
- Images are built on the pinned Agent Server base plus the project toolchain. Dockerfiles live in `platform/sandbox-images/<toolchain>/`. CI builds them and scans them with Trivy for vulnerabilities and licences, with the same rules as ADR-M10 §2.1.
- **First image, `node24` (session 3):** for Node.js projects such as the sample repo (Vue + NestJS).
  - The pinned base already ships Node.js 24 (24.21.0) and corepack 0.36.0, so the image reuses them instead of copying another Node in; the build fails when a new base ships another Node major.
  - `corepack enable pnpm`: corepack fetches the pnpm version a project pins in `packageManager` through `COREPACK_NPM_REGISTRY`, which the runner sets to the package proxy (Harry's review). `COREPACK_HOME` and the npm cache live on the sandbox's tmpfs.
  - The Agent Server keeps its state under `workspace/…` of its working directory by default. The sandbox starts in `/workspace`, which is the repository, so that state would show as changed files; `OH_CONVERSATIONS_PATH` and `OH_BASH_EVENTS_DIR` move it to the home tmpfs (found in the live test).
  - Image contract: `/workspace` owned by 10001 (the base's empty `/workspace/project` removed), `HEALTHCHECK` on the Agent Server's `/ready`, user 10001. No secret and no proxy address are baked in.
- **Build and store:** `platform/sandbox-images/build.sh <toolchain>` builds, pushes to the local registry and prints the reference by digest for `sandbox.image`. The registry is the Compose service `registry` (profile `sandbox`): `registry:2.8.3` pinned by digest, published on **127.0.0.1 only** (`SDLC_REGISTRY_HOST_PORT`, default 5050 because macOS uses 5000), with **no authentication**. Only operators on the server push; the Docker Engine pulls by digest (runbook T11). Deleting old images is allowed (`REGISTRY_STORAGE_DELETE_ENABLED`); garbage collection is a runbook step.
- **CI (job `sandbox-image`):** builds the image, scans it with Trivy (vulnerabilities: CRITICAL blocks, HIGH is listed; licences: the CRITICAL licence category blocks), pushes it only to a throw-away `registry:2` on 127.0.0.1 inside the job, and runs `pnpm test:sandbox-image` against that digest. Nothing is pushed to GHCR or any other registry. The job runs on changes to the images or the runner, on the weekly schedule and on manual dispatch.
- **Registry for the MVP (QUESTIONS #54):** a local registry on the server, `registry:2` (distribution, Apache-2.0, pinned by digest), or a build on the server. Images are always referenced by digest. GHCR is not used for now: private packages on GitHub Free have a small free storage quota, and the ~860 MB Agent Server image would likely exceed it. **GHCR is the option after the GitHub Team upgrade.**
- The runner pulls a missing image by digest and refuses to start when the pull fails (`image_unavailable`).

### 2.10. Package proxy (QUESTIONS #59 option C)

- **Verdaccio** 6.9.3 (MIT), pinned by digest, as the Compose service `npm-proxy` in the profile `sandbox` (session 3). Its only uplink is registry.npmjs.org; publishing and unpublishing are refused; no web UI; no host port; packages are cached in a volume. It sits on the platform network (for its uplink) and is attached to each run's network by the runner. 6.10.x was days old with five patches in a month, so the previous minor's last patch is pinned (ADR-M17 rule).
- **Accepted risk of option C (Harry's review):** the uplink makes the proxy a channel out of the sandbox. An agent can put data into the names or versions of packages it asks for (for example `GET /<encoded-data>`), and Verdaccio forwards the request to registry.npmjs.org. The data leaves as request paths only (no request body is forwarded) and only to the npm registry. This is accepted for the MVP, because the sandbox holds only the workspace of an intent whose data class allows the model provider anyway (D-07 §4), and the sandbox has no credential. Mitigations: installs from the lockfile (`--frozen-lockfile`); the request log (below); later, an allowlist of packages or an offline mirror for `client_restricted` projects.
- **Request log:** Verdaccio logs each request as JSON on stdout with the package and the client address. A sandbox's address belongs to its own run network `sdlc-run-<run_id>`, so an operator can tell which run asked for which package while the run exists. The log is not copied into the platform database (it would be free text in an append-only table); correlating it per run automatically is left for later.
- The sandbox gets `NPM_CONFIG_REGISTRY` from the runner settings; pnpm reads it. Installs should use the lockfile (`pnpm install --frozen-lockfile`) so the proxy serves only reviewed versions.
- Later, only when a project needs them: PyPI through **devpi-server** (MIT), Maven through **Reposilite** (Apache-2.0). Each is one more egress service.

### 2.11. The GitHub token (QUESTIONS #44, session 2)

- The worker issues the single-repository installation token (`GitHostAdapter.issueShortLivedToken`, ADR-M23) and hands it to the runner as an **OpenBao response-wrapped token**: single use, time to live equal to the contract validity. Only the wrapping token travels with the envelope (Temporal keeps activity inputs in its history, so a raw token would be stored in PostgreSQL).
- The runner unwraps it once and keeps the token in memory only. If someone else unwrapped it first, the unwrap fails and the runner refuses the run.
- The runner checks with `sys/wrapping/lookup` that the wrapping token was made by `sys/wrapping/wrap` before it unwraps, so a wrapped response of another endpoint is refused. Unwrapping is authenticated by the wrapping token itself.
- The token reaches git through `GIT_CONFIG_*` environment variables of the git process (`http.<Git host origin>/.extraheader`), never through process arguments, the clone URL, `.git/config` or the sandbox. The git process gets no system or user configuration, no prompt, no hooks, no submodules and HTTPS only. After the clone the runner checks that the token is not in `.git/config`.
- `runner.hcl` loses `kv/data/shared/github-app`; `worker.hcl` gets `sys/wrapping/wrap`; `@sdlc/secrets` gets `wrapping()` (`wrap`, `unwrap`; interfaces `SecretWrapper`, `SecretUnwrapper` in `@sdlc/contracts`).
- **Found in the live OpenBao test:** OpenBao's built-in `default` policy, which every AppRole token carries (the client needs it for its own token lookup, renewal and revocation), already allows `sys/wrapping/wrap` for every token. This is harmless: wrapping packages only data the caller already holds and grants no access. The `worker.hcl` line keeps the handoff working if the default policy is ever tightened.

### 2.12. A stronger sandbox runtime: gVisor or Kata (task H06, QUESTIONS #701–#704)

The hardening of §2.4 runs the sandbox on the host's kernel; a kernel bug is a sandbox escape (ADR-M80 gap G-6). An operator can give the sandbox a kernel of its own.

- **Setting.** `SDLC_RUNNER_SANDBOX_RUNTIME`: empty (the default: the Engine's own runtime, `runc`), `runsc` (gVisor, a kernel in user space) or `kata` (Kata Containers, a small virtual machine per container). The list is closed in code; any other value stops the runner at start (`runner.config.invalid_setting`).
- **Which containers.** The sandbox and both scoring containers (§2.5, ADR-M81 §2.5) get `HostConfig.Runtime`: the code of a repository runs only there. Tool and gateway containers (ADR-M69, ADR-M87) keep the Engine's runtime: they run platform images, not a repository's code, and the runner connects them to more than one network (the gateway to the run's network, a tool to its service network); moving them to gVisor would need its own test of those connections (QUESTIONS #704). Their guard keeps refusing a `Runtime` key.
- **Guard.** `Runtime` is on the sandbox allowlist only. The spec must name exactly the configured runtime, or none when there is none; another value is refused with the check code `runtime`. The DockerClient gets the configured runtime and passes it to the guard.
- **Start check.** With a runtime set, the runner reads `GET /info` once at start (one more endpoint in `ALLOWED_ENDPOINTS` and the socket proxy allowlist, kept equal by the test). It keeps only the runtime names and the rootless flag. It refuses to start when the Engine does not list the runtime (`runner.docker.runtime_missing`) or when the Engine is rootless (`runner.docker.runtime_rootless`).
- **Rootful only (QUESTIONS #701).** gVisor and Kata need a rootful Engine for the run's own network: rootless gVisor has no network namespace of its own, and Kata needs `/dev/kvm`. So the stronger runtime is an **alternative** to the rootless Engine of ADR-M91 and ADR-M107, not an addition: a rootful Engine **in its own virtual machine**, with the AuthZ plugin (ADR-M105). On the same server as the platform, keep the rootless Engine and the default runtime.
- **AuthZ (QUESTIONS #703).** The plugin takes `--require-runtime` (or `SDLC_DOCKER_AUTHZ_REQUIRE_RUNTIME`): every create that gives a container a run's workspace (a `sdlc-ws-…` volume in `Mounts` or `Binds`, or any `VolumesFrom`) must name that runtime (`runtime_required`). Without the option nothing changes. Limit: a runner that is taken over can still start a container on the default runtime without the workspace, and copy files into it through the archive endpoint; the plugin stops runner bugs, not a full takeover (the runner on its own Engine, ADR-M91, still limits what that reaches).
- **Kata (QUESTIONS #702).** Accepted by the setting, the guard and the plugin, and described in the deploy README, but not run in CI (GitHub's runners have no nested virtualisation). gVisor is tested in CI (job `sandbox-runsc`): `pnpm test:runner` and `pnpm test:attack` with `runsc`, and the cost (start time, memory) against `runc`.
- **What the tests check under gVisor.** The probes of `test:runner` see gVisor's own kernel and cgroup files: the test checks that the sandbox's kernel is not the Engine's, and checks the limits from outside (`docker inspect`: memory, swap, processes, CPUs, runtime). The host's cgroup holds the whole sandbox, so the kernel still applies the limits.

## 3. Rules and where they live

| Rule | Source | Where |
|---|---|---|
| No provider key, no OpenBao access, no GitHub token in the sandbox | FR-33, FR-50, QUESTIONS #52 | Code: environment allowlist, network layout, guard. Never configurable |
| Branch `agent/INT-…`; never push to the default branch | FR-30, CLAUDE.md | Code: contract schema (ADR-M22), runner refspec (C08) |
| Sandbox egress: LiteLLM and the package proxy | D-03 §9 v1.6 | Runner setting `SDLC_RUNNER_EGRESS_SERVICES`; enforced by the network layout |
| Concurrent sandboxes, default 1 | D-03 §10.1 | Runner setting `SDLC_RUNNER_MAX_SANDBOXES` |
| Sandbox image | QUESTIONS #59 | Project configuration `sandbox.image`, digest required |
| Resource limits, package proxy address | Deployment | Runner settings |
| Contract validity and clock skew | QUESTIONS #33 | Project configuration `run.*` (ADR-M22) |
| Sandbox image registry address | QUESTIONS #54 | Part of `sandbox.image` (project configuration); registry port `SDLC_REGISTRY_HOST_PORT` |
| Package proxy address | QUESTIONS #59 | Runner settings `SDLC_RUNNER_NPM_REGISTRY`, `SDLC_RUNNER_EGRESS_SERVICES` (Compose) |
| Sweep interval | Deployment | Runner setting `SDLC_RUNNER_SWEEP_INTERVAL_SECONDS` |
| Docker endpoints the runner may call | D-03 §13 | Code (`ALLOWED_ENDPOINTS`) and the socket proxy allowlist (Compose), kept equal by a test. Not configurable |
| Sandbox runtime (H06) | Deployment, QUESTIONS #701–#704 | Runner setting `SDLC_RUNNER_SANDBOX_RUNTIME` (`runsc`, `kata` or empty); AuthZ plugin `--require-runtime`. The list of runtimes is code |

C04 adds no handbook threshold. Budget, iteration and loop limits belong to C05 and C11 and are already configuration.

## 4. Alternatives not chosen

| Option | Why not |
|---|---|
| Sandbox pushes to GitHub through an egress proxy with a domain allowlist (Envoy, Squid, Smokescreen) | One more service to run; the agent would hold a write token; Squid is GPL. Not needed once the runner pushes (QUESTIONS #52) |
| One shared sandbox network with inter-container traffic off | LiteLLM and the proxy must be reachable on the same bridge, so traffic cannot be off; runs of two tenants would share a network |
| iptables rules in `DOCKER-USER` | Differ between Docker Desktop and Linux; hard to test on a developer machine |
| tmpfs workspace (ADR-M10) | The Docker archive API cannot write into a tmpfs before the start |
| Clone inside a helper container | That container would need GitHub egress, which the per-run network does not have |
| `dockerode` (Apache-2.0) | A dependency for about fifteen endpoints; less control over errors and the endpoint allowlist |
| GHCR for sandbox images now | Storage quota on GitHub Free (QUESTIONS #54). The option after the GitHub Team upgrade |
| One platform image with every toolchain (QUESTIONS #59 option B) | Larger, not fitted to each project |
| Tecnativa docker-socket-proxy (named in version 0.1 of this ADR) | Opens whole endpoint groups: with containers and POST allowed it also lets `POST /containers/{id}/exec` through, and it cannot refuse bind mounts. wollomatic/socket-proxy allows exact paths per method |
| Copy Node.js from the `node:24` image into the sandbox image | The pinned base already ships Node 24 and corepack; a second copy adds size and a second version to track |

## 5. Consequences

- D-03 version 1.6: §9 sandbox network, §8 `egress_allowlist` example, §8.2 the runner no longer reads the GitHub App key, §10 new containers of the profile `sandbox`, a note on the §4 flow. D-08 version 1.3: C04 AC1 and a C08 note.
- The Run Contract's `egress_allowlist` now names services as `alias:port` (for example `litellm:4000`, `npm-proxy:4873`). C06 fills it from the deployment settings.
- C05 attaches the runner to the run's network to call the Agent Server (the runner runs in Compose from session 3), and passes the virtual key through the Agent Server API.
- C11 kills a run with `teardownSandbox` plus the key and token revocation.
- A10: separate VM or rootless Docker (or `userns-remap`) for the runner's Docker Engine on the server (§2.5).
- C06: the Temporal task queue `sdlc-runner` and the heartbeat activity (QUESTIONS #55).
- R01 / C09: projects on the sample repo use `sandbox.image` = the `node24` image by digest from the local registry.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task C04, session 1) | First version |
| 0.2 | 2026-09-27 | Claude (task C04, session 1 fix) | §2.2: per-run networks set `inhibit_ipv4` (host reachable through the gateway on Linux, found by CI) |
| 0.3 | 2026-09-27 | Claude (task C04, session 2) | §2.3: health check in the image contract; §2.6: Git, work folder, workspace size and readiness settings; §2.8: provisioning order, failure codes, `releaseSandbox`; §2.11: lookup before unwrap, git process hardening, the OpenBao default policy finding |
| 0.4 | 2026-09-27 | Claude (task C04, session 2 review) | §2.3: what goes into the archive: links as link entries only (never read or followed, O_NOFOLLOW, same inode), hard links and special files refused, paths inside the workspace after normalisation (Harry's review of PR #91) |
| 0.5 | 2026-09-27 | Claude (task C04, session 3) | §2.5: wollomatic/socket-proxy with the endpoint allowlist, bind mounts refused, the honest limit (no body inspection) and mitigations; §2.6: sweep, database and heartbeat settings, one process per instance; §2.7: the Temporal handoff moves to C06 (QUESTIONS #55), the slot pool around provisioning; §2.8: workspace reserved before the claim, clean-up at start, sweep, `run_abandoned`; §2.9: image `node24`, build script, local registry on 127.0.0.1, CI job; §2.10: Verdaccio 6.9.3, accepted exfiltration risk, request log |
| 0.6 | 2026-10-09 | Claude (runner fix), approved by Harry | §2.8 restart: the clean-up also removes the `publish-*` folders of a push the old process did not finish (they hold client code); other entries of the work folder stay |
| 0.7 | 2026-10-14 | Claude (task L04, PR 4b), approved by Harry | §2.5: the scoring guard rule for evaluation runs (a fixed command, `NetworkMode: none` for the step that runs the agent's code); `SDLC_RUNNER_MAX_EVAL_SANDBOXES` (§2.6 row) |
| 0.8 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.9 | 2026-10-24 | Claude (task O01), approved by Harry | §2.5: mitigations 1 and 2 are task O01 (ADR-M91), item 3 is task H07 (was: A10, MVP+1) |
| 1.0 | 2026-11-10 | Claude (task H07), approved by Harry | §2.5 item 3: Docker AuthZ plugin built (ADR-M105); shared denylist with the guard |
| 1.1 | 2026-11-13 | Claude (task H06), plan approved by Harry | §2.12: optional gVisor or Kata runtime for the sandbox and scoring containers, rootful Engine in its own VM only, `GET /info` at start, AuthZ `--require-runtime`; §3 row (QUESTIONS #701–#704) |
