# ADR-M63. OpenBao TLS everywhere, and backups

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task A10) |
| Date | 2026-10-09 |
| Decided by | Harry (A10 plans approved 2026-10-09, with answers to QUESTIONS #325–#329) |
| Related | D-08 task A10 (AC1–AC3); D-03 §10.2 (backups, drills); D-03 §8.2, §9 (TLS for internal services); QUESTIONS #20 (the internal CA), #27 (no host port), #67 (plain HTTP until A10), #325–#330; ADR-M53 §2.3 (§6 supersedes part); ADR-M19 §2.5, §3; ADR-M21 §2.4 (the client always verifies); runbook T11 section 3c |

## 1. Context

- QUESTIONS #20 decided TLS on OpenBao's listener 8200 with a company internal CA: server certificate 1 year, CA 5 years, the CA key offline, the operator renews 30 days before the end, clients always verify. Listener 8210 (key holders, inside the container only) stays plain.
- Until A10 every platform process talked to OpenBao over plain HTTP on the Compose network, with `SDLC_OPENBAO_ALLOW_PLAINTEXT=1` (QUESTIONS #67). The client library `@sdlc/secrets` already verifies a CA and refuses `http://` without that flag (ADR-M21 §2.4).
- The `openbao` image runs as uid 100 (gid 1000), the platform processes as `node` (uid 1000). A host file with mode 600, owned by the operator, cannot be read by either on Linux.

## 2. Decision

### 2.1. TLS everywhere (QUESTIONS #325)

- **Development machines, CI and the server all run TLS on 8200.** There is no plain listener on the Compose network and no `SDLC_OPENBAO_ALLOW_PLAINTEXT` in the compose file (a static test fails if one comes back). One configuration, so CI tests the server's path.
- Development machines and tests use a **throw-away CA**: `pnpm compose:env` (`init-env.sh`) runs `openbao/tls.sh dev`, which makes a CA and a server certificate (EC P-256, 825 days) next to the env file (`openbao-tls/`, Git-ignored) and **deletes the CA key at once**. Every live test's env file gets its own CA.
- The server uses the **company internal CA** (QUESTIONS #20): `pnpm openbao:tls ca <folder>` makes the CA (5 years) in a folder outside the repository that goes offline with the key shares; `pnpm openbao:tls server <folder>` issues the server certificate (1 year). The CA key never enters the certificate folder.
- The certificate names `openbao` and `127.0.0.1` (the admin commands inside the container go through TLS too).

### 2.2. How the files reach the containers

- The env file names the certificate folder: `SDLC_OPENBAO_TLS_DIR`, an absolute path (`ca.pem`, `server.pem`, `server-key.pem` with mode 600).
- A one-shot job **`openbao-tls-init`** (the OpenBao image, as root, no network) copies the files into two named volumes at every start: **`openbao-tls`** (key and certificate, owner `openbao`, key mode 600) and **`openbao-ca`** (the CA certificate, mode 644). `openbao` starts only after the job succeeded; a missing file fails the job (fail closed).
- Every client mounts `openbao-ca` read-only: `sdlc-api`, `sdlc-worker`, `sdlc-runner` (`SDLC_OPENBAO_ADDR=https://openbao:8200`, `SDLC_OPENBAO_CA_CERT_FILE`), `litellm-agent` (`BAO_CACERT`), and `openbao` itself for its admin commands.
- No host file is bind-mounted into OpenBao or a client, so host file owners and modes never matter, on Linux and on Docker Desktop.

### 2.3. Health, renewal and checks

- OpenBao's health check runs `bao status` over TLS with the CA: exit 0 (unsealed) or 2 (sealed or uninitialised) is healthy; a bad or untrusted certificate is unhealthy. `bootstrap.sh status` reads the seal status on the in-container listener 8210.
- **Renewal without unsealing again:** `pnpm openbao:tls server <ca-folder>`, then `pnpm openbao:tls reload` (runs `openbao-tls-init` again and sends SIGHUP; OpenBao reads the new certificate and stays unsealed). Clients read the CA when they start: restart them only when `ca.pem` changed (a new CA).
- `pnpm openbao:tls check` shows when the CA and the certificate end and fails within 30 days of the end; `up.sh` runs it and prints a warning, never blocks.
- Existing development stacks: `pnpm openbao:tls dev` adds a throw-away CA and the variable to an existing `.env`; OpenBao's data stays.

## 5. Backups and the restore drill (PR 2)

- **One command, `pnpm backup`** (`platform/deploy/backup/backup.sh`), one folder per run in `SDLC_BACKUP_DIR` (QUESTIONS #327: a target folder the operator chooses, outside the repository; copying it further away is the infrastructure's job):
  - every database (`pg_dumpall --clean --if-exists`, online);
  - OpenBao's Raft snapshot, taken by the one-shot service **`backup-agent`** (profile `backup`, never started by `up.sh`, hardened, user openbao) with the **AppRole `backup`**, whose policy reads only `sys/storage/raft/snapshot` (QUESTIONS #328): unattended, and the snapshot is useless without two key shares;
  - the volumes `seaweedfs-data`, `openbao-audit` and `clickhouse-data` (when it exists), copied with SeaweedFS and ClickHouse **stopped for about a minute**, then started again and waited for (QUESTIONS #329: a consistent copy at night);
  - the env file (the passwords a restore needs) and OpenBao's TLS folder;
  - `MANIFEST`: SHA-256 and size of every file, the commit, the images; no secret.
- **Encryption with age** (QUESTIONS #326), public key only: every part is encrypted as it streams, so no unencrypted copy touches a disk, and the server cannot read its own backups. The private key stays offline with the key shares. A folder appears only when every part is done; `SDLC_BACKUP_KEEP` (14) folders are kept.
- **The schedule is the server's**: a systemd timer example (`sdlc-backup.service`, `.timer`, 02:30) or cron (QUESTIONS #329). The platform never schedules or deletes its own backups, and backups run when the platform is down.
- **`pnpm restore <folder> <age key>`** (`restore.sh`) restores into an **empty** stack only: it checks `MANIFEST` first, writes the env file and TLS folder, fills the volumes, loads the databases (the superuser's own role lines left out), initialises OpenBao with a throw-away key kept in the process, restores the snapshot over it, and leaves OpenBao **sealed with the original keys** for two key holders. The AppRole volumes are not backed up: the credentials commands run again.
- `pnpm test:backup` (CI `compose` job) runs the whole drill on throw-away keys: data in every store, the backup, the loss, a tampered copy refused, the restore, the original shares, every piece of data back.

## 3. Consequences

- One more one-shot job (`openbao-tls-init`) in `up.sh` and two small volumes.
- Every OpenBao live test reaches OpenBao over TLS with the project's CA (`throwaway-compose.ts`); tests that reach it by IP from the host map the name `openbao` to the IP (`--add-host`).
- OpenSSL 3 or later is needed on the host (already a requirement; LibreSSL is refused).
- Open (A10 PR 3b, with the operator): the real CA and key holders on the server, the first drill there, the resource measurement and the runner's own Engine. PR 3a prepared them: §7 and runbook T11 §3.3.
- A backup stops SeaweedFS and ClickHouse for about a minute: an evidence write or a trace in that minute fails and is retried by its caller.

## 4. Rejected

- **TLS only on the server** (a compose overlay): two configurations, and CI would test the plain one.
- **Bind-mounting the host files**: needs host modes the container users can read (a key readable by others, or a group change on the host).
- **The health check on the plain listener 8210**: it could not see a bad certificate on 8200.

## 6. ClickHouse: no user manages users over the network

- **Context.** E08 gave ClickHouse's user `langfuse` access management (`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`, ADR-M53 §2.3) so the bootstrap could make `sdlc_purge`. `langfuse` is the user Langfuse connects with over the Compose network, so Langfuse, or anyone with its password, could create ClickHouse users and grants (MVP-DONE §5, before the real server).
- **Decision** (Harry, 2026-10-09, QUESTIONS #330):
  - `langfuse` has no access management: the setting is gone from the compose file.
  - A second user, **`sdlc_admin`**, is declared in `platform/deploy/clickhouse/sdlc-admin.xml` (mounted read-only into `users.d/`): no password, **loopback only** (`::1`, `127.0.0.1`), so only `clickhouse-client` inside the container reaches it (`docker compose exec clickhouse`).
  - Its grants are exactly: create, change and drop users; show users; `ALTER DELETE` on `default.events_full` and `default.events_core` with grant option. It reads no data, cannot grant anything else, and cannot make another user that manages users (checked live on ClickHouse 26.3.39.7).
  - `openbao:bootstrap worker-langfuse-credentials` makes and checks `sdlc_purge` as `sdlc_admin`; the SQL still goes on stdin.
- **Consequences.** An `sdlc_purge` made before stays (ClickHouse keeps it in its volume); a restart of ClickHouse applies the change. Whoever can run `docker compose exec` on the server can still manage these users, as before. `pnpm test:observability` checks over the network that `langfuse` cannot create a user and `sdlc_admin` cannot sign in; a static test checks the file (loopback only, the exact grants, no double hyphen in a comment: ClickHouse refuses to start on it).

## 7. Preparing the first deployment: the rekey command and the measurement (PR 3a)

- **Context.** Runbook T11 §8.3 gave `bao operator rekey` by hand and said it was not tested. D-08 A10 AC4 asks for a resource measurement on the server, and the repository had no tool for it. Both are needed on the day of the first deployment (QUESTIONS #756–#760).
- **`pnpm openbao:bootstrap rekey`.**
  - It uses the key-share endpoints `sys/rekey/*` on the key-holder listener inside the container, without a token, like `root-token` (ADR-M19): `bao operator rekey` asks for each share at its own prompt.
  - **Always with `require_verification`.** OpenBao gives the new shares but keeps the old ones until two new shares came back. A share that was copied wrongly, or that its holder cannot decrypt, therefore locks nobody out. A wrong answer, an empty answer, Ctrl-C or a closed terminal drops the rekey; `rekey --cancel` drops one that a killed run left open, and a new run never drops another run's rekey. After every stop the command reads the state from OpenBao before it says anything: "unchanged" only when OpenBao confirmed the drop; when the check may have passed while the answer was lost, it says to keep both sets of shares.
  - `--pgp-keys=<file>,<file>,<file>` encrypts each new share for its holder, as `pnpm server:setup` does at `init` (ADR-M98). The share counts stay those of `bootstrap.conf`.
  - Shares travel on stdin only. The new shares go to a terminal only (R035; the Claude Code hook refuses the command).
  - **Not tested with real PGP keys**: the tests have no OpenPGP tool. The verification makes a failure there harmless; the drill on the test machine checks it (T11 §3.3).
  - A backup made before a rekey restores a snapshot that needs the **old** shares (T11 §8.3 step 8).
- **`pnpm measure`.** A shell script that samples `docker stats` for the project's containers and prints the mean and the peak per service and for all, the images in use and the project's volumes, as Markdown. It only reads (`docker info`, `ps`, `stats`, `image inspect`, `volume ls`, `system df`), prints numbers and names, and writes no file. It is not a `doctor` check: `doctor` answers at once and judges; a measurement takes a minute and judges nothing. `--all` measures the runner's own Engine, where sandboxes are not Compose services.
- **Rejected.** A rekey without verification (one miscopied share would only show at the next unseal). A rekey inside `pnpm server:setup` (a rare operation; the command stays small). A measurement inside `doctor` (above). Prometheus or cAdvisor for one table (R041: the heavy observability stack is optional).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-09 | Claude Code (task A10, PR 1) | TLS everywhere, the throw-away CA on development machines and in CI, `openbao-tls-init`, renewal by SIGHUP, `tls.sh` |
| 0.2 | 2026-10-09 | Claude Code (task A10, PR 2) | §5: backups and the restore drill (QUESTIONS #326–#329) |
| 0.3 | 2026-10-09 | Claude Code (task A10) | §6: ClickHouse access management moves from `langfuse` to the loopback-only `sdlc_admin` (QUESTIONS #330; supersedes part of ADR-M53 §2.3) |
| 0.4 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.5 | 2026-11-21 | Claude Code (task A10, PR 3a), for Harry's approval | §7: `openbao:bootstrap rekey` with verification and PGP keys, `pnpm measure` (QUESTIONS #756–#760) |
