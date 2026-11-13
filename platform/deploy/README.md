# Platform deployment and operations (Docker Compose)

This folder runs the infrastructure that the platform reuses, on one server, with Docker Compose (D-03 section 10, task A02). Image versions, licences and trade-offs: [ADR-M17](../../design/ADR-M17-compose-infrastructure.md).

## Profiles

| Profile | Services | When to use |
|---|---|---|
| `core` | PostgreSQL, Temporal (+ Temporal UI), LiteLLM, Valkey, SeaweedFS (S3 API), OpenBao | Always. Required by the platform |
| `observability` | Langfuse (web + worker), ClickHouse, the OpenTelemetry Collector (A08). Reuses PostgreSQL, Valkey and SeaweedFS | Optional. The heaviest part; enable it when the server has room (D-03 section 10.1) |
| `models` | `litellm-agent`: a sidecar (a helper container next to LiteLLM) that reads LiteLLM's model provider keys, master key and salt key from OpenBao and writes its configuration ([ADR-M24](../../design/ADR-M24-litellm-cost-controller.md)) | **Always on the server** (`pnpm compose:models`). Needs OpenBao unsealed and configured and the sidecar's credentials (runbook T11 §5d). Without it, LiteLLM has no models and uses the development keys from `.env` |
| `platform` | `sdlc-api`: the REST API and the dashboard ([ADR-M26](../../design/ADR-M26-api-app.md)); `sdlc-worker`: the GitHub poller, the intent workflow, the escalation clocks and the retention loop ([ADR-M27](../../design/ADR-M27-github-poller.md), [ADR-M30](../../design/ADR-M30-intent-workflow.md)). Both built from this repository | With `core` (`pnpm compose:platform`). Needs OpenBao unsealed and configured, `pnpm openbao:bootstrap api-credentials` and `worker-credentials` first, and the GitHub App key stored (runbook T11 §5b, §5e, §5f) |
| `knowledge` | `knowledge-db`: a PostgreSQL with pgvector of its own for the index of project documents, the first register tool ([ADR-M89](../../design/ADR-M89-project-docs-index.md)). Never the platform's database; no host port | Optional (`pnpm compose:knowledge`). Needed only by plans with a `read_documents` tool. Then `pnpm openbao:bootstrap worker-knowledge-credentials` (runbook T11 §5o) and restart `sdlc-worker` |
| `models-local` | `vllm`: a self-hosted model service (vLLM) on the server's GPU, reached only by LiteLLM ([ADR-M71](../../design/ADR-M71-self-hosted-model-vllm.md)). One-shot `vllm-pull` (profile `models-local-pull`) downloads the weights once | Optional, **only on a server with an NVIDIA GPU** (`pnpm compose:models-local`). Needs the profile `models`, the weights (`pnpm models-local:pull`) and the provider entry `vllm` (runbook T11 §5d.1). See [Self-hosted model](#self-hosted-model-operator) |
| `models-remote` | `vllm-link`: an nginx link that LiteLLM calls as `vllm`, to vLLM on a **separate GPU host** with mutual TLS ([ADR-M71 §4](../../design/ADR-M71-self-hosted-model-vllm.md)). One-shot `vllm-link-tls-init` copies its certificate | Optional, only when vLLM runs on another machine (`pnpm compose:models-remote`). Never with `models-local`. Needs the GPU host (`gpu-host/docker-compose.yml`), the certificates (`pnpm gpu-link:tls`) and the provider entry `vllm`. See [Self-hosted model on a separate GPU host](#self-hosted-model-on-a-separate-gpu-host-operator) |
| `sandbox` | `sdlc-runner` (built from this repository; runs the agent sandboxes), `docker-socket-proxy` (the runner's only way to Docker), `npm-proxy` (Verdaccio: npm packages for the sandboxes), `registry` (sandbox images, 127.0.0.1 only) ([ADR-M25](../../design/ADR-M25-runner-sandbox.md)) | With `core` (`pnpm compose:sandbox`). Needs OpenBao unsealed and configured, `SDLC_DOCKER_GID` right and `pnpm openbao:bootstrap runner-credentials` first (runbook T11 §5g) |
| `runner-link` | `registry` only, with the overlay `docker-compose.runner-link.yml` that publishes the runner's link ports on `SDLC_RUNNER_LINK_ADDR` (O01, [ADR-M91](../../design/ADR-M91-runner-own-engine.md)) | On the server, instead of `sandbox`, when the runner runs on its own Engine (`pnpm compose:runner-link`). See [The runner on its own Docker Engine](#the-runner-on-its-own-docker-engine-operator) |

Three one-shot jobs run at every start and then exit: `temporal-schema` (creates or upgrades the Temporal schemas), `temporal-namespace` (creates the namespace) and `seaweedfs-init` (creates the `evidence` and `langfuse` buckets). All three are safe to re-run.

## Requirements

- Docker Engine with Docker Compose v2.24 or later.
- OpenSSL 3 or later as `openssl` on the `PATH` (for `init-env.sh`, OpenBao's TLS certificates and the TLS tests of `@sdlc/secrets`). On macOS, `/usr/bin/openssl` is LibreSSL, and the TLS tests stop with a message when they find it: install OpenSSL 3 (`brew install openssl@3`) and put it first (`export PATH="$(brew --prefix openssl@3)/bin:$PATH"`).
- Node.js 24 + pnpm 10 (`corepack enable` once). The fresh deployment below needs them (`pnpm install`, `pnpm openbao:bootstrap`, `pnpm db:migrate`, `pnpm adlc ops …`), and so do the `pnpm` shortcuts and the tests. Only starting and stopping the containers works without them (`init-env.sh`, `up.sh`).

## Where to run it

[Proposal] Recommended until task A10 measures and hardens the target server:

| Item | Recommendation |
|---|---|
| Host | One internal Linux server (or VM) with Docker Engine and Docker Compose. Docker Desktop on a laptop is for development and the trial only |
| Network | Outbound HTTPS only: to GitHub, the model providers, the npm registry and the image registries ([Network and data flows](#network-and-data-flows)). No inbound connection from the internet: the platform polls GitHub and needs no webhook |
| Size | See [Resource estimate](#resource-estimate): about 3 GiB RAM and 2 vCPU for `core`, 6 GiB and 4 vCPU with `observability`, plus up to 2 GiB per running sandbox. Estimates only, not measured on a server yet (A10) |
| GPU | Not needed with API models. Only for a self-hosted model on the same machine (D-07 §3): the profile `models-local`, an NVIDIA GPU with the NVIDIA Container Toolkit ([Self-hosted model](#self-hosted-model-operator)) |
| Sandboxes | 1 by default (`SDLC_RUNNER_MAX_SANDBOXES`); 2 on a larger server. Evaluation runs use free slots only, at most `SDLC_RUNNER_MAX_EVAL_SANDBOXES` (default 1, never above the line before; 0 turns them off) and give a slot back to a real run that waits |
| The runner | On its own Docker Engine, rootless: a separate VM or a second Engine of the user `sdlc-runner`, because it controls Docker (ADR-M91). See [The runner on its own Docker Engine](#the-runner-on-its-own-docker-engine-operator) |
| OpenBao | TLS on port 8200 runs everywhere (A10); on the server the certificate comes from the company CA ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). Three named key holders before any real secret or client data (runbook T11 §3.2): not yet done (A10) |
| Backups | Off the server, encrypted ([Backup and restore](#backup-and-restore)) |

**Access from other machines** (team access, V09): the API and the dashboard listen on `127.0.0.1:8090` of the server. People on other machines reach them only through the TLS proxy of the profile `access`, on one LAN port: see [Team access (operator)](#team-access-operator). Comment commands and reviews on GitHub work from anywhere.

## Create the GitHub App (operator)

The platform reaches each project's repository through one **GitHub App** per installation of the platform (`design/ADR-M23-github-adapter.md` §2.2). The operator creates it once, in the browser, and installs it on every project repository. Never let a chat tool or an AI session handle the private key.

### Option A: from the manifest (recommended)

`platform/deploy/github-app/manifest.json` holds the App's settings: exactly the permissions of [The GitHub App's settings](#github-app-permissions), webhook off, installable only on your own account (D-08 V03). Run, **yourself, in a terminal** (never through a chat tool):

```bash
pnpm github-app:create --out ~/secrets/sdlc-app.private-key.pem
```

- Add `--org <organization>` to create the App in an organization you administer, `--name <name>` to choose its name (default `sdlc-<random>`, at most 34 characters), `--callback-url <url>` (repeat it, at most 10) for the dashboard's sign-in callbacks (default `http://localhost:8090/v1/auth/github/callback`; `https://…/v1/auth/github/callback` for another origin), `--force` to replace existing files.
- It prints a local page (`http://127.0.0.1:<port>/`). Open it in the browser where you are signed in to GitHub and press the button; GitHub shows the App with its permissions; confirm with **Create GitHub App**. GitHub sends the browser back to `127.0.0.1`, and the command finishes the App (`POST /app-manifests/{code}/conversions`).
- It saves the private key to `--out` and the App's **client secret** to `<--out>.client-secret`, both with mode 600 (never inside the repository, never over an existing file without `--force`), and prints only the App ID, the **Client ID** (`Iv…`, not a secret), the file names and the install link. Neither secret is printed. The client secret is only for the dashboard's GitHub sign-in (U05, `design/ADR-M73-dashboard-actions.md` §2.2): store it in OpenBao ([Fresh deployment, step 7](#7-start-the-platform)), then delete the file. GitHub also returns a webhook secret: the platform uses no webhook, so it is dropped at once (`design/QUESTIONS.md` #351).
- If the browser cannot open `127.0.0.1` after GitHub (a remote desktop, a browser on another machine), copy the whole address from the browser's address bar and paste it at the command's hidden prompt (QUESTIONS #350). The code from GitHub works once, within one hour; the command waits at most 15 minutes.
- Then **install** the App with the printed link: "Only select repositories", the project's application repository (step 6 below).

### Option B: by hand (the fallback)

1. Open the App settings of the account or organization that owns the project repositories: Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Fill in the form:

   | Field | Value |
   |---|---|
   | GitHub App name | A name of your own, for example `<company>-sdlc` |
   | Homepage URL | Any URL (for example this repository) |
   | Callback URL | `http://localhost:8090/v1/auth/github/callback` for the dashboard's GitHub sign-in (U05); add `https://<host>/v1/auth/github/callback` for another origin. Keep **Expire user authorization tokens** on and **Request user authorization (OAuth) during installation** off |
   | Webhook → Active | **Off** (the platform polls GitHub) |
   | Where can this App be installed | Only on this account |

3. Set the repository permissions exactly as listed in [The GitHub App's settings](#github-app-permissions); everything else "No access".
4. Note the **Client ID** (`Iv…`). It is not a secret. For the dashboard's GitHub sign-in, also **generate a client secret** and store it at once with `pnpm openbao:bootstrap api-github-oauth-credentials` (hidden prompt; [Fresh deployment, step 7](#7-start-the-platform)); never paste it anywhere else.
5. Generate a **private key** and move the file out of Downloads, outside every repository, readable only by you (`chmod 600`). It goes into OpenBao in [Fresh deployment, step 4](#4-shared-secrets) and nowhere else.
6. **Install** the App on the account: "Only select repositories", the project's application repository. Add a repository later in the same place when a second project joins ([ROLLOUT-GUIDE step 2](../ROLLOUT-GUIDE.md#step-2-set-up-the-platform-for-the-project-operator-tenant-admin-pm--brse-about-1-day)).
7. After a later permission change, accept it on the installation, or tokens keep the old permissions.

The development machine uses a separate **test App** on the fictional sample repository ([GETTING-STARTED Step 11](../GETTING-STARTED.md#step-11-create-the-github-app-devtest)); never reuse a production App there.

## Fresh deployment (operator)

How to bring up the whole platform on a new machine with Docker Compose, from an empty checkout to the first intent at G1 (D-08 E07 AC3). Run every step **yourself, in a terminal, from the repo root**. Several steps print or ask for key shares, tokens or keys at a hidden prompt: never run them through a chat tool, and never paste their output anywhere except your password manager. `pnpm test:fresh-deploy` runs the same steps on a throw-away Compose project with throw-away keys, steps 2–13 through `pnpm server:setup`'s code (section [Tests](#tests)).

**On a server: `pnpm server:setup --settings <file>` runs steps 2–7, and with the settings of steps 8–13 those too, for you** (D-08 V16, V19, [ADR-M98](../../design/ADR-M98-server-setup.md), runbook [T11 §3.2](../../handbook/03-templates/T11-openbao-runbook.md#32-on-the-internal-server-real-keys)). Copy [`server-setup/server-settings.example.yaml`](server-setup/server-settings.example.yaml) outside the repository and fill it in: the three key holders (with their PGP public keys, the default), the GitHub App, the model providers and the optional parts of step 7. Run it in a terminal on the server, with the key holders present; it refuses to run with its output or input redirected. What it does differently from the steps below:

- `init` encrypts each key share with its holder's PGP key (`-pgp-keys`), so the command never sees a share in clear. Without PGP keys it shows the shares one holder at a time, and after each holder confirms the copy it clears the screen and the scroll-back. Nothing is written to a file.
- The root token is used only for `configure`, which revokes it and hands the command one admin token for steps 4, 5 and 7, revoked at the end. A stop before `configure` (Ctrl-C, an error) revokes the root token. No token goes into an environment variable, a command line or a log.
- Step 4 reads each secret from a file named in the settings or at a hidden prompt; the LiteLLM master and salt keys are made inside the container. Step 6 builds the database URL from `.env` and gives it to the migrations on standard input.
- A new `.env` stops the command after step 2, so OpenBao's certificate comes from the company CA first ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)); then run it again.
- It can start again after a failure: each step checks the state (OpenBao initialised or sealed, the credentials delivered, pending migrations; `server-setup-progress.json` next to `.env` holds step names only) and skips what is done. A failure names the step and its section below. A new start says where the last one stopped. It ends with `pnpm doctor`.
- With an `access` section (D-08 V20), it also does [Team access](#team-access-operator) steps 2–4: it writes the `SDLC_ACCESS_*` keys and `SDLC_API_TRUSTED_PROXY` in step 2, imports the company CA's certificate for the proxy (`access:tls import`) and starts the profile `access` in step 7. With the dashboard sign-in, the public origin is the proxy's.
- With a `runner_link` section (V20), it also does the platform host's part of [The runner on its own Docker Engine](#the-runner-on-its-own-docker-engine-operator), steps 3, 4 and 6: it writes `SDLC_RUNNER_SOURCE_CIDR`, `SDLC_RUNNER_LINK_ADDR` and `SDLC_RUNNER_DOCKER_HOST` in step 2, before `configure`, so the key holders meet once; step 5 delivers the runner's credentials to the runner host; step 7 starts the profile `runner-link` instead of `sandbox`. Set up the runner host first (its steps 1, 2 and 5); start the runner there at the end (its step 7).
- A key that `.env` already sets to another value than the settings is refused, never overwritten.
- With `tenant`, `admin`, `project_file` and `sandbox_image` (D-08 V19), it goes on with steps 8–13:
  - Step 8: `adlc ops bootstrap`, with the database URL on standard input (`--db-url-stdin`). It shows the admin's token once, clears the screen and the scroll-back after you copy it, then logs you in with it (`adlc login --token-stdin`).
  - Steps 9–12: `adlc admin project apply` with the [project file](#9-the-project-and-its-team) (V17) and `sandbox_image` (step 10, by digest) as `sandbox.image`. It shows each person's numeric GitHub ID, and changes nothing until you confirm.
  - Step 13: with `ai_record` in the settings, `adlc ops ai-record set` on behalf of Person A (QUESTIONS #671).
  - It never approves the agent, never issues a team member's token and never creates an intent. At the end it prints, per person, the commands that stay theirs: the first tokens, the agent's two approvals (the owner and Person B), and step 14 for Person A.

Still by hand: the company CA certificate, the GitHub App, the runner host (one command on that host, `runner-host-setup.sh`, V18: [The runner on its own Docker Engine](#the-runner-on-its-own-docker-engine-operator), step 1), the sandbox image of step 10, and step 14. `pnpm test:fresh-deploy` runs steps 2–13 through the same code.

**Trying the platform on a developer machine (the community trial)?** `pnpm trial:up --settings <file>` runs steps 2–13 below for you with throw-away keys, on its own Compose project `sdlc-trial` ([TRIAL.md §3.2](../../TRIAL.md#32-the-platform), D-08 V02); after a reboot, `pnpm trial:start` unseals it with the key shares it keeps encrypted with your passphrase (V08). Never on a server.

**A release checkout uses the published images.** On a checkout of a release tag (`git checkout vX.Y.Z`, for example `v0.2.0`, no local change), `up.sh` and `trial:up` pull the release's images from GHCR, pinned by digest in the release's `images.lock`, instead of building them; step 10 takes the sandbox image from there too. From the release after v0.6.0, `images.lock` is an asset of the release's GitHub Release, not a file in the commit: the first `pnpm images mode` on the checkout downloads it once over HTTPS into `platform/deploy/.images/vX.Y.Z.lock` (ignored by Git; the repository is public, so no token). The release is immutable, so the file never changes. A machine without access to `github.com` downloads `images.lock` from the release page elsewhere and sets `SDLC_IMAGES_LOCK=<file>`. If the download fails, `up.sh` and `trial:up` stop with an error that names both ways out; they never build the images silently instead. `pnpm images mode` prints `published` or `local` (`SDLC_IMAGES=local` builds anyway). A source archive without `.git` builds locally unless you set `SDLC_IMAGES=published`, and only for the archive of a release tag. Check them first: [Verify the published images](#verify-the-published-images). Anywhere else (`main`, a branch) every image is built locally (D-08 V04, V15, `design/ADR-M94-release-on-the-tag.md`). Tags v0.6.0 and before keep their `platform/deploy/images.lock` in the commit.

After the first deployment: [Restart after a reboot](#restart-after-a-reboot), [Upgrade](#upgrade), [Troubleshooting](#troubleshooting). Use [Step 14](../GETTING-STARTED.md#step-14-prepare-the-pilot-repo-for-live-tests-dev) for the live tests on the pilot repository.

### 1. Prerequisites

- The [Requirements](#requirements) above (Docker Compose v2.24+, Node.js 24, pnpm 10 with `corepack enable`, OpenSSL 3).
- A GitHub App installed on the project's repository only, and its private key in a file outside the repo. The App's settings are below; how to create one, step by step: [Create the GitHub App](#create-the-github-app-operator).
- On a team server: everything in **Before you start on a server** below. The procedure and `pnpm server:setup` are ready for a server. What a server needs first is people and certificates: until you have them, use this procedure on a development machine, with throw-away keys only.

<a id="before-you-start-on-a-server"></a>**Before you start on a server.** Have all of these before step 2; most of them take other people's time.

| Item | Who | Why |
|---|---|---|
| A Linux server with Docker Compose v2.24+ ([Where to run it](#where-to-run-it)) | Infrastructure operator | The platform's Engine |
| **Three key holders**, each with a PGP public key, present when OpenBao starts (steps 3 and 5) | Leadership names them; runbook [T11 §3.2](../../handbook/03-templates/T11-openbao-runbook.md#32-on-the-internal-server-real-keys) | Two of the three key shares unseal OpenBao; the PGP keys keep each share encrypted |
| **OpenBao's certificate from the company CA**, before step 3 | Infrastructure operator; [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal) | `server:setup` stops after step 2 until it is in place |
| The host name people will use (team access, the dashboard's passkeys), chosen **before** you create the GitHub App | Operator | The App's callback URL and a passkey belong to that address ([Team access](#team-access-operator)) |
| A GitHub App on the project's repository, and a model provider key or a local model | Operator | Steps 4 and 9 |
| A Linux VM, or a second rootless Engine on the server, for the runner, and the link between the two | Infrastructure operator | Required before the first real agent run ([The runner on its own Docker Engine](#the-runner-on-its-own-docker-engine-operator)) |
| Person A and Person B for the project, never the same person | Leadership | Separation of duties (2+N); `adlc admin project apply` refuses one person in both roles |
| An encrypted backup target outside the server | Operator | [Backup and restore](#backup-and-restore) |

**The runner's Engine and the key holders.** With `pnpm server:setup`, put the runner host in the settings' `runner_link` section: the command does what this paragraph says. By hand: to keep the key holders to one meeting, put `SDLC_RUNNER_SOURCE_CIDR` (the runner host's address as OpenBao sees it, for example `10.66.0.2/32`) in `platform/deploy/.env` after step 2 and before step 3: `configure` then already accepts it, and the runner section's own `configure` is not needed. Set `SDLC_RUNNER_LINK_ADDR` and `SDLC_RUNNER_DOCKER_HOST` only after `server:setup` has finished, because its step 7 starts the profile `sandbox`, which `up.sh` refuses while `SDLC_RUNNER_LINK_ADDR` is set.
- `pnpm install` and `pnpm build`.

<a id="github-app-permissions"></a>**The GitHub App's settings.** This is the one list of the App's permissions; other documents link here. One App per installation of the platform (`design/ADR-M23-github-adapter.md` §2.2).

| Permission (repository) | Level | Used for |
|---|---|---|
| Contents | Read and write | Clone, read specs and plans; the runner pushes `agent/INT-…` branches (C08) |
| Issues | Read and write | Read comment commands, post status comments and replies |
| Pull requests | Read and write | Open the pull request (C08), read reviews and their feedback (E01) |
| Code scanning alerts | Read-only | Security findings at G6 (C08, QUESTIONS #157) |
| Checks | Read-only | CI results at G6 |
| Commit statuses | Read-only | CI results at G6 |
| Metadata | Read-only | Automatic |

- Everything else "No access"; no organization or account permissions.
- Webhook: **off** (the platform polls GitHub, ADR-M11). Installable only on your own account or organization.
- Install it on **selected repositories** only: the project's application repository.
- After a permission change, accept it on each installation (GitHub asks the owner), or tokens keep the old permissions.

### 2. Settings file

```bash
pnpm compose:env
```

It creates `platform/deploy/.env` with random passwords (mode 600, never overwritten). It also makes a throw-away CA and OpenBao's TLS certificate in `platform/deploy/openbao-tls/` (Git-ignored; the CA key is deleted at once) and sets `SDLC_OPENBAO_TLS_DIR`. On the server, replace them with the company CA's certificate before step 3: `pnpm openbao:tls ca <offline folder>`, then `pnpm openbao:tls server <offline folder>` ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). It also fills `SDLC_DOCKER_GID`, the group ID of the Docker socket: check it on the server (runbook T11 §5g). On the server, leave `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` empty (runbook T11 §5d).

### 3. OpenBao

Start only OpenBao, PostgreSQL and SeaweedFS (the credentials commands of step 5 create SeaweedFS identities). The whole `core` profile cannot be healthy yet: on the server, LiteLLM gets its keys from OpenBao (profile `models`, step 7), and `.env` holds none.

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap init       # 3 key shares and a root token, printed ONCE to the terminal
pnpm openbao:bootstrap unseal     # 2 shares at the hidden prompt
pnpm openbao:bootstrap configure  # root token at the hidden prompt; KV, Transit, every AppRole
```

KV is OpenBao's key-value store for secrets; Transit signs the Run Contracts; an AppRole is a login for one platform process (a role ID plus a secret ID that expires).

Details and key custody: runbook T11 §3 and §4. `configure` revokes the root token, so make a new one from two shares, then an admin token for the next two steps (T11 §5.1):

```bash
pnpm openbao:bootstrap root-token
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token create -role=platform-admin -field=token'
```

The admin token lives one hour and cannot be renewed: do steps 4 and 5 in one go, and make a new token when a command answers `permission denied`. On a development machine, GETTING-STARTED Step 11b has every command of steps 3–7 with its check.

### 4. Shared secrets

With the admin token, store (runbook T11 §5b and §5d; each value is read at a hidden prompt or from a file, never typed into a command line):

- the GitHub App's `client_id` and `private_key` at `kv/shared/github-app` (T11 §5b);
- the LiteLLM master key at `kv/cost-controller/litellm-master-key` (field `value`, starts with `sk-`) and the salt key at `kv/litellm/salt-key` (T11 §5d);
- one key per model provider at `kv/litellm/providers/<provider>`, field `api_key` (T11 §5d). The models are listed in `litellm/config.ctmpl`.

The commands in T11 §5b and §5d end with `stored` or `FAILED`; the master key and the salt key can be made at random inside the container, so nobody sees them (T11 §5b).

### 5. Credentials of every process

Each command asks for the admin token, delivers one AppRole's role ID and a new secret ID into the service's volume, and prints no secret. Later, every 90 days, the bootstrap command `rotate-credentials` renews all the AppRole secret IDs with one admin token ([T11 §8.1](../../handbook/03-templates/T11-openbao-runbook.md#81-access-review-every-3-months-handbook-ch3)):

```bash
pnpm openbao:bootstrap litellm-credentials          # T11 §5d
pnpm openbao:bootstrap api-credentials              # T11 §5e
pnpm openbao:bootstrap worker-credentials           # T11 §5f (AppRoles worker and cost-controller)
pnpm openbao:bootstrap runner-credentials           # T11 §5g
pnpm openbao:bootstrap runner-evidence-credentials  # T11 §5g (L1 proposals, run diffs)
pnpm openbao:bootstrap api-evidence-credentials     # T11 §5h (Evidence Packs)
pnpm openbao:bootstrap worker-evidence-credentials  # T11 §5i (G8 release packs)
pnpm openbao:bootstrap worker-purge-credentials     # T11 §5j (evidence retention)
pnpm openbao:bootstrap worker-anchor-credentials    # T11 §5k (daily audit anchor)
pnpm openbao:bootstrap backup-credentials           # T11 §6 (the backup job: OpenBao's snapshot only)
```

Record each one in the operations log (role, date, reason; never the secret ID).

### 6. Database

```bash
SDLC_DB_MIGRATION_URL="postgres://platform:<PLATFORM_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm db:migrate
```

The password is in `platform/deploy/.env`. `pnpm db:status` (same variable) lists no pending migration.

### 7. Start the platform

```bash
platform/deploy/scripts/up.sh core models platform sandbox
curl -s http://127.0.0.1:8090/health/ready
```

This starts everything else of `core` too. On a release checkout it pulls the published `sdlc-api`, `sdlc-worker`, `sdlc-runner` and `otel-collector` images and says so (`up: using the published images of v…`); elsewhere Compose builds them. The script waits until every service is healthy. Then check that no process lacks a credential: the logs of `sdlc-api`, `sdlc-worker` and `sdlc-runner` must have no `…_missing` event (GETTING-STARTED Step 11b part 7). A missing one names the credentials command to run again.

Optional, Langfuse (section [Logs and traces](#logs-and-traces-a08)): add `observability` to the `up.sh` call. Then create the worker's own Langfuse key in the Langfuse UI and deliver the worker's purge credentials (runbook T11 §5m), so the retention loop can delete a purged project's traces:

```bash
pnpm openbao:bootstrap worker-langfuse-credentials  # T11 §5m (needs the profile observability)
```

The worker's retention loop starts in `report` mode: it deletes nothing (runbook T11 §5j).

Optional, the index of project documents (X04, [ADR-M89](../../design/ADR-M89-project-docs-index.md)), for plans with a `read_documents` tool: add `knowledge` to the `up.sh` call. `up.sh` then sets `SDLC_WORKER_KNOWLEDGE_DB_URL`. Deliver the worker's password of `knowledge-db` and the issuer of the tools' short-lived logins (X04 PR 3b), then start `sdlc-worker` and `sdlc-runner` again:

```bash
pnpm openbao:bootstrap worker-knowledge-credentials  # T11 §5o (needs the profile knowledge)
pnpm openbao:bootstrap knowledge-issuer-credentials  # T11 §5o (after configure)
```

Without it, a run whose plan asks for a `read_documents` or a `read_code` tool fails (`tool_unavailable`). The code index of the `read_code` tool (X06, [ADR-M108](../../design/ADR-M108-code-index.md)) uses the same profile and credentials, and no model. The model `bge-m3` must be on LiteLLM (the `ollama` provider, `ollama pull bge-m3`).

Optional, dashboard sign-in with GitHub (U05, [ADR-M73](../../design/ADR-M73-dashboard-actions.md)): the GitHub App needs a client secret and lists the callback URL `<public origin>/v1/auth/github/callback` (section [Create the GitHub App](#create-the-github-app-operator)). Store the client secret (`pnpm github-app:create` wrote it to `<key file>.client-secret`; delete the file afterwards), set `SDLC_API_WEB_SIGNIN=github` and `SDLC_API_PUBLIC_ORIGIN` (for example `http://localhost:8090`; plain `http://` only on `localhost`) in `platform/deploy/.env`, and start `sdlc-api` again:

```bash
pnpm openbao:bootstrap api-github-oauth-credentials < <key file>.client-secret  # T11 §5n
```

Optional, actions in the dashboard (U06, ADR-M73 §2.3): with the sign-in on, set `SDLC_API_DASHBOARD_ACTIONS=on` and start `sdlc-api` again. The api refuses to start with actions on and the sign-in off. Every write from the page needs the session's CSRF token and the public origin; each person adds a passkey in the dashboard within 5 minutes of a GitHub sign-in, and confirms each decision with it (decisions in the dashboard come with U07). A tenant admin lists and removes a person's passkeys with `adlc admin passkey list|revoke --user <id or email>`.

### 8. The tenant and its first admin

```bash
export SDLC_DB_URL="postgres://platform_app:<PLATFORM_APP_DB_PASSWORD>@127.0.0.1:5432/platform"
pnpm adlc ops bootstrap --tenant <slug> --tenant-name "<name>" --email <you> --name "<your name>"
pnpm adlc login --api-url http://127.0.0.1:8090
```

The bootstrap creates the tenant, its first user and that user's first personal API token (`sdlc_pat_…`, [ADR-M26](../../design/ADR-M26-api-app.md) §2.2), and makes the user the first **tenant admin** (task B13). `adlc login` reads the token at a hidden prompt. From here on, everything goes through the API: people set up projects, users and roles with `adlc admin …` and their own tokens with `adlc token …` (handbook [Ch.19 §19.8c](../../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-adlc-command) and [§19.8d](../../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins)).

- The token is printed **once**. Store it in a password manager; never paste it into a chat, a ticket or a file in a repository.
- The bootstrap runs once per tenant; a second run with the same slug is refused.
- Tokens last 90 days by default, at most 365. Only their SHA-256 hash is stored. Every issue and revocation is written to the audit log (IDs only).
- The operator's commands on the server are `adlc ops …`: they connect to the database with `SDLC_DB_URL` as the actor `system`. Besides `bootstrap`:

  | Command | Use |
  |---|---|
  | `adlc ops token issue\|list\|revoke` | API tokens for an existing user |
  | `adlc ops audit verify` | Check the audit log's hash chain ([Checking the audit log](#checking-the-audit-log)) |
  | `adlc ops tenant-admin grant\|revoke\|list`, `adlc ops role grant\|revoke` | A tenant with one admin, or a tenant that lost its admins |
  | `adlc ops ai-record set\|show` | The project AI record, on behalf of a person with a write role |
  | `adlc ops agent show\|list\|suspend\|quarantine` | Safety moves on the agent register when the API is down |
  | `adlc ops run kill` | The kill switch as the system |
  | `adlc ops retention report` | What the retention loop would purge |

  For example, a token for an existing user:

```bash
pnpm adlc ops token issue --tenant <slug> --email <email> --name <token name> --days 90
```

### 9. The project and its team

```bash
pnpm adlc admin project create --slug <project> --name "<name>" --repo <owner/name>
pnpm adlc admin user create --email <person-a> --name "<name>"
pnpm adlc admin identity link --user <person-a> --github-id <numeric ID> --github-login <login>
pnpm adlc admin role grant --project <project> --user <person-a> --role person_a
pnpm adlc admin token issue --user <person-a> --name <token-name>
```

Do the same for Person B (`--role person_b`) and every other role you need (the rules and every command: [handbook Ch.19 §19.8d](../../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins)). Person A and Person B are always two different people with two GitHub accounts. The numeric ID comes from `gh api users/<login> --jq .id`. Each person replaces the issued token with their own (`adlc token create`, then `adlc token revoke`).

**Or from one file (V17).** Steps 9, 11 and 12 can come from one YAML file outside the repository: `pnpm adlc admin project apply --file <project.yaml> --dry-run`, then the same without `--dry-run`. The file holds the project, the team with each person's GitHub login, the agent and the configuration; start from [`project.example.yaml`](project.example.yaml) ([handbook Ch.19 §19.8d](../../handbook/02-playbook/ch19-approval-queues.md#project-file)). The command looks up each numeric GitHub ID and shows it for you to confirm, refuses a file that would make one person Person A and Person B, and makes one API call per change. It issues no token, approves no agent and writes no AI record: at the end it prints these commands, per person. A role for yourself goes to another admin (`adlc ops role grant` on the server for a one-admin tenant, as in step 8).

### 10. The sandbox image

```bash
pnpm sandbox-image:build node24
```

It prints the image reference by digest (`…@sha256:…`) for the project configuration (runbook T11 §5g; on Docker Desktop add `--no-push`).

On a release checkout, skip the build: the release's published image is already pinned by digest, and the runner pulls it from GHCR.

```bash
pnpm images get SANDBOX_NODE24   # ghcr.io/…/sandbox-node24@sha256:…, for sandbox.image
```

Only for an agent with the adapter `opencode` (handbook Ch.20 §20.5b): build the OpenCode image on the `node24` image above, by digest, and put the printed reference in `sandbox.images.opencode`. The releases do not publish this image yet, so build it on a release checkout too (runbook T11 §5g).

```bash
NODE24=<the node24 image by digest> pnpm sandbox-image:build node24-opencode
```

**Register tools (X04, ADR-M69, ADR-M87).** A run with a register tool (`tool:<key>`) also gets one MCP gateway container, agentgateway, and one container per tool. The runner pulls both by digest: the gateway from `cr.agentgateway.dev` (project configuration `tools.gateway.image`), each tool from the image name in the tool register. A server that cannot reach `cr.agentgateway.dev` needs the image in a registry it can reach, and that name in `tools.gateway.image`. A tool image must run as user `10001`, serve MCP on port 8080 at `/mcp`, and have a health check. Runs without register tools start no extra container.

**The secret scan (H04, ADR-M93).** The runner scans the lines each run added with Gitleaks before G5 (handbook Ch.13 §13.10.5a). The `sdlc-runner` image holds Gitleaks 8.30.1, pinned by version and SHA-256 in `platform/deploy/scripts/gitleaks.sh`: nothing to configure. A runner outside the image (dev mode) needs `export SDLC_RUNNER_GITLEAKS_PATH="$(platform/deploy/scripts/gitleaks.sh)"`. `SDLC_RUNNER_SECRET_SCAN_TIMEOUT_SECONDS` (default 120, 5–1800) limits one scan. Without Gitleaks every run is held at G5 (`secret_scan_failed`, cause `scanner_missing` in the run event `secrets_scanned`).

### 11. The agent

```bash
pnpm adlc admin agent register --key <agent-key> --version 1.0.0 --owner <person-a> \
  --model <gateway model with version> --instructions AGENTS.md@<label> \
  --instructions-file <the repository's AGENTS.md> --tools file_editor,terminal \
  --max-autonomy L2 --environments sandbox
```

Then the agent's owner (`--as owner`) and Person B (`--as person_b`) each run `pnpm adlc admin agent approve --key <agent-key> --purpose activate` (handbook Ch.20 §20.5b). The model is a gateway model name from `litellm/config.ctmpl`, for example `claude-haiku-4-5-20251001`.

### 12. The project configuration

`pnpm adlc admin config show --project <project>` shows the current configuration version; `config set` below needs it as `--expected-version`. Write the settings that differ from the defaults into a YAML file outside the repo, at least:

```yaml
run:
  agent_key: <agent-key>
sandbox:
  image: <the reference of step 10>
verification:
  required_checks: [<the repository's required CI check>]
```

Then `pnpm adlc admin config set --project <project> --file <file> --expected-version <version>` ([handbook Ch.19 §19.8d](../../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins)).

### 13. The project AI record

Person A (or the PM / BrSE) records the client's consent (handbook Ch.2 §2.5, template T7):

```bash
pnpm adlc ai-record set --project <project> --expected-version 0 --ai-allowed yes \
  --classes public,internal --prod-logs no --disclosure standard_note
```

### 14. The first intent

```bash
pnpm adlc intent create --project <project> --title "<title>" --risk low --data-class internal
pnpm adlc intent show <INT-YYYY-NNNN>
```

The intent is `in_gate` at `G1`: Person A approves it with `pnpm adlc gate approve G1 <INT-…>` or `/approve G1` on its issue (handbook Ch.19 §19.8c).

## Start and stop

Run from the repo root.

```bash
pnpm compose:env     # once: creates platform/deploy/.env with random secrets (mode 600)
pnpm compose:core    # starts the core profile and waits until it is healthy
pnpm compose:obs     # core + observability
pnpm compose:models  # core + models: LiteLLM with keys from OpenBao (the server; runbook T11 §5d)
pnpm compose:platform # core + platform: the API (sdlc-api) and the worker (sdlc-worker; runbook T11 §5e, §5f)
pnpm compose:sandbox # core + sandbox: the runner, socket proxy, npm proxy, image registry (runbook T11 §5g)
pnpm compose:knowledge # core + knowledge: knowledge-db, the index of project documents (runbook T11 §5o)
pnpm compose:models-local # core + models + models-local: vLLM on the server's GPU (Self-hosted model below)
pnpm compose:models-remote # core + models + models-remote: vLLM on a separate GPU host (below)
pnpm compose:down    # stops everything; data volumes are kept
```

Without pnpm:

```bash
platform/deploy/scripts/init-env.sh
platform/deploy/scripts/up.sh core
platform/deploy/scripts/up.sh core observability
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile observability down
```

- `up.sh` fails if a service is not healthy within `SDLC_WAIT_TIMEOUT` seconds (default 300), or if a job does not exit 0.
- **Reset all data** (destroys databases, buckets and OpenBao storage): add `-v` to the `down` command. Do this only on a development machine.
- Logs: `docker compose -f platform/deploy/docker-compose.yml logs <service>`.

## Restart after a reboot

After a reboot (or `pnpm compose:down`) OpenBao is sealed again, and LiteLLM, the API, the worker, the runner and `litellm-agent` cannot become healthy until it is unsealed. On the server, `up.sh core` alone never becomes healthy either: LiteLLM gets its keys from OpenBao (profile `models`). The order:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap status     # says sealed
pnpm openbao:bootstrap unseal     # two key holders, each their share at the hidden prompt (runbook T11 §4)
platform/deploy/scripts/up.sh core models platform sandbox   # add observability if you use it
curl -s http://127.0.0.1:8090/health/ready
```

- **No credentials command is needed** after a plain restart: the AppRole secret IDs stay in the services' volumes for 90 days.
- After a `git pull` with new code, follow [Upgrade](#upgrade) instead (migrations, images).
- Record the restart and who unsealed in the operations log (T11 §4).
- On a development machine, [GETTING-STARTED Step 13](../GETTING-STARTED.md#step-13-restart-the-dev-stack-after-a-break-dev) is the same procedure with `up.sh core` (the LiteLLM keys are in `.env` there).

## Team access (operator)

People on other machines of the company LAN use the CLI and the dashboard through a TLS reverse proxy (task V09, [ADR-M67](../../design/ADR-M67-team-access.md)): nginx in the Compose profile `access`, on **one LAN port**. Nothing else is published beyond `127.0.0.1`; the api keeps listening on `127.0.0.1:8090` for the operator on the server. The server still accepts no connection from the internet: keep the port for the company LAN in the firewall.

**What the proxy does:** TLS 1.2 and 1.3 only; plain HTTP on its port answers `400` (no redirect, no port 80); a request for another host name answers `421`; only `/`, `/dashboard/`, `/v1/`, `/health/live` and `/health/ready` reach the api, everything else answers `404`; it adds HSTS (one year) and the other security headers and leaves the dashboard's Content-Security-Policy as the api sends it; bodies above 64 KiB answer `413`; per client address, 10 requests a second (burst 40), 30 sign-in requests a minute (burst 10) and 20 connections at the same time, then `429`. It logs the time, the client address, the method, the path without its query string, the status and the duration: never a header. The token travels only in the `Authorization` header.

**Networks.** The proxy is on a small network of its own, `access` (`<project>-access`, default `172.30.1.0/29`), with the api only: it cannot reach PostgreSQL, OpenBao, SeaweedFS or any other service. It overwrites `X-Forwarded-For` with the client's address, and the api trusts that header only from the proxy's fixed address (`SDLC_ACCESS_PROXY_IP`, default `172.30.1.6`) through `SDLC_API_TRUSTED_PROXY`, so the api's per-address limits count each person. The network `sdlc` does not change: an existing stack needs no network step. The real client address reaches the proxy only when Docker keeps it: Docker on Linux with its default port publishing does; Docker Desktop and some rootless set-ups show one shared address, and then every client shares one limit.

### Set it up

With `pnpm server:setup`, the settings' `access` section does steps 2–4 ([Fresh deployment](#fresh-deployment-operator), D-08 V20); step 1 and step 5 stay yours. By hand:

1. **A host name.** Choose the DNS name people open, for example `sdlc.example.internal`, and make it point to the server's LAN address in the company DNS. An IP address alone is not enough: passkeys refuse it.
2. **Settings** in `platform/deploy/.env`:

   ```bash
   SDLC_ACCESS_BIND_ADDR=192.0.2.10          # the server's LAN address (0.0.0.0 works, with a warning)
   SDLC_ACCESS_HOST_PORT=8443
   SDLC_ACCESS_HOSTNAME=sdlc.example.internal
   SDLC_ACCESS_IPS=                          # optional: IPv4 addresses for the CLI, space-separated
   SDLC_ACCESS_TLS_DIR=/etc/sdlc/access-tls  # outside the repository on a server
   SDLC_API_TRUSTED_PROXY=172.30.1.6         # = SDLC_ACCESS_PROXY_IP
   ```

   With the dashboard's GitHub sign-in on (`SDLC_API_WEB_SIGNIN=github`), set `SDLC_API_PUBLIC_ORIGIN=https://sdlc.example.internal:8443` (one public origin: the sign-in on `http://localhost:8090` stops), and add `https://sdlc.example.internal:8443/v1/auth/github/callback` to the GitHub App's callback URLs (a new App: `pnpm github-app:create --callback-url …`; an existing one: the App's settings on GitHub). Passkeys registered on `localhost` do not work on the new name; people register them again there.
3. **The certificate** ([T11 §3d](../../handbook/03-templates/T11-openbao-runbook.md#3d-tls-for-team-access-the-proxys-certificate)): from the company CA, `pnpm access:tls import <folder with ca.pem, server.pem, server-key.pem>`; or from the A10 internal CA, `pnpm access:tls server <ca-folder>`. On a test machine, `pnpm access:tls dev` makes a throw-away CA. `pnpm access:tls check` shows the end dates and the names.
4. **Start** with the profiles you use and `access` in the same call, for example `platform/deploy/scripts/up.sh core models platform sandbox access` (development: `pnpm compose:access`). `up.sh` checks the settings first (the bind address, the host name, the network `access`, `SDLC_API_TRUSTED_PROXY`, the public origin, the certificate) and starts nothing when one is wrong; a certificate ending within 30 days only warns.
5. **Check**: `pnpm doctor` (the `access.*` lines), then from another machine `curl --cacert ca.pem https://sdlc.example.internal:8443/health/ready`.

**People** sign in with `adlc login --api-url https://sdlc.example.internal:8443`, and, when the company CA is not in their system, set `NODE_EXTRA_CA_CERTS=<path to ca.pem>` (never `NODE_TLS_REJECT_UNAUTHORIZED=0`); the dashboard is at `https://sdlc.example.internal:8443/dashboard/` ([USER-GUIDE §2](../USER-GUIDE.md#account-and-login), handbook Ch.19 §19.8c). `adlc doctor` names `NODE_EXTRA_CA_CERTS` when it cannot verify the certificate.

**Turn it off:** stop the proxy (`docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile access stop sdlc-access`), empty `SDLC_ACCESS_BIND_ADDR`, `SDLC_ACCESS_HOSTNAME` and `SDLC_API_TRUSTED_PROXY`, and set `SDLC_API_PUBLIC_ORIGIN` back if the sign-in is on.

## The runner on its own Docker Engine (operator)

The runner controls Docker. On the server it runs with its sandboxes on **its own Docker Engine**, which holds no platform service and no platform data (task O01, [ADR-M91](../../design/ADR-M91-runner-own-engine.md)). Do this before the first real agent run on the company server (QUESTIONS #455). Developer machines and the trial keep the single Engine; there `pnpm doctor` only warns.

**Why.** The socket proxy limits the Docker endpoints the runner may call, not the body of a request (ADR-M25 §2.5). On the platform's Engine, a taken-over runner could create a container that mounts the platform's volumes (PostgreSQL, OpenBao, SeaweedFS) or joins the network `sdlc`. On an Engine of its own, it reaches only sandboxes.

| Way | Where the runner's Engine runs | The link between the two Engines |
|---|---|---|
| A separate VM (recommended) | A Linux VM next to the platform's server | A WireGuard tunnel (set up by the infrastructure operator) |
| The same server | A second, rootless Engine of the user `sdlc-runner` | A host address that only the two Engines use (a dummy interface) |

**What runs where.**

| On the runner's Engine (`platform/deploy/runner-host/docker-compose.yml`) | On the platform's Engine |
|---|---|
| `sdlc-runner`, `docker-socket-proxy`, `npm-proxy`; the sandboxes and the tool containers of a run | Everything else: api, worker, PostgreSQL, OpenBao, Temporal, SeaweedFS, Valkey, LiteLLM, knowledge-db, the registry, observability |
| `litellm` and `knowledge-db`: **relays** (HAProxy, pinned by digest), each with one fixed target on the link address. The sandboxes still reach `litellm:4000`, and nothing else | The link ports, published **only on `SDLC_RUNNER_LINK_ADDR`** (overlay `docker-compose.runner-link.yml`): PostgreSQL 5432, OpenBao 8200 (TLS), Temporal 7233, SeaweedFS S3 8333, LiteLLM 4000, knowledge-db 5433, registry 5050 |
| `openbao-ca-init` (a job): OpenBao's CA certificate into the volume `openbao-ca`; on a VM also `registry` (a relay, `GET` and `HEAD` only) | |

The runner's settings do not change: it reaches `postgres`, `openbao`, `temporal` and `seaweedfs` by name, through `extra_hosts` on the link address, and still verifies OpenBao's certificate. The runner host's `.env` holds no secret. A runner on its own Engine sends no traces (ADR-M91 §2.5); its logs stay on its Engine.

### Set it up

1. **The runner host, with one command.** On the VM, or on the same server for the user `sdlc-runner` (`sudo useradd --create-home --shell /bin/bash sdlc-runner`), in a checkout of the **same release tag** as the platform that belongs to that user. Install Docker's packages first (`docker-ce`, `docker-ce-cli`, `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`) and Node.js for the AuthZ plugin; the command checks them, names the missing ones and installs none (QUESTIONS #672). Build the plugin once, as `sdlc-runner`: `pnpm install --frozen-lockfile && pnpm exec tsc -b platform/deploy/docker-authz`. Then (task V18, [ADR-M107](../../design/ADR-M107-runner-host-setup.md)):

   ```bash
   # the same server: a second Engine and the dummy interface with the link address
   sudo platform/deploy/scripts/runner-host-setup.sh --user sdlc-runner --mode same-server --link-addr 10.203.0.1
   # a separate VM: the platform host's WireGuard address
   sudo platform/deploy/scripts/runner-host-setup.sh --user sdlc-runner --mode vm --link-addr 10.66.0.1
   ```

   Add `--project <name>` (the platform's `COMPOSE_PROJECT_NAME`) and `--ca-file <path>` (where OpenBao's `ca.pem` goes on this host) to fill those keys too. Add `--dry-run` first to see what it would change. It is safe to run again: each step checks the state first and says what is already done. It refuses a file or an `.env` key that already holds another value, before anything changes; it never sets `kernel.apparmor_restrict_unprivileged_userns=0`, never touches the machine's own Engine, and refuses an Engine that holds the platform's data. Only the owner runs it, in their own terminal (rule R149). What it does, in this order (the CI job `runner-rootless` runs the same step code, `platform/deploy/scripts/rootless-engine.sh`, through `test-rootless-docker.sh`):
   1. Subordinate IDs: `usermod --add-subuids 200000-265535 --add-subgids 200000-265535 sdlc-runner`.
   2. On Ubuntu 23.10 and later, an AppArmor profile that allows user namespaces for `rootlesskit` only (`/etc/apparmor.d/sdlc-rootlesskit`).
   3. cgroup v2 delegation: `/etc/systemd/system/user@.service.d/delegate.conf` with `[Service]` and `Delegate=cpu cpuset io memory pids`, then `systemctl daemon-reload`. Without `cpu`, the sandbox's CPU limit is accepted but not applied.
   4. `loginctl enable-linger sdlc-runner`, a restart of that user's systemd, then, as `sdlc-runner`, `dockerd-rootless-setuptool.sh install`.
   5. The check: `docker info` shows `rootless`, cgroup `2` and the driver `systemd`. The socket is `/run/user/<uid>/docker.sock`.
   6. **The AuthZ plugin (H07, ADR-M105):** the discovery file `/etc/docker/plugins/sdlc-authz.spec` as root, then `platform/deploy/docker-authz/scripts/install-rootless.sh` as `sdlc-runner`, with its operator key (runbook T11 §5g-1). `pnpm doctor` warns (`runner.authz`) when it is missing.
   7. The same server only: the dummy interface `sdlc-link` with the link address (systemd-networkd: `/etc/systemd/network/50-sdlc-link.netdev` with `Kind=dummy`, `50-sdlc-link.network` with `Address=10.203.0.1/32`, then `networkctl reload`).
   8. The runner host's `.env` (step 5): `runner-host.sh env`, then only its empty keys and the template's defaults.
2. **The link.**
   - A separate VM: the infrastructure operator sets up a WireGuard tunnel between the two machines, for example `10.66.0.1` (the platform host) and `10.66.0.2` (the VM). Generate the WireGuard private keys on each machine, in the owner's terminal; never put them in the repository, a chat or a log. Let the platform host accept the link ports from the VM's tunnel address only.
   - The same server: done by step 1 (`--mode same-server`). Without systemd-networkd, make the dummy interface by hand with the same address.
3. **The platform host's settings** in `platform/deploy/.env` (with `pnpm server:setup`, the settings' `runner_link` section does this step, step 4 and step 6: [Fresh deployment](#fresh-deployment-operator)):

   ```bash
   SDLC_RUNNER_LINK_ADDR=10.66.0.1          # the same server: 10.203.0.1
   SDLC_RUNNER_SOURCE_CIDR=10.66.0.2/32     # the runner host as OpenBao sees it; the same server: 10.203.0.1/32
   SDLC_RUNNER_DOCKER_HOST=ssh://sdlc-runner@10.66.0.2   # the same server: unix:///run/user/<uid>/docker.sock
   ```

   Then, in the owner's terminal: `pnpm openbao:bootstrap configure` (a root token; only the AppRole `runner` also accepts `SDLC_RUNNER_SOURCE_CIDR`). Skip this when `SDLC_RUNNER_SOURCE_CIDR` was already in `.env` at the first `configure` ([Before you start on a server](#before-you-start-on-a-server)). On the same server, any process of the host that connects from the link address looks like the runner to OpenBao: keep the link address for the two Engines only.
4. **Move the runner off the platform's Engine.** Stop and remove the old runner, then start the platform with the profile `runner-link` instead of `sandbox`; `up.sh` refuses `sandbox` while `SDLC_RUNNER_LINK_ADDR` is set:

   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile sandbox rm --stop --force sdlc-runner docker-socket-proxy npm-proxy
   platform/deploy/scripts/up.sh core models platform runner-link   # add knowledge if you use it
   ```

5. **The runner host's settings.** Step 1 writes `platform/deploy/runner-host/.env` (`runner-host.sh env`, never overwritten) and sets `SDLC_DOCKER_SOCKET` (`/run/user/<uid>/docker.sock`), and, when you give them, `SDLC_RUNNER_LINK_ADDR`, `COMPOSE_PROJECT_NAME` and `SDLC_OPENBAO_CA_FILE`; set any it did not by hand. Copy `ca.pem` of the platform's `SDLC_OPENBAO_TLS_DIR` to `SDLC_OPENBAO_CA_FILE` (a public certificate; never the folder's key).
6. **The runner's credentials**, on the platform host, in the owner's terminal: `pnpm openbao:bootstrap runner-credentials`. With `SDLC_RUNNER_DOCKER_HOST` set, the credentials go into the runner host's volume, over the Docker connection (stdin only, no file). `runner-evidence-credentials` is unchanged (OpenBao only).
7. **Start**, on the runner host: `platform/deploy/scripts/runner-host.sh up` (add `knowledge` for the knowledge-db relay, `vm` on a separate VM for the registry relay). It refuses an Engine that holds the platform's data. Stop: `runner-host.sh down` (volumes kept).
8. **Check** on the platform host: `pnpm doctor` shows `runner.engine` ok. On the runner host: `runner-host.sh ps`, and `docker compose -f platform/deploy/runner-host/docker-compose.yml --env-file platform/deploy/runner-host/.env --profile sandbox logs sdlc-runner`.

**Sandbox images.** Push them on the platform host as before (`pnpm sandbox-image:build`, [step 10](#10-the-sandbox-image)). The runner's Engine pulls them from `127.0.0.1:5050` by digest: on the same server directly, on a VM through the registry relay.

**Rotation.** `runner-credentials` every 90 days, as for every process (runbook T11 §8); restart the runner on the runner host afterwards (`runner-host.sh restart`).

**Tested.** `pnpm test:runner` runs on a rootless Engine, and `pnpm test:runner-split` runs the same-server set-up with two Engines in CI. The VM with WireGuard is not tested in CI.

### A stronger sandbox runtime (gVisor or Kata)

By default a sandbox runs on the host's kernel, with the hardening of ADR-M25 §2.4; a kernel bug is then a sandbox escape (ADR-M80 gap G-6). A stronger runtime gives the sandbox a kernel of its own (task H06, [ADR-M25 §2.12](../../design/ADR-M25-runner-sandbox.md)):

| Runtime | What it is | Needs | Tested in CI |
|---|---|---|---|
| `runsc` ([gVisor](https://gvisor.dev/docs/user_guide/docker/)) | A kernel in user space between the sandbox and the host | A rootful Engine | Yes (job `sandbox-runsc`: `pnpm test:runner`, `pnpm test:attack`) |
| `kata` ([Kata Containers](https://katacontainers.io/)) | A small virtual machine per container | A rootful Engine and `/dev/kvm` | No (GitHub's runners have no nested virtualisation) |

**When to use it.** When the runner host is shared with other work, or when the repositories come from people you do not trust (for example a client's code you have not reviewed). On a runner VM that holds nothing else and runs your own team's repositories, the default runtime with the rootless Engine is enough.

**Rootful only (QUESTIONS #701).** gVisor and Kata need a rootful Docker Engine for each run's own network; rootless gVisor has no network namespace of its own ([gVisor: rootless](https://gvisor.dev/docs/user_guide/rootless/)). So the stronger runtime **replaces** the rootless Engine; it is not added to it. Use it only on a runner host that is **a separate VM**, never on the platform's server: there a rootful Engine would run as root next to the platform. The runner refuses to start with a runtime on a rootless Engine (`runner.docker.runtime_rootless`) and when the Engine does not list it (`runner.docker.runtime_missing`).

**Set it up** (on the runner VM, as root, in your own terminal):

1. Install Docker's packages (rootful) instead of step 1 of [Set it up](#set-it-up) (`runner-host-setup.sh` makes a rootless Engine). The other steps stay: the link, the platform host's settings, the credentials. `SDLC_DOCKER_SOCKET` in the runner host's `.env` is `/var/run/docker.sock`.
2. Install the runtime from its own release and register it. gVisor: download the release archive, check its SHA-512 against the release's `.sha512` file, unpack it into `/opt/gvisor`, then `/opt/gvisor/runsc install` and `systemctl restart docker`. The CI job `sandbox-runsc` does the same with a pinned release (`GVISOR_RELEASE`, `GVISOR_SHA512` in `.github/workflows/ci.yml`).
3. Check: `docker info --format '{{json .Runtimes}}'` lists `runsc` (or `kata`).
4. The AuthZ plugin, rootful, with the runtime required for every container that gets a run's workspace: build it (`pnpm exec tsc -b platform/deploy/docker-authz`), then `sudo SDLC_DOCKER_AUTHZ_REQUIRE_RUNTIME=runsc platform/deploy/docker-authz/scripts/enable.sh`.
5. In `platform/deploy/runner-host/.env`: `SDLC_RUNNER_SANDBOX_RUNTIME=runsc` (or `kata`), then `platform/deploy/scripts/runner-host.sh up` (or `restart`).

Only the sandbox and the two scoring containers of an evaluation use the runtime. The tool and MCP gateway containers keep the Engine's own runtime (QUESTIONS #704).

**The cost.** The CI job `sandbox-runsc` measures it on every run (`platform/tests/integration/runner/runtime-cost.test.ts`, the median of three starts of the fixture sandbox, in the job summary). Measured on GitHub's `ubuntu-24.04` runner (4 CPUs, 16 GiB), gVisor release 20261026.0:

| Runtime | Start to first output | Memory after start |
|---|---|---|
| `runc` (default) | MEASURE_RUNC_MS ms | MEASURE_RUNC_MIB MiB |
| `runsc` | MEASURE_RUNSC_MS ms | MEASURE_RUNSC_MIB MiB |

Expect more CPU time on system calls (file and network work) under gVisor: a dependency install or a test run in the sandbox takes longer than the numbers above show.

**Turn it off.** Empty `SDLC_RUNNER_SANDBOX_RUNTIME`, `runner-host.sh restart`, and run the plugin's `enable.sh` again without the variable.

## Secrets and `.env`

- `.env` holds every password and key. It is ignored by Git and has mode 600. **Never commit it and never paste it into chat, issues or email.**
- `init-env.sh` never overwrites an existing `.env` and never prints secrets. To regenerate, delete `.env` first. Existing volumes keep the old passwords, so reset the data too (`down -v`).
- `.env.example` lists every variable. `CHANGEME` values are placeholders; Compose refuses to start while a secret is missing.
- The Langfuse admin account (email and password) is in `.env`: `LANGFUSE_INIT_USER_EMAIL`, `LANGFUSE_INIT_USER_PASSWORD`. Open sign-up is disabled.
- After task A03, secrets move into OpenBao step by step (D-03 section 8.2).

## Ports

All published ports bind to `127.0.0.1` by default (`SDLC_BIND_ADDR`), except the team access proxy, which binds to `SDLC_ACCESS_BIND_ADDR`. The server accepts no inbound internet connections (D-03 section 9). Change a host port in `.env` when it is already in use.

| Service | Default host port | Notes |
|---|---|---|
| PostgreSQL | 5432 | Databases `platform`, `temporal`, `temporal_visibility`, `litellm`, `langfuse`, one owner role each. The `platform` database also has the application role `platform_app` (see below) |
| Temporal (gRPC) | 7233 | Namespace `default`; closed workflows kept 30 days |
| Temporal UI | 8080 | |
| LiteLLM | 4000 | Models only with the profile `models` (keys from OpenBao). Without it: no models, development keys from `.env` |
| SeaweedFS S3 | 8333 | Anonymous access denied. The only SeaweedFS port reachable from outside its container (A12) |
| Langfuse | 3000 | `observability` profile only |
| API (`sdlc-api`) | 8090 | `platform` profile only. 8080 is taken by the Temporal UI. Also serves the read-only dashboard at `/dashboard/` (U01, `SDLC_API_DASHBOARD_DIR`, built into the image; `off` turns it off). Keep it on `127.0.0.1`: other machines use the proxy of the profile `access` (ADR-M54 §2.2, ADR-M67; how people use it: [handbook Ch.19 §19.8e](../../handbook/02-playbook/ch19-approval-queues.md#198e-using-the-platform-the-dashboard)) |
| Team access proxy (`sdlc-access`) | 8443 | `access` profile only. **The only port on another address**: `SDLC_ACCESS_BIND_ADDR`, the server's LAN address ([Team access](#team-access-operator)); without it the profile does not start |
| Sandbox image registry | 5050 | `sandbox` profile only. **Always 127.0.0.1** (not `SDLC_BIND_ADDR`): it has no authentication. Not 5000: macOS uses it |
| The runner's link | 5432, 8200, 7233, 8333, 4000, 5433, 5050 | Only with `SDLC_RUNNER_LINK_ADDR` (profile `runner-link`, overlay `docker-compose.runner-link.yml`): PostgreSQL, OpenBao (TLS), Temporal, SeaweedFS S3, LiteLLM, knowledge-db and the registry, **on the link address only**, for a runner on its own Engine ([The runner on its own Docker Engine](#the-runner-on-its-own-docker-engine-operator)) |
| The GPU host's gateway | 8443 | **On the GPU host**, not the platform server (`gpu-host/docker-compose.yml`): `SDLC_GPU_LINK_PORT`, **only on `SDLC_GPU_LINK_ADDR`**, mutual TLS. The platform's `vllm-link` publishes no port ([Self-hosted model on a separate GPU host](#self-hosted-model-on-a-separate-gpu-host-operator)) |

Valkey, ClickHouse, the Langfuse worker, the OpenTelemetry Collector, **OpenBao**, the runner, the socket proxy, the npm proxy, `vllm` and `vllm-link` publish no port.

OpenBao is reachable only on the Compose network (`design/QUESTIONS.md` #27, task A11), except on the link address of a runner on its own Engine (ADR-M91 §2.3). The platform processes run in Compose and use `https://openbao:8200`, verified with the CA of the volume `openbao-ca` (TLS since A10, [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). Key holders and admins work inside the container with `pnpm openbao:bootstrap …` or `docker compose … exec openbao …` (runbook T11). There is no host port for `curl`.

SeaweedFS (task A12, `design/ADR-M52-seaweedfs-internal-access.md`): only the S3 API (8333) listens on the Compose network; every platform process uses it with its own identity. The master, volume server and filer listen on `127.0.0.1` inside the container and need JWT keys that `seaweedfs/start.sh` makes at every start (kept nowhere else; no keys, no start). Admin work: `docker compose … exec seaweedfs weed shell -master=127.0.0.1:9333` (runbook T11 §5l). `seaweedfs-init` runs in the container's network namespace.

## Network and data flows

What leaves the server, and what stays on it. The data classes and which models may receive them: [D-07 §4](../../design/D-07-model-and-token-management.md).

| Goes out to | From | What is sent |
|---|---|---|
| GitHub API (`api.github.com`) and Git over HTTPS | `sdlc-api`, `sdlc-worker`, `sdlc-runner` | Reads issues, comments, reviews, CI results, specs and plans; clones; pushes `agent/INT-…` branches; opens pull requests and posts comments with codes only |
| The model providers (for example Anthropic), through LiteLLM | `litellm` | The agent's prompts: the task, the spec, the plan and **parts of the project's code**. A self-hosted model keeps them on your infrastructure; `client_restricted` data may go only to self-hosted models |
| The npm registry (`registry.npmjs.org`) | `npm-proxy` (Verdaccio) | Package downloads for the sandboxes |
| Image registries (Docker Hub, GHCR) | Docker, at pull and build time | Image downloads |

| Stays on the server | Where | Kept |
|---|---|---|
| Each run's diff, L1 proposals, Evidence Packs | SeaweedFS | At least 180 days (object lock); purged after the project's retention only when the retention loop runs in `purge` mode (`report` by default: it deletes nothing) ([handbook Ch.15 §15.10.2](../../handbook/02-playbook/ch15-p5-release.md#15102-the-evidence-pack)) |
| Model prompts and answers | Langfuse (profile `observability` only) | Until the retention purge of the same loop (`purge` mode only) |
| Audit log, gate decisions, escalations | PostgreSQL | At least 2 years |
| Secrets and keys | OpenBao | Until rotated |

Comes in: with the profile `access` only, HTTPS from the company LAN to the proxy's port (the API and the dashboard; [Team access](#team-access-operator)). Nothing else accepts a connection from another machine.

With the profile `models-local`, prompts to the self-hosted model never leave the server: `vllm` is on the internal network `models` with LiteLLM only, with no route to the internet. Only `vllm-pull` goes out (to Hugging Face), once, when an operator runs it, and sends nothing but the download request.

With the profile `models-remote`, prompts go to the GPU host and back, and nowhere else: `vllm-link` calls only the GPU host's gateway, with mutual TLS (both machines show a certificate of the link's CA). On the GPU host, `vllm` is on an internal network with the gateway only. Keep the GPU host inside the company network, and allow its port only from the platform server.

Sandboxes reach only LiteLLM and the package proxy; never GitHub, OpenBao or the internet. The platform keeps no working copy of the code: clones are removed when a run ends.

## Platform database roles

The `platform` database has two roles ([ADR-M09](../../design/ADR-M09-database-tooling.md) section 2.3):

| Role | Password variable | Used for |
|---|---|---|
| `platform` (owner) | `PLATFORM_DB_PASSWORD` | Migrations only: `SDLC_DB_MIGRATION_URL=postgres://platform:…@127.0.0.1:5432/platform pnpm db:migrate` |
| `platform_app` | `PLATFORM_APP_DB_PASSWORD` | The platform processes. `SELECT`, `INSERT`, `UPDATE` on chosen columns; never `DELETE` or DDL |

The init scripts create both roles only on an **empty** data volume. A volume created before task A06 has no `platform_app`. Add `PLATFORM_APP_DB_PASSWORD` to `.env` (for example `openssl rand -hex 24`), restart with `pnpm compose:core`, then run the idempotent script once:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T postgres sh /docker-entrypoint-initdb.d/02-create-platform-app-role.sh
```

### Checking the audit log

The audit log is append-only and hash-chained per tenant (ADR-M09 section 2.8). Check every tenant's chain (exit code 1 when a record was changed or removed):

```bash
SDLC_DB_URL="postgres://platform_app:<PLATFORM_APP_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm adlc ops audit verify
```

Add `--tenant <slug>` for one tenant, `--json` for machine-readable output. The command connects straight to the database. Tenant admins run the same check through the API with `adlc audit verify` (task B13, `design/ADR-M37-admin-onboarding.md`).

### First admin and API tokens (task B03)

The first admin, the bootstrap token and the operator's `adlc ops …` commands: [Fresh deployment, step 8](#8-the-tenant-and-its-first-admin). How people log in and manage their own tokens: handbook [Ch.19 §19.8c](../../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-adlc-command).

### Reset after a change to migration 0001 (development only)

Migration `0001-tenancy` was changed before it was merged (task A06: `role_bindings.revoked_at`). A development database that already applied an earlier version of 0001 does not get the change: the migrator only runs migrations it has not recorded. Recreate the `platform` database, then migrate again. **This deletes all data in it.**

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'DROP DATABASE platform WITH (FORCE)' \
  -c 'CREATE DATABASE platform OWNER platform' \
  -c 'REVOKE ALL ON DATABASE platform FROM PUBLIC' \
  -c 'GRANT CONNECT ON DATABASE platform TO platform_app'
SDLC_DB_MIGRATION_URL="postgres://platform:<PLATFORM_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm db:migrate
```

Alternatively, recreate the whole Compose stack with its volumes (`docker compose … down -v`). Once 0001 is on `main` it never changes again (ADR-M09 section 2.2).

## OpenBao: initialise, unseal, configure (task A03)

OpenBao starts **uninitialised and sealed**. `openbao/bootstrap.sh` initialises it (3 key shares, any 2 unseal), unseals it and applies the configuration ([ADR-M19](../../design/ADR-M19-openbao-bootstrap.md)). After every restart it is sealed again.

- The order of the commands on a new machine: [Fresh deployment, step 3](#3-openbao).
- The procedure, the key custody, unsealing after a restart, the settings files and troubleshooting: [runbook T11](../../handbook/03-templates/T11-openbao-runbook.md) §3 and §4 (on a development machine with throw-away keys: §3.1).
- The real initialisation on the internal server waits until the three key holders are named and the company CA's certificate is issued (T11 §3.2, §3c, `design/QUESTIONS.md` #20).

## Health: what "healthy" means

| Service | Healthy means |
|---|---|
| PostgreSQL | `pg_isready` answers |
| Temporal | The frontend gRPC port accepts connections. The `temporal-namespace` job then checks full cluster health with the Temporal CLI |
| Temporal UI, Langfuse web and worker, ClickHouse, SeaweedFS | Their HTTP health endpoint answers |
| OpenTelemetry Collector | Its `health_check` extension answers (inside the container) |
| Valkey | `PING` with the password returns `PONG` |
| LiteLLM | `/health/liveliness` answers |
| **OpenBao** | **The API answers over TLS with a certificate the CA accepts (`bao status`). It does NOT mean initialised or unsealed.** A new volume is uninitialised and sealed; initialise it with `openbao/bootstrap.sh` (see above). After every restart, OpenBao is sealed again until two key holders unseal it (D-03 section 10.2). Check with `pnpm openbao:bootstrap status` (OpenBao publishes no host port) |

## Logs and traces (A08)

Design: [ADR-M35](../../design/ADR-M35-observability.md). Usage for operators: [handbook Chapter 18 §18.8c](../../handbook/02-playbook/ch18-timeouts-rollback-and-containment.md#188c-using-the-platform-logs-and-traces-of-a-run).

- **Logs.** `sdlc-api`, `sdlc-worker` and `sdlc-runner` write one JSON line per event, with `tenant_id`, `intent_id` and `run_id` when known. Only codes, IDs and counts; never a token, a key or client data.
- **Traces are off unless `SDLC_OTEL_ENDPOINT` is set.** `up.sh` sets it to `http://otel-collector:4318` when `observability` is one of the profiles of the same call, so start the profiles that use it together:

  ```bash
  platform/deploy/scripts/up.sh core models platform observability
  ```

  `pnpm compose:obs` alone starts Langfuse and the collector, but no traced process.
- The **OpenTelemetry Collector** (`otel-collector`, image `sdlc-otel-collector:0.161.0` built from `otel-collector/`) receives traces (OTLP, the OpenTelemetry format) from the api, the worker and LiteLLM without credentials and forwards it to Langfuse v4. It is the only service with the Langfuse project key (`LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `…_SECRET_KEY` from `.env`; OpenBao with A10). No host port; sandboxes never reach it.
- **LiteLLM** traces every model call with its `langfuse_otel` callback (rendered by `litellm/config.ctmpl` when the sidecar has `SDLC_OTEL_ENDPOINT`). Each call is one Langfuse trace tagged with the seven labels (`tenant:`, `project:`, `intent_id:`, `run_id:`, `gate:`, `agent:`, `data_class:`). It holds the prompt and the answer: client data (ADR-M35 §2.5).
- Langfuse runs v4 in `events_only` mode: read traces through `GET /api/public/v2/observations` (the old `/api/public/traces` answers 404).

## Scheduled spend sync (C12)

Design: [ADR-M24 §2.5](../../design/ADR-M24-litellm-cost-controller.md). `sdlc-worker` copies spend from LiteLLM into `cost_records` on a schedule, besides the copy when each run ends. It runs only when the worker has the `cost-controller` AppRole (`pnpm openbao:bootstrap worker-credentials`); otherwise it logs `worker.cost_sync_off`. The defaults need no setting:

| Setting | Default | Bounds | Meaning |
|---|---|---|---|
| `SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS` | 300 | 30–3600 | Time between two passes |
| `SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES` | 120 | 10–1440, at least two intervals | Each pass reads the calls of this window again (LiteLLM writes spend logs in batches) |
| `SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES` | 1440 | look-back–10080 | The first pass after a start reads this far back; a retry never reaches further |
| `SDLC_WORKER_COST_SYNC_SETTLE_MINUTES` | 30 | 5–1440 | Runs that ended within this window are read again from their start |

Logs: `worker.cost_synced` (counts), `worker.cost_sync_failed` (an error code; the next pass retries from the failed slice), `worker.cost_sync_busy` (another worker holds the lock), and `worker.cost_sync_gap` (warning, `uncovered_minutes`): the sync failed for longer than the catch-up window, so the calls of those minutes are not recorded.

**Manual sync: no operator command yet (open item, ADR-M24 §3).** After a `worker.cost_sync_gap` warning, set `SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES` to cover the gap (at most 10080, seven days) and restart `sdlc-worker`: its first pass reads that window again. Calls already recorded are never counted twice. Calls older than seven days, or older than LiteLLM keeps its spend logs, cannot be recovered this way.

## Evaluations on the server (L04)

Design: [ADR-M81](../../design/ADR-M81-server-evaluations.md). An evaluation runs agent configurations (agent × model × instructions) on a fixed task set through the deployed runner, LiteLLM and the Cost Controller, and keeps the results per tenant in the database. Real runs always come first: an evaluation run uses only free sandbox slots and stops when a real run waits. The same engine runs on a developer machine with `pnpm eval`; see [Evaluation harness](../DEVELOPMENT.md).

**Before the first evaluation**
- The worker runs the evaluation loop when it has the `cost-controller` AppRole and Temporal (the same condition as agent runs and the spend sync). Without it the worker logs `worker.runs_off` and no evaluation starts.
- Install the GitHub App on the sample repository `pilot-order-inventory` (the task set clones it at a pinned commit), and create it as a project of the tenant with that repository name. The project needs an AI record that allows the data class of the evaluation (default `internal`).
- The task set v1 and the configuration files are packed in the runner image (`/app/eval-tasks`, `/app/eval-configs`; the reference solutions are removed). A private task set: mount a folder and set `SDLC_EVAL_TASKS_DIR` (runner and the `adlc` command); other configuration files: `SDLC_EVAL_CONFIG_DIR`.
- Every model of a configuration must be listed by LiteLLM and allowed for the data class by the project's policy. `client_restricted` data goes to self-hosted models only. The worker checks the model again when each run is issued.

**Settings (technical, no handbook rule)**

| Setting | Process | Default | Bounds | Meaning |
|---|---|---|---|---|
| `SDLC_RUNNER_MAX_EVAL_SANDBOXES` | runner | 1 | 0 – `SDLC_RUNNER_MAX_SANDBOXES` | Evaluation runs at one time; 0 turns evaluations off. A waiting real run takes the slot back |
| `SDLC_EVAL_TASKS_DIR`, `SDLC_EVAL_CONFIG_DIR` | runner, worker (tasks only, L05), `adlc ops eval` | the image | a folder | Another task set, other configuration files. The worker's plan loop reads the task set's version, commit and task IDs; give the worker and the runner the same folder |
| `SDLC_RUNNER_GPU` | runner | none | a name | The GPU name written in the hardware block of each result |
| `SDLC_WORKER_EVAL_TICK_SECONDS` | worker | 15 | 5–300 | Time between two passes of the evaluation loop |
| `SDLC_WORKER_EVAL_MAX_IN_FLIGHT` | worker | 2 | 1–16 | Runs handed to the runner at one time (running, or waiting for a slot) |

**Start one (operator, on the server, `SDLC_DB_URL` set)**

```bash
pnpm adlc ops eval start --tenant <slug> --project <slug> --config platform/eval/configs/local.yaml --budget 5 --n 3
```

It prints the evaluation code (`EVAL-YYYY-NNNN`) and the counts, and writes `evaluation.started` in the audit log as done by the platform. Options: `--configurations a,b`, `--tasks t1,t2`, `--data-class <class>`, `--tasks-dir <folder>`, `--json`. The budget is the evaluation's own: each run's virtual key is capped at what is left of it, and when it is used up the evaluation ends `stopped_budget`. Its cost is a separate line in the cost report, never inside an intent. People follow evaluations with `adlc eval list|show` and in the dashboard (Evaluations); the full report comes with L06. The tables `evaluations`, `evaluation_runs` and `evaluation_run_results` hold numbers and codes only: no prompt, task text or diff.

**Logs.** `worker.evaluation_run_handed_over`, `worker.evaluation_requeued` (a run without a live workflow got its next attempt), `worker.evaluation_refused` (`reason`: `budget_used`, `tenant_budget_used`, `model_not_allowed`, `not_startable`), `worker.evaluation_failed` (`step`, an error code; a run that fails to be handed over five times in a row is cancelled with `prepare_failed`), and on the runner `runner.evaluation_started` and `runner.evaluation_ended`. A run lost with its runner is queued again and fails with `runner_lost` after three attempts.

## Evaluation plans (L05)

Design: [ADR-M82](../../design/ADR-M82-evaluation-plans.md). People with a role in the project's `access.eval_roles` (default `person_a`, `person_b`, `governance`, `admin`; never `viewer`) make **evaluation plans** themselves, in the dashboard (Evaluations) or with `adlc eval plan …`, instead of asking the operator. Each run of a plan is an evaluation of [Evaluations on the server](#evaluations-on-the-server-l04).

**What the deployment needs.** Everything of L04, and:
- `pnpm db:migrate` (migrations `0031` and `0032`).
- The worker image carries task set v1 without the reference solutions (`/app/eval-tasks`). A server with its own task set mounts it into the worker **and** the runner and sets `SDLC_EVAL_TASKS_DIR` in both.
- The dashboard's plan actions need GitHub sign-in and `SDLC_API_DASHBOARD_ACTIONS=on` (runbook T11 §5n), and a passkey per person: **Run now** is always confirmed with a passkey; a plan that runs on a schedule or on a change, or a higher budget, too. The CLI with an API token needs no passkey.
- A plan whose configuration names a model (not an agent) runs it with the project's default agent: set `run.agent_key` in the project configuration.
- A prompt variant is a file on the project's default branch; the GitHub App reads it when the plan is saved and the runner reads it again, at the recorded commit, when a run starts.

**How plans run.** The worker's plan loop runs every `SDLC_WORKER_EVAL_TICK_SECONDS`, with the Cost Controller (the same condition as the evaluation loop). It starts **Run now** requests (within a pass), due schedules (UTC; a schedule missed while the worker was down runs once) and `on_change` plans (a change of the gateway's models or the plan's agent versions). A plan never has two open evaluations. Its monthly cap pauses its schedule until the next UTC month; the tenant's monthly budget still applies to every run.

**Logs.** `worker.evaluation_plan_started` (`plan_id`, `evaluation_id`, `reason` `manual`, `schedule` or `on_change`), `worker.evaluation_plan_refused` (`code`: for example `model_not_allowed`, `task_set_not_found`, `monthly_cap_used`, `evaluation_open`; the code is also on the plan, as "Last refusal" in the dashboard), `worker.evaluation_plan_failed` (`step`, an error code; tried again on the next pass).

## A project's own task set (L07)

Design: [ADR-M85](../../design/ADR-M85-project-task-sets.md); usage: handbook Ch.19 §19.8c "A project's own task set". A project's tasks are task cards (`.sdlc/eval-tasks/<id>.yaml`) on its default branch, made from merged intents. The platform stores their path, commit and SHA-256 only.

**What the deployment needs.** Everything of L04 and L05, and:
- `pnpm db:migrate` (migrations `0033`, `0034` and `0035`).
- The GitHub App installed on the **project's** repository (not only the sample repository): the api reads the merged pull request and the card; the worker reads the cards; the runner clones the repository with a single-repository read token.
- At least one evaluation slot on the runner (`SDLC_RUNNER_MAX_EVAL_SANDBOXES` 1 or more). The check of a new task uses that slot, with no agent, no model and no cost; a real run takes the slot back.
- A sandbox image (`sandbox.image` of the project configuration) that can install the project with `pnpm install --frozen-lockfile` through the package proxy. Other package managers fail the check with `install_failed`.

**How it runs.** The worker's check loop (every `SDLC_WORKER_EVAL_TICK_SECONDS`) hands each registered task to the runner with a signed contract of kind `evaluation_task_check`. The runner scores twice: the commit before the change (the hidden tests must fail), then with the reference solution (everything must pass). A check that does not end is handed over again, at most 3 times (then `check_lost`). An evaluation of a plan on the task set `project` reads the cards on the default branch when it starts; each run starts at its own task's commit. `adlc ops eval start` runs the numbered task sets only.

**Logs.** `worker.task_check_handed_over`, `worker.task_check_requeued`, `worker.task_check_refused` and `worker.task_check_failed` (codes and IDs only). The task's status and check code are in `adlc eval task list`.

## Self-hosted model (operator)

The profile `models-local` runs a self-hosted model with vLLM on the server's own GPU ([ADR-M71](../../design/ADR-M71-self-hosted-model-vllm.md), task L01). A `client_restricted` intent may use only a self-hosted model ([D-07 §4](../../design/D-07-model-and-token-management.md)). The profile is off by default; a server without a GPU never starts it. When the GPU is in another machine, see [Self-hosted model on a separate GPU host](#self-hosted-model-on-a-separate-gpu-host-operator).

### What it does

- `vllm` (image `vllm/vllm-openai`, pinned by tag and digest) serves one model, named `SDLC_VLLM_SERVED_NAME`, on port 8000 of the internal network `models`. Only LiteLLM is on that network; `vllm` has no host port and no route to the internet.
- Every call goes through LiteLLM with the run's virtual key and its seven labels. LiteLLM counts an internal cost per token (a placeholder until L03), so budgets still stop a run.
- At most `SDLC_VLLM_MAX_NUM_SEQS` requests at a time (default 4): vLLM's `--max-num-seqs` and LiteLLM's `max_parallel_requests`. LiteLLM refuses a request over the limit; the agent retries.
- vLLM logs no prompt. It never downloads anything: the weights are in the volume `vllm-models`, mounted read-only, and `HF_HUB_OFFLINE=1`.

### Set it up

1. The host: an NVIDIA GPU with its driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) **[External]**. Check: `docker run --rm --gpus all ubuntu nvidia-smi` shows the GPU.
2. Choose the model in `platform/deploy/.env` (the defaults are in `.env.example`): `SDLC_VLLM_MODEL` (a public Hugging Face repository; check its licence), `SDLC_VLLM_MODEL_REVISION` (a commit hash of that repository is best), `SDLC_VLLM_SERVED_NAME` (with the model version in it: it becomes the agent's `model_ref`), and if needed `SDLC_VLLM_GPU_COUNT`, `SDLC_VLLM_MAX_MODEL_LEN`, `SDLC_VLLM_GPU_MEMORY_UTILIZATION`, `SDLC_VLLM_TOOL_PARSER` (the model family's tool-call parser).
3. Download the weights once (from the internet; it can take an hour):
   ```bash
   pnpm models-local:pull
   ```
4. Store the provider entry `vllm` in OpenBao (runbook T11 §5d.1): `api_base=http://vllm:8000/v1` and `model=<SDLC_VLLM_SERVED_NAME>`.
5. Start with the other profiles of the server, or alone:
   ```bash
   pnpm compose:models-local
   ```
   `vllm` becomes healthy when the model is on the GPU (up to 15 minutes). Then restart `litellm-agent` and `litellm` if they were already running, so the model appears.
6. Check: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile models-local ps vllm litellm` shows both healthy. G4 reads the gateway's model list, so a run whose intent is `client_restricted` gets only this model. Then register an agent whose model is the served name (handbook Ch.20 §20.5b, "An agent on the self-hosted model").

### Change the model

Change `SDLC_VLLM_MODEL`, `SDLC_VLLM_MODEL_REVISION` and `SDLC_VLLM_SERVED_NAME`, run `pnpm models-local:pull` again, update the field `model` of the provider entry (T11 §5d.1), and restart `vllm`, `litellm-agent` and `litellm`. A new served name is a new `model_ref`: agents need a new version in the register. Old weights stay in the volume until you remove it (`docker volume rm <project>_vllm-models`, then pull again).

## Self-hosted model on a separate GPU host (operator)

The GPU can be in a separate machine, the **GPU host** ([ADR-M71 §4](../../design/ADR-M71-self-hosted-model-vllm.md), task L01 PR 2). The platform server then needs no GPU. The model, its settings and the LiteLLM entry are the same as in [Self-hosted model](#self-hosted-model-operator); only where vLLM runs changes.

### What it does

- **On the GPU host** (`platform/deploy/gpu-host/docker-compose.yml`, its own Compose project `sdlc-gpu`): `vllm` and `vllm-pull`, the same as on the platform server, and `vllm-gateway` (nginx). `vllm` is on an internal network with the gateway only, with no port and no route to the internet.
- The gateway publishes one port (`SDLC_GPU_LINK_PORT`, 8443) only on `SDLC_GPU_LINK_ADDR`. It accepts a connection only with a client certificate of the link's CA whose name is `SDLC_GPU_LINK_CLIENT_CN` (`sdlc-vllm-link`), and forwards only `/v1/chat/completions`, `/v1/completions`, `/v1/models` and `/health`.
- **On the platform server** (profile `models-remote`): `vllm-link` (nginx) is on the network `models` under the name `vllm`, so LiteLLM calls `http://vllm:8000/v1` as before. It calls the gateway with its client certificate and checks the GPU host's certificate and name. It has no host port.
- Neither side logs a header, a body or a query string. The concurrency limit is the same value on both machines.

### Set it up

1. **The GPU host:** Linux with Docker, an NVIDIA GPU, its driver and the NVIDIA Container Toolkit (as in [Self-hosted model](#self-hosted-model-operator) step 1), a clone of this repository at the same release, and a DNS name (for example `gpu1.example.internal`). The platform server must reach it on one TCP port; in the firewall, allow that port **only from the platform server**.
2. **Certificates** (on the machine that holds the internal CA, see runbook T11 §5d.2):
   ```bash
   pnpm gpu-link:tls issue <ca-folder> gpu1.example.internal /secure/gpu-link
   ```
   This writes `/secure/gpu-link/gpu-host/` (for the GPU host) and `/secure/gpu-link/platform/` (for the platform server). Copy each folder to its machine, outside the repository; the keys keep mode 600. With certificates of the company CA, put the same three files in each folder and check them with `pnpm gpu-link:tls check <folder> [gpu-host-name]`.
3. **On the GPU host:**
   ```bash
   pnpm gpu-host:env      # once: platform/deploy/gpu-host/.env
   ```
   Set `SDLC_GPU_LINK_ADDR` (the GPU host's address the platform server reaches), `SDLC_GPU_LINK_TLS_DIR` (the `gpu-host/` folder of step 2) and the model settings (`SDLC_VLLM_*`; `SDLC_VLLM_SERVED_NAME` and `SDLC_VLLM_MAX_NUM_SEQS` must equal the platform's). Then:
   ```bash
   pnpm gpu-host:pull     # once: the weights (from the internet; it can take an hour)
   pnpm gpu-host:up       # vllm and the gateway; vllm is healthy when the model is on the GPU
   ```
4. **On the platform server**, in `platform/deploy/.env`: `SDLC_GPU_HOST_NAME` (the name of step 2), `SDLC_GPU_HOST_ADDR` (its address), `SDLC_GPU_LINK_PORT` (as on the GPU host) and `SDLC_VLLM_LINK_TLS_DIR` (the `platform/` folder of step 2). Store the provider entry `vllm` in OpenBao as in [Self-hosted model](#self-hosted-model-operator) step 4 (`api_base=http://vllm:8000/v1`). Then:
   ```bash
   pnpm compose:models-remote
   ```
   `up.sh` refuses `models-local` and `models-remote` together, and refuses `models-remote` without these settings. Restart `litellm-agent` and `litellm` if they were already running.
5. **Check:** `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile models-remote ps vllm-link litellm` shows both healthy, and `docker compose … logs vllm-link` shows `"status":200` for `/v1/models` after LiteLLM starts. Then register an agent as in step 6 of [Self-hosted model](#self-hosted-model-operator).

### Renew the certificates

`pnpm gpu-link:tls check <folder>` and `pnpm gpu-host:up` / `pnpm compose:models-remote` warn 30 days before a certificate ends. Issue new ones into a new folder (step 2), copy them over the old files on each machine, then on each machine:

```bash
pnpm gpu-link:tls reload gpu-host   # on the GPU host
pnpm gpu-link:tls reload platform   # on the platform server
```

No restart is needed. When the CA itself changes, do both sides at the same time: until both have the new CA, the link refuses the calls (the agents' calls fail, nothing is sent in clear).

## Shared Valkey: memory limit

Langfuse and LiteLLM share one Valkey with `maxmemory-policy noeviction`, which Langfuse requires. The limit is `VALKEY_MAXMEMORY` in `.env` (default `256mb`). **When Valkey is full, writes fail for both Langfuse and LiteLLM.** Watch memory use:

```bash
docker compose -f platform/deploy/docker-compose.yml exec valkey sh -c 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli info memory' | grep used_memory_human
```

## Resource estimate

Measured with `docker stats` on a development machine (Docker Desktop, 8 GiB VM), at idle, right after start-up, on 2026-09-25. These are **estimates only**; task A10 does the formal measurement on the target server.

| Profile | RAM in use (idle) | Suggested minimum for the server | CPU |
|---|---|---|---|
| `core` | about 1.3 GiB (LiteLLM about 0.8 GiB; PostgreSQL, Temporal, SeaweedFS about 0.15–0.2 GiB each; Valkey, OpenBao, Temporal UI under 30 MiB each) | 3 GiB RAM | 2 vCPU. Idle use is well below one core |
| `core + observability` | about 3.7 GiB (adds Langfuse web about 1.3 GiB, Langfuse worker about 0.75 GiB, ClickHouse about 0.4 GiB) | 6 GiB RAM | 4 vCPU |

- Disk for images: about 4.5 GB for `core` and about 4.7 GB more for `observability`. Data volumes start small and grow with use.
- Add room for the platform processes (api, worker, runner) and 1–2 agent sandboxes (D-03 section 10.1).
- Profile `models-remote`: `vllm-link` is one nginx container (under 20 MiB). The GPU host needs what the profile `models-local` needs below.
- Profile `models-local`: the GPU memory comes from the model (a 30B-class model in 16-bit needs about 60 GB of GPU memory plus room for the context; task L03 gives the sizing). On the host: RAM about the size of the weights while loading, `SDLC_VLLM_SHM_SIZE` (8 GB) of shared memory, and disk for the weights in the volume `vllm-models` (about 60 GB for the default model) plus about 10 GB for the image.
- Profile `sandbox` (estimates, A10 measures): socket proxy about 10 MiB, runner about 100–150 MiB, Verdaccio about 100–200 MiB, registry about 20 MiB, so about 0.3–0.4 GiB in total, plus **up to 2 GiB per sandbox** (`SDLC_RUNNER_SANDBOX_MEMORY_MB`, 1 sandbox by default). Disk: the `node24` image is about 0.85 GB compressed and about 3 GB unpacked; the npm cache grows with use (1–5 GB typical); clones up to `SDLC_RUNNER_WORKSPACE_MAX_MB` per running sandbox.

## Backup and restore

`pnpm backup` backs up the whole platform into one encrypted folder: every database, OpenBao's snapshot, the volumes of SeaweedFS (evidence, audit anchors), OpenBao's audit log and ClickHouse, the env file and OpenBao's TLS folder (task A10, `design/ADR-M63-openbao-tls-and-backups.md`). Each part is encrypted with `age` as it streams; the server holds only the public key, so it cannot read its own backups.

| Setting (env file) | Meaning |
|---|---|
| `SDLC_BACKUP_DIR` | Target folder, outside the repository: a mounted NAS or an external disk. Copying it further away is the company infrastructure's job |
| `SDLC_BACKUP_AGE_RECIPIENTS` | File with the age public key (`age1…`). The private key stays offline with the OpenBao key shares |
| `SDLC_BACKUP_KEEP` | How many backups to keep (default 14) |

- Set up once: install `age`, make the key pair away from the server, set the variables, `pnpm openbao:bootstrap backup-credentials`, and the daily systemd timer (`backup/sdlc-backup.service`, `.timer`): [runbook T11 §6](../../handbook/03-templates/T11-openbao-runbook.md#6-daily-backup).
- SeaweedFS and ClickHouse stop for about a minute during the copy; run it at night (the timer: 02:30).
- A backup that did not run: `pnpm doctor` (`backup.recent`) and [Alerts](#alerts) say so after `SDLC_BACKUP_WARN_HOURS` (26 hours).
- Restore, also the recovery drill every 3 months: `pnpm restore <backup folder> <age private key file>` into an empty stack, then two key holders unseal with their original shares: [runbook T11 §7](../../handbook/03-templates/T11-openbao-runbook.md#7-restore-and-the-recovery-drill). `pnpm test:backup` runs the whole drill on throw-away keys.
- Every backup holds personal data, client code (the evidence) and every password, encrypted: treat it like the server.

## Database growth

Some tables only grow (task O04, `design/ADR-M103-growing-data.md`):

- **The append-only tables** (`audit_log`, `gate_decisions`, `run_events`, `cost_records` and the others of R030) are kept at least 2 years and never deleted. They hold codes, IDs, hashes and counts only: about 300–700 bytes a row with their indexes, so a busy deployment adds well under 1 GiB a year. `pnpm doctor` (`db.table_size`), and so [Alerts](#alerts), warn when one reaches `SDLC_DB_TABLE_WARN_GB` (default 20 GiB, set in the env file). That is years of notice to add monthly partitions; ADR-M103 §2.4 describes how.
- **The dashboard's sessions and passkey challenges** are removed by the worker's retention loop, also without the evidence identities. A session goes 30 days after it ended (`SDLC_WORKER_SESSION_KEEP_DAYS`, at least 7), a challenge 24 hours after it was used or expired (`SDLC_WORKER_CHALLENGE_KEEP_HOURS`, at least 1). `SDLC_WORKER_HOUSEKEEPING_MODE`: `remove` (default), `report` (counts only, in the log line `worker.housekeeping_pass`) or `off`. Each tenant with removals gets one audit event `housekeeping.removed` with the counts. The database itself refuses any other removal of these rows.

## Upgrade

Upgrade to a **release tag** (`vX.Y.Z`), and follow the "Upgrade notes" of every release between yours and the new one in the [CHANGELOG](../../CHANGELOG.md): they list the migrations, the credentials commands to run again and the changed settings ([RELEASING.md](../../RELEASING.md)). The first bullet of each release's notes says what every running stack must do; the other bullets are optional or explain one change. `main` is for developers: it may hold changes that are not released yet.

Before you start, let the running intents reach a gate: an intent that waits at a gate goes on after the upgrade, while a run that is going on may be refused by the new release (the Upgrade notes say when). `pnpm test:upgrade` runs these steps on a throw-away stack, from the previous release to the new one (section [Tests](#tests)).

1. **Backup.** `pnpm backup` ([above](#backup-and-restore)), still on the old release. It holds OpenBao's snapshot, the way back after an OpenBao image change ([T11 §4b](../../handbook/03-templates/T11-openbao-runbook.md#4b-upgrading-the-openbao-image)).
2. **The new release.** `git fetch --tags`, then `git checkout vX.Y.Z`, then `pnpm install && pnpm build`. Update the `adlc` command of each person to the same version: `npm install -g @hoanghainh/governed-adlc@<version>` (before v0.9.0: `agentic-sdlc-cli@<version>`).
3. **New settings.** Add the keys that are new in `.env.example`; a line that is already in `.env` is never changed:

   ```bash
   pnpm compose:env --add-missing
   ```

   It prints the names of the keys it added, with a random value for each new secret, never a value. Check the new lines against the Upgrade notes (a host port, a path). After the A10 update (TLS on OpenBao): `pnpm openbao:tls dev` on a development machine; on the server, the company CA ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)).
4. **The images.** On a release tag (step 2) there is nothing to build: `up.sh` in step 9 pulls the release's images, and `sandbox.image` takes `pnpm images get SANDBOX_NODE24` ([Verify the published images](#verify-the-published-images) first). Developers on a branch pull the pinned images (`--ignore-buildable`: the platform images are built, not pulled) and rebuild the platform images (and the sandbox image when `platform/sandbox-images/` changed: `pnpm sandbox-image:build node24`, then the new digest in `sandbox.image`):

   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile platform --profile sandbox pull --ignore-buildable
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile platform --profile sandbox build
   ```

   Add `--profile observability` (or another optional profile) when you use it.
5. **Stop.** `pnpm compose:down` stops and removes the containers; the volumes, and so the data, are kept.
6. **Unseal.** Start only OpenBao, PostgreSQL and SeaweedFS, and two key holders unseal OpenBao ([Restart after a reboot](#restart-after-a-reboot), the first three commands).
7. **Migrations.** `pnpm db:migrate` ([Fresh deployment, step 6](#6-database)); `pnpm db:status` lists no pending migration afterwards.
8. **Credentials.** Run the `pnpm openbao:bootstrap …` commands that the first bullet of the Upgrade notes names, release by release, in their order (none when it says so). `configure` needs a root token: make one from two key shares with `pnpm openbao:bootstrap root-token` (`configure` revokes it again). The credentials commands take the admin token of [Fresh deployment, step 3](#3-openbao).
9. **Start.** `platform/deploy/scripts/up.sh core models platform sandbox` ([step 7](#7-start-the-platform); add your optional profiles). It starts `sdlc-worker` and `sdlc-runner` together, from the same release.
10. **Check.** `curl -s http://127.0.0.1:8090/health/ready`, no `…_missing` line in the logs ([Troubleshooting](#troubleshooting)), `pnpm adlc ops audit verify` (the audit chain is intact), and the intents that waited at a gate go on (`pnpm adlc intent show <INT-…>`). `pnpm doctor` checks the rest.

Never run `docker volume prune` or `docker system prune --volumes`: they delete the platform's data.

## Verify the published images

Each release publishes seven images on GHCR (D-08 V04, `design/ADR-M66-ghcr-images.md`), for `linux/amd64` and `linux/arm64`: `sdlc-api`, `sdlc-worker`, `sdlc-runner`, `sdlc-otel-collector`, `sandbox-node24`, from v0.6.0 `tool-project-docs` and, from the release after v0.13.0, `tool-code-index` (the `read_code` tool, X06), under `ghcr.io/hoanghainh1188/governed-adlc-fw/`. The release's `images.lock` pins each one by digest. They are built on the release tag by `.github/workflows/release-images.yml` (called by `release.yml`), all seven scanned with Trivy before the first push and each one again by digest after it (no CRITICAL finding), signed with cosign keyless (GitHub OIDC, Sigstore's public transparency log), and carry an SPDX SBOM and SLSA build provenance.

Check an image before you deploy it; `pnpm images get <NAME>` prints its reference (`API`, `WORKER`, `RUNNER`, `OTEL_COLLECTOR`, `SANDBOX_NODE24`, `TOOL_PROJECT_DOCS`). `pnpm images verify` checks all six at once with the release workflow's own check (it needs `cosign` and a signed-in `gh`). With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.x:

```bash
cosign verify --certificate-identity-regexp '^https://github\.com/hoanghainh1188/governed-adlc-fw/\.github/workflows/release-images\.yml@' --certificate-oidc-issuer https://token.actions.githubusercontent.com "$(pnpm --silent images get API)"
```

The certificate must name that workflow file: a signature from any other workflow or person fails. The exact identity ends with the ref the release was built on: `release-images.yml@refs/tags/vX.Y.Z` from the release after v0.6.0, `release-images.yml@refs/heads/main` for v0.6.0 and before. To pin it exactly, use `--certificate-identity https://github.com/hoanghainh1188/governed-adlc-fw/.github/workflows/release-images.yml@refs/tags/vX.Y.Z` instead of the pattern. With the GitHub CLI, the build provenance:

```bash
gh attestation verify "oci://$(pnpm --silent images get API)" --repo hoanghainh1188/governed-adlc-fw
```

The SBOM (the packages inside, SPDX JSON) and BuildKit's provenance:

```bash
docker buildx imagetools inspect "$(pnpm --silent images get API)" --format '{{ json (index .SBOM "linux/amd64").SPDX }}'
docker buildx imagetools inspect "$(pnpm --silent images get API)" --format '{{ json (index .Provenance "linux/amd64").SLSA }}'
```

A tag (`0.2.0`, `sha-<commit>`) never moves, but use the digest anyway: the platform always does.

## Doctor (`pnpm doctor`)

`pnpm doctor [--env <file>] [--json]` checks the deployment on the machine of the stack and prints one line per check (ok, warning, failed, skipped) with, under each problem, the command or the section of this guide or runbook T11 that fixes it (task V07, `design/QUESTIONS.md` #400–#404). The env file is `platform/deploy/.env` (the trial stack uses it too) unless `--env` names another one. The option is `--env`, not `--env-file`: Node.js reads `--env-file` itself and would load the secrets.

| Check | What it reads |
|---|---|
| `host.docker`, `host.memory`, `host.disk` | Docker and Compose versions (Compose 2.24 or later), Docker's memory (8 GiB), free disk next to the env file and in `SDLC_BACKUP_DIR` (a warning below 20 GiB, failed below 5 GiB) |
| `backup.recent` | The newest complete backup in `SDLC_BACKUP_DIR` (a `<UTC time>` folder with `MANIFEST`; only names are listed): a warning after `SDLC_BACKUP_WARN_HOURS` (26), failed after `SDLC_BACKUP_FAIL_HOURS` (50). Skipped without `SDLC_BACKUP_DIR` (a trial or dev stack) |
| `env.file`, `env.secrets` | The env file exists with mode 600; every secret `.env.example` marks `CHANGEME` is set (names only, never a value) |
| `services.health` | `docker compose ps`: unhealthy or restarting services, a failed one-shot job, a `core` service not running. A stopped stack is a warning and the checks that need it are skipped |
| `openbao.state`, `openbao.tls_files`, `openbao.tls_expiry` | `pnpm openbao:bootstrap status`; the CA and server certificate in `SDLC_OPENBAO_TLS_DIR` and their end dates (a warning within 30 days). Never the key file |
| `db.migrations` | The applied migrations (`psql` in the postgres container as `platform`, a read-only session) against the migration files of this checkout |
| `db.table_size` | The size of each append-only table with its indexes (a read-only `SELECT` of `pg_total_relation_size`): a warning from `SDLC_DB_TABLE_WARN_GB` (20 GiB) per table. See [Database growth](#database-growth) |
| `credentials.approle` | Each process's AppRole files exist, and the secret ID's age (a warning 14 days before the 90 days end, `SDLC_APPROLE_WARN_DAYS`; failed at 90; renew them all with `pnpm openbao:bootstrap rotate-credentials`): `test -s` and `stat` inside the service, never the content |
| `credentials.logs` | Event codes of the last 24 hours of the `sdlc-api`, `sdlc-worker` and `sdlc-runner` logs: `…_missing`, `worker.runs_off`, `worker.cost_sync_off`, `worker.cost_sync_gap`, a failed AppRole login, a sealed OpenBao. Only the event field is read; no line is printed |
| `models.litellm` | The platform runs with the profile `models` (the LiteLLM sidecar) |
| `valkey.memory` | Valkey's used memory against its limit (a warning at 90 %) |
| `sandbox.image` | Each active project's effective `sandbox.image`, and its `sandbox.images.opencode` when set (shown as `<project> (opencode)`), is pinned by digest and present on this machine |
| `github.app` | The GitHub App's permissions and each project repository's installation against `platform/deploy/github-app/manifest.json`. The worker runs the check with its own AppRole (`docker compose exec -T sdlc-worker node /app/dist/doctor-github.js`, read only, codes only), so the App key never leaves OpenBao and the worker; skipped while OpenBao is sealed or the worker is stopped |
| `images.mode` | `pnpm images mode` (`local` or `published`) |
| `access.proxy`, `access.tls_files`, `access.tls_expiry`, `access.tls_names`, `access.ports`, `access.public_origin`, `access.trusted_proxy` | Team access (V09): `sdlc-access` runs and is healthy; its CA and certificate in `SDLC_ACCESS_TLS_DIR`, their end dates (a warning within 30 days) and whether the certificate names `SDLC_ACCESS_HOSTNAME` and `SDLC_ACCESS_IPS` (never the key file); every published port of the project on `127.0.0.1` except the proxy's on `SDLC_ACCESS_BIND_ADDR` (a warning on `0.0.0.0`); `SDLC_API_PUBLIC_ORIGIN` is the proxy's origin; `SDLC_API_TRUSTED_PROXY` is the proxy's address. Without team access: one line says it is off, and the ports are still checked |

**Read only.** It runs only the commands of its allowlist (`platform/deploy/doctor/src/commands.ts`): no `up`, `down`, `rm`, `prune`, no OpenBao command other than `status`, no SQL that writes. It prints no secret (never a token, key share, password or key) and works on a stopped or sealed stack: it says so instead of failing. It may run anywhere a person runs commands for the stack, including through Claude Code. Exit 0 when no check failed (warnings included), 1 when one did, 2 for a usage error. A person checks their own login with `adlc doctor` (handbook Ch.19 §19.8c).

## Alerts

`pnpm alerts [--env <file>] [--dry-run | --test]` runs the checks of [`pnpm doctor`](#doctor-pnpm-doctor) and sends what changed to the operator: by a chat webhook, by e-mail, or both (task O03, `design/ADR-M101-operational-alerts.md`). It needs no profile: it works with `observability` off and while the platform is down or OpenBao is sealed, which is when an alert matters most.

**What is sent, and when.** Every `warning` and `failed` line of doctor, including a stopped stack, a sealed OpenBao, a full disk or backup target, a backup that did not run and a TLS certificate near its end:

- a problem when it is new or its status changes (warning to failed);
- the same problem again after `SDLC_ALERT_REMIND_HOURS` (24) while it stays;
- a "resolved" line when it is no longer a problem. A skipped check (for example while the stack is stopped) changes nothing.

A message holds the host name, the check, its subject (a service, a certificate, a folder), doctor's text and its fix. Never an env value, a secret, a log line or a command's output. What was sent is kept per channel in the state file (`alerts-state.json` next to the env file, mode 600: channel names, check IDs, statuses and times only). A channel's state changes only when that channel took the message, so a channel that is down is tried again on the next run and the others do not repeat.

| Setting (env file) | Meaning |
|---|---|
| `SDLC_ALERT_WEBHOOK_FILE` | A file of the operator account, mode 600, outside the repository and not a link, that holds the webhook URL alone. Never the URL itself in the env file: it holds a token. Only `https://`; redirects are not followed |
| `SDLC_ALERT_WEBHOOK_FORMAT` | `text` (default): `{"text": "…"}` for Slack, Google Chat, Mattermost and Rocket.Chat. `json`: `{version, host, sent_at, items: [{kind, check, subject, status, message, fix}]}` for your own receiver |
| `SDLC_ALERT_EMAIL_TO`, `SDLC_ALERT_EMAIL_FROM` | Addresses, comma-separated, and an optional sender. The mail goes through the server's `sendmail` (`SDLC_ALERT_SENDMAIL`, default `/usr/sbin/sendmail`): the platform holds no SMTP password |
| `SDLC_ALERT_REMIND_HOURS` | When a problem that stays is sent again (default 24) |
| `SDLC_ALERT_HOST_NAME` | The name in each message (default: the machine's name) |
| `SDLC_ALERT_STATE_FILE` | Another place for the state file (an absolute path) |
| `SDLC_BACKUP_WARN_HOURS`, `SDLC_BACKUP_FAIL_HOURS` | The age of the newest backup that is a warning (26) or a failure (50); the warning must be smaller |

Set up once, on the server ([runbook T11 §6b](../../handbook/03-templates/T11-openbao-runbook.md#6b-operational-alerts)):

1. Put the webhook URL alone in a file: `install -m 600 /dev/null /etc/sdlc/alert-webhook-url`, then write the URL into it with an editor. Set `SDLC_ALERT_WEBHOOK_FILE`, or `SDLC_ALERT_EMAIL_TO`, or both.
2. `pnpm alerts --test`: a test message through every channel, without running the checks. `pnpm alerts --dry-run` prints what would be sent and changes nothing.
3. The schedule is the server's, never the platform's: the systemd timer `alerts/sdlc-alerts.service` and `.timer` (every 10 minutes), or the cron line in the unit file.

Exit 0 when the run is done (sent, or nothing to send), 1 when a channel failed (the line says which one and why, as a code; never the URL) or the state could not be written, 2 for a usage error or a bad setting (the line names the key; also a state folder that cannot be written).

## Troubleshooting

Run `pnpm doctor` first ([Doctor](#doctor-pnpm-doctor)): it checks the rows of this table and prints the fix. A person's own login and the API: `adlc doctor`.

| You see | Cause | Do |
|---|---|---|
| `sdlc-api`, `sdlc-worker` or `sdlc-runner` restart every minute; the log says "OpenBao at … is sealed" | OpenBao is sealed after a restart | `pnpm openbao:bootstrap status`, then two key holders unseal it (runbook T11 §4) |
| `up.sh` times out with the `core`, `platform`, `models` or `sandbox` profile | OpenBao is sealed, or `up.sh core` was run alone on the server (LiteLLM has no keys without `models`) | Follow [Restart after a reboot](#restart-after-a-reboot) |
| A log line ending in `_missing` (for example `worker.evidence_missing`) | A process has no credential for that feature | Run the credentials command the message names ([step 5](#5-credentials-of-every-process); `worker-langfuse-credentials` and `worker-knowledge-credentials`: [step 7](#7-start-the-platform)), then restart the service |
| `openbao` does not start; `openbao-tls-init` says a file is missing in `SDLC_OPENBAO_TLS_DIR` | No TLS certificate for OpenBao (an `.env` from before A10, or a missing file) | Development: `pnpm openbao:tls dev`. Server: [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal) |
| `up.sh` warns that OpenBao's TLS certificate ends soon | Less than 30 days left | Renew: [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal); OpenBao stays unsealed |
| "AppRole login failed (HTTP status 400)" in a log | The AppRole secret ID expired (90 days) or was destroyed | That process's credentials command again, then restart it |
| `worker.runs_off`; every intent waits at G4 | The worker has no `cost-controller` AppRole | `pnpm openbao:bootstrap worker-credentials`, restart `sdlc-worker` |
| Intents wait at G8; packs answer `evidence_unavailable` | No evidence credential for the worker or the API | `api-evidence-credentials` (runbook T11 §5h) or `worker-evidence-credentials` (§5i) |
| `worker.cost_sync_gap` | The spend sync was down longer than its catch-up window | [Scheduled spend sync](#scheduled-spend-sync-c12) |
| An evaluation stays `queued`, or the worker logs `worker.evaluation_failed` or `worker.evaluation_refused` | The runner has no evaluation slot (`SDLC_RUNNER_MAX_EVAL_SANDBOXES=0`, or every slot is busy with a real run), the worker has no `cost-controller` AppRole, the GitHub App is not installed on the sample repository, or the budget or the model was refused | [Evaluations on the server](#evaluations-on-the-server-l04) |
| LiteLLM lists no model | Profile `models` not started, or the provider entry is not in OpenBao | `pnpm compose:models`; runbook T11 §5d |
| A service stays unhealthy | See its log | `docker compose -f platform/deploy/docker-compose.yml logs <service>`; [what "healthy" means](#health-what-healthy-means) |
| Valkey writes fail in Langfuse and LiteLLM | Valkey is full | [Shared Valkey](#shared-valkey-memory-limit) |
| The trial stack does not start after a reboot or `pnpm trial:down`; the services restart every minute | OpenBao of the trial stack is sealed | `pnpm trial:start` (it asks for the passphrase you chose at `trial:up`; [TRIAL.md §3.2](../../TRIAL.md#32-the-platform)). A trial stack set up before `trial:start` existed has no key file: `pnpm trial:down --wipe`, then `pnpm trial:up` |
| `up.sh` says the profile access is not ready | A team access setting is missing or wrong (the line before names it) | Fix that setting ([Team access](#team-access-operator)), then start again |
| `sdlc-access` does not start; `access-tls-init` says a file is missing in `SDLC_ACCESS_TLS_DIR` | No certificate for the proxy | `pnpm access:tls import`, `server` or (test machine) `dev`: [T11 §3d](../../handbook/03-templates/T11-openbao-runbook.md#3d-tls-for-team-access-the-proxys-certificate) |
| People on other machines get a certificate error | Their machine does not know the CA, or the address is not a name in the certificate | `NODE_EXTRA_CA_CERTS=<ca.pem>` for the CLI, the CA in the browser; open the name of `SDLC_ACCESS_HOSTNAME`; `pnpm access:tls check` |
| Every person gets `429` at the same time | The proxy sees one shared client address (Docker Desktop, some rootless set-ups) | Run the stack on Docker for Linux with the default port publishing ([Team access](#team-access-operator)) |

Problems with a gate or an intent (refused commands, held intents, escalations): [USER-GUIDE §5](../USER-GUIDE.md#5-when-something-goes-wrong). Still stuck: open an issue with the bug report template, and never paste a log line with a secret or client data. Security problems: [SECURITY.md](../../SECURITY.md).

## Uninstall

This deletes every intent, the evidence, the audit log and the secrets. Keep a backup first if the records must be kept (the audit log at least 2 years, handbook Ch.3).

1. Stop and remove the containers and their volumes: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile observability --profile models --profile platform --profile sandbox --profile access --profile knowledge down -v`.
2. Remove the per-run objects the runner may have left after a crash: containers, networks and volumes whose name starts with `sdlc-sandbox-`, `sdlc-run-` or `sdlc-ws-` (`docker ps -a`, `docker network ls`, `docker volume ls`).
3. Remove the images if you want the disk back (`docker image ls`).
4. On GitHub: uninstall the GitHub App from the repositories, then delete the App and its private key.
5. Revoke the model provider keys that were stored in OpenBao, at each provider.
6. Delete `platform/deploy/.env` and the checkout.

## Tests

| Command | What it checks | Needs Docker |
|---|---|---|
| `pnpm test` | Static checks of the compose file, `.env.example`, `init-env.sh` and `.gitignore` (`platform/tests/deploy/`) | No |
| `pnpm test:db` | Migrations and tenant isolation on a throw-away PostgreSQL container (same image and init script). Takes about 10 seconds ([ADR-M09](../../design/ADR-M09-database-tooling.md) section 2.6) | Yes |
| `pnpm test:backup` | A10 PR 2: the backup and the restore drill on a throw-away Compose project (age, throw-away keys): data in every store, `pnpm backup`, the stack removed, a tampered copy refused, `pnpm restore`, the original shares unseal, every piece of data back. A few minutes. Needs `age` | Yes |
| `pnpm test:openbao` | OpenBao bootstrap (A03): starts only `openbao` in a throw-away Compose project, runs `init`, `unseal`, `configure`, `root-token`, checks every AppRole's access, re-runs `configure`, then removes everything. Throw-away keys, kept in memory only. Also TLS (A10, `tls.test.ts`): a wrong CA, an address other than `openbao` and plain HTTP are refused, a renewal is read without a restart, a missing file stops OpenBao. A few minutes | Yes |
| `pnpm test:runner` | The runner on the local Docker Engine: sandbox egress and hardening, the provisioning flow, the clean-up after a restart (throw-away PostgreSQL, fixture image) | Yes |
| `pnpm test:runner-compose` | The `sdlc-runner` container in the profile `sandbox` on a throw-away Compose project: `runner-credentials`, socket proxy, clean-up at start, health check, no secret in the container. About 1 minute | Yes |
| `pnpm test:sandbox-image` | Builds the sandbox images `node24` and `node24-opencode` and runs them hardened with the real Verdaccio: Node 24, pnpm through corepack and the proxy, no other way out. Needs internet | Yes |
| `pnpm test:observability` | A08 AC3: `core + models + observability` on a throw-away Compose project (ports +27000) with a stub model and throw-away OpenBao keys. One model call through LiteLLM must give a Langfuse trace with all seven labels; a span of a platform process must reach Langfuse through the collector; the collector has no host port. About 2 minutes | Yes |
| `pnpm test:fresh-deploy` | E07 AC3: follows the section [Fresh deployment](#fresh-deployment-operator) on a throw-away Compose project (ports +31000, throw-away keys): `compose:env`, OpenBao init, unseal and configure, the shared secrets, every credentials command, the migrations, `up.sh core models platform sandbox`, `ops bootstrap`, the team, the sandbox image, the agent, the configuration, the AI record and the first intent at G1, then `adlc audit verify`. CI: weekly and manual runs only. Prints `e07:fresh_deploy_seconds` | Yes |
| `pnpm test:upgrade` | O02: follows the section [Upgrade](#upgrade) on a throw-away Compose project (ports +34000, throw-away keys): the previous release (a git worktree of its tag, its published images by digest) deployed like [Fresh deployment](#fresh-deployment-operator) with an intent waiting at G1, then the ten steps to this checkout (or `SDLC_UPGRADE_TO=<tag>`) with the credentials commands of the Upgrade notes; the intent goes on to G2, a new intent reaches G1, and the audit chain verifies. Needs `age` and the release tags. About 15 minutes between two releases with published images. CI: weekly and manual runs only. Prints `o02:upgrade_seconds` | Yes |
| `pnpm test:access` | V09: the profile `access` on a throw-away Compose project (ports +36000, throw-away OpenBao keys and CA): from a container on another network only the proxy answers, TLS verified with the CA and refused without it, the routes (`/health/ready` included), plain HTTP `400`, another host `421`, a large body `413`, the headers and the dashboard's CSP unchanged, the proxy's rate limit, a forged `X-Forwarded-For` does not escape the api's limit, the proxy cannot reach PostgreSQL, OpenBao or SeaweedFS, `adlc whoami` through it, a renewal without a restart. A few minutes | Yes |
| `pnpm test:compose` | Starts `core`, then `core + observability`, with a throw-away env file, its own project name and ports shifted by 20000. Checks health, databases, namespace, buckets, Valkey policy, OpenBao state, Langfuse sign-up and trace upload. Removes everything afterwards. Takes about 2–5 minutes | Yes |
