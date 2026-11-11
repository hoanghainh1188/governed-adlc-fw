# ADR-M91. The runner on its own Docker Engine

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-24, in the O01 plan; QUESTIONS #576–#580). Version 1.1: §2.7 (Harry, 2026-10-24, O01 PR 2 plan; QUESTIONS #596–#599) |
| Date | 2026-10-24 |
| Decided by | Harry (O01 plan approved on 2026-10-24) |
| Related | D-08 O01 AC1–AC3, H07, A10; D-02 NFR-03; D-03 §10.1, §13; ADR-M25 §2.2, §2.4, §2.5; ADR-M80 §5 gap G-7; ADR-M19 (A11: no OpenBao host port); ADR-M63 (OpenBao TLS); ADR-M35 (telemetry); QUESTIONS #363, #455, #576–#580, #596–#599 |

## 1. Context

The runner controls Docker. It reaches the Docker Engine only through the socket proxy, and the proxy limits the endpoints, not the body of a request (ADR-M25 §2.5, "honest limit"). ADR-M80 gap G-7 (High for the company server) follows: whoever controls the runner process can create a privileged container. QUESTIONS #455 (Harry, 2026-10-13) made a hard condition for the company server: until H07 (an authorization plugin) exists, the first real agent run needs the runner in its own VM or on rootless Docker.

Today the runner, the sandboxes and every platform service share **one** Engine. On that Engine a taken-over runner can do more than create a privileged container. The proxy refuses bind mounts only, so it can also:

- create a container that mounts a named volume of the platform (`postgres-data`, `openbao-data`, the SeaweedFS data);
- connect a container to the platform network `sdlc`;
- inspect every container of the platform.

Rootless Docker alone does not stop this. It changes "root on the host" into "the user that runs the Engine", and that user owns every volume of the Engine.

## 2. Decision

### 2.1. The runner gets its own Docker Engine (QUESTIONS #576)

The runner, the socket proxy and the sandboxes run on a Docker Engine that holds **no platform service and no platform data**. Two ways to host it, with the same Compose file and the same steps:

| Way | Where | When |
|---|---|---|
| A separate VM | A Linux VM next to the platform's server | The company server (recommended) |
| A second Engine on the same server | A rootless Engine of a dedicated user (`sdlc-runner`), next to the platform's Engine | A modest server without a second VM (R041) |

On both, the runner's Engine is **rootless** (§2.4). A privileged container is then root of the user namespace only, on a machine or user that holds only sandboxes.

Nothing in the runner's own protection changes: the endpoint allowlist, the guard (`docker/guard.ts`), the sandbox hardening (ADR-M25 §2.4) and the per-run internal networks (ADR-M25 §2.2) stay as they are. The proxy's allowlist stays equal to `ALLOWED_ENDPOINTS` (R061).

### 2.2. What runs on the runner's Engine

| On the runner's Engine | On the platform's Engine |
|---|---|
| `sdlc-runner`, `docker-socket-proxy` | api, worker, PostgreSQL, OpenBao, Temporal, SeaweedFS, Valkey, LiteLLM, knowledge-db, the observability profile |
| The sandboxes, the tool and gateway containers of a run (ADR-M69, ADR-M87) | |
| `npm-proxy` (Verdaccio): it holds no secret and no client data | |
| One relay per egress service that must stay on the platform: `litellm`, `knowledge-db` | |

- The runner joins each run's network with its own container (ADR-M29 §2.10, `SDLC_RUNNER_SELF_CONTAINER`), and the egress services are containers attached to that network (ADR-M25 §2.2). So the runner and the egress endpoints must be containers of the runner's Engine. A runner that stays with the platform and drives a remote Engine cannot do this.
- **Relays (QUESTIONS #578):** LiteLLM holds the master key and the provider keys; knowledge-db holds a project's documents. Neither may run on the runner's Engine (a container inspect or a volume mount would expose them). A relay is the upstream HAProxy image, pinned by digest, in TCP mode, with **one fixed target** per relay (the service on the platform host, through the link of §2.3), a read-only root, no capability and no volume. It keeps the aliases: the sandbox still reaches `litellm:4000` and nothing else. The egress allowlist does not change.

### 2.3. The link between the two Engines (QUESTIONS #577)

The runner reaches PostgreSQL, OpenBao, Temporal, SeaweedFS (S3), LiteLLM (through its relay), knowledge-db (through its relay) and the local image registry on the platform host.

- **A separate VM:** the two machines talk only through a **WireGuard** tunnel that the infrastructure operator sets up. The platform publishes these ports only on the tunnel address of the platform host (`SDLC_RUNNER_LINK_ADDR`), never on `0.0.0.0` or a LAN address. Plain TCP inside the tunnel is accepted for PostgreSQL, Temporal, SeaweedFS and LiteLLM; OpenBao keeps TLS with certificate verification (R076). TLS on every link is not built now.
- **The same server:** the link address is a host address that only the two Engines use (the platform's Engine publishes on it; the runner's rootless Engine reaches it through RootlessKit). No tunnel is needed.
- **OpenBao's port:** A11 (ADR-M19, QUESTIONS #27) removed OpenBao's host port. The split set-up publishes 8200 again, **only on the link address**, and only when the runner runs on its own Engine. Every other deployment keeps no OpenBao host port.
- The sandbox image and the project images are pushed to the platform's local registry; the runner's Engine pulls them through the link by digest (ADR-M25 §2.9).

### 2.4. A rootless Engine for the runner

The set-up is the same on the server and in CI (`platform/deploy/scripts/test-rootless-docker.sh`):

1. Subordinate user and group IDs for the Engine's user.
2. On Ubuntu 23.10 and later: an AppArmor profile that allows user namespaces for the RootlessKit binary only, never `kernel.apparmor_restrict_unprivileged_userns=0` for the whole machine.
3. cgroup v2 delegation of `cpu cpuset io memory pids` to user services (`user@.service.d/delegate.conf`). Without `cpu`, the Engine accepts the sandbox's CPU limit but cannot apply it.
4. `dockerd-rootless-setuptool.sh install`: the Engine is a systemd user service with the systemd cgroup driver; lingering keeps it running without a login.

The fixture sandbox of `pnpm test:runner` reads its own `memory.max`, `memory.swap.max`, `pids.max`, `cpu.max`, `CapEff` and `NoNewPrivs` from the kernel. An Engine that accepts a limit but does not enforce it therefore fails the test, on every Engine.

### 2.5. Telemetry when split (QUESTIONS #579)

The `otel-collector` has no host port and is never a sandbox egress service (R084). A runner on its own Engine therefore sends no traces: its exporter is off. Its logs stay on its own Engine. A collector on the runner's side can come later.

### 2.6. How it is built and tested

| PR | What | Tests |
|---|---|---|
| PR 1 | This ADR; QUESTIONS #576–#580; the limit and capability probes of the fixture sandbox; the CI job `runner-rootless` | `pnpm test:runner` on a rootless Engine (CI job `runner-rootless`) and on the usual Engine (job `compose`); static: `workspace/ci-workflow.test.ts` |
| PR 2 | The runner-host Compose file, the relays, the link overlay of the platform, a `doctor` check that warns when the runner shares the platform's Engine, the deploy README section, CHANGELOG | Static: the runner-host file has the same proxy and runner definitions as `docker-compose.yml` and no platform service; live `pnpm test:runner-split`: two Engines on one CI machine (the platform's and a rootless one), the runner healthy, egress through the relays, and no platform volume or network on the runner's Engine |

### 2.7. Details of the split set-up (version 1.1, QUESTIONS #596–#599)

- **The runner's definition stays the same.** The runner-host Compose file (`platform/deploy/runner-host/docker-compose.yml`) copies the definitions of `sdlc-runner`, `docker-socket-proxy` and `npm-proxy` from `docker-compose.yml`, including the runner's environment. `extra_hosts` maps `postgres`, `openbao`, `temporal` and `seaweedfs` to `SDLC_RUNNER_LINK_ADDR`, so the link ports equal the ports inside the network (5432, 8200, 7233, 8333). OpenBao's certificate already names `openbao`, so the verification is unchanged. The relays are the services `litellm` and `knowledge-db`, so their container names, and so `SDLC_RUNNER_EGRESS_SERVICES` and `SDLC_RUNNER_TOOL_SERVICES`, stay the same. knowledge-db uses link port 5433, because PostgreSQL already uses 5432. The only differences: `depends_on`, `networks`, `extra_hosts`, `build`, and the proxy's socket path (`SDLC_DOCKER_SOCKET`: a rootless Engine's socket is under `$XDG_RUNTIME_DIR`).
- **The runner's OpenBao login (#596).** `SDLC_RUNNER_SOURCE_CIDR` in the platform's `.env` is the runner host's address as OpenBao sees it: the VM's WireGuard address, or the link address on the same server. `openbao:bootstrap configure` adds it to the `runner` role only (`secret_id_bound_cidrs`, `token_bound_cidrs`). On the same server, any host process that connects from the link address looks like the runner: an accepted limit.
- **The runner's credentials (#597).** With `SDLC_RUNNER_DOCKER_HOST` set, `openbao:bootstrap runner-credentials` runs a `compose run` from the runner-host file against that Engine: the job `runner-approle-init`, which mounts the volume `runner-approle` only (so the delivery creates no other volume of the runner host) and gives the files to the runner's user. The secret ID goes over standard input, never to a host file; the command runs in the owner's terminal (R035).
- **The socket's group.** A rootless Engine maps the host's `docker` group, when one exists, into its namespace, so the socket's group is not always 0. With `SDLC_DOCKER_GID` empty in the runner host's `.env`, `runner-host.sh up` reads it with a throw-away container of the relay image.
- **OpenBao's CA certificate (#598).** The job `openbao-ca-init` copies the CA certificate from `SDLC_OPENBAO_CA_FILE` on the runner host into the runner host's `openbao-ca` volume at every start.
- **Images on a VM (#599).** A registry relay (profile `vm`) listens on the VM's `127.0.0.1:5050` and forwards to the platform's registry on the link address. HTTP mode, `GET` and `HEAD` only. On the same server the rootless Engine reaches `127.0.0.1:5050` directly.

## 3. Rules and where they live

- The runner's Engine holds no platform service and no platform data; the relays have one fixed target each; the link ports are published only on `SDLC_RUNNER_LINK_ADDR` (PR 2, with its rule line in `platform/deploy/CLAUDE.md` and a row in `design/RULES.md`).
- The proxy's allowlist, the guard and the sandbox hardening are unchanged (R061, ADR-M25).

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Rootless Docker for the one shared Engine | The runner can still mount the platform's volumes and join its network (§1). It protects the host, not the platform |
| The runner stays with the platform and drives a remote Engine | The runner joins each run's network with its own container (§2.2); the socket proxy would also need TLS across machines |
| Move LiteLLM and knowledge-db to the runner's Engine | They hold the provider keys and client data; the runner could inspect or mount them |
| TLS on every link instead of WireGuard | PostgreSQL, Temporal and SeaweedFS clients would all need TLS settings and certificates; a tunnel protects every link at once. It can come later |
| `userns-remap` instead of rootless | The Engine still runs as root; rootless also removes a root daemon. Possible for an operator who cannot use rootless |
| An authorization plugin now | That is H07; it checks bodies but does not separate the platform's data from the runner |

## 5. Consequences

- G-7 is mitigated for the company server once PR 2 is deployed: a taken-over runner reaches only sandboxes, on a machine or user without platform data. H07 stays the fix inside the runner's Engine.
- The split set-up has more moving parts: a second Engine, a tunnel (VM), the relays, OpenBao's port on the link address. The deploy README and `doctor` describe and check them.
- Developer machines and the trial keep the single Engine (`TRIAL.md` already says a trial exposes the machine's Docker).
- CI runs `pnpm test:runner` twice (normal and rootless Engine): a few more Actions minutes per pull request that changes the runner or the deployment.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-24 | Claude (task O01), accepted by Harry | First version (QUESTIONS #576–#580) |
| 1.1 | 2026-10-24 | Claude (task O01 PR 2), accepted by Harry | §2.7: the runner's OpenBao login, credentials and CA certificate on its own Engine, the registry relay (QUESTIONS #596–#599) |
