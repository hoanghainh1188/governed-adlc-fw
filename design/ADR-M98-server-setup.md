# ADR-M98. `pnpm server:setup`: a guided fresh deployment on a server

| Item | Value |
|---|---|
| Status | **Accepted** (task V16). Version 1.1: §2.5, team access and the runner link in the settings (task V20). Version 1.2: §2.6, steps 8–13 (task V19) |
| Date | 2026-10-29 |
| Decided by | Harry (QUESTIONS #616–#618 accepted with changes, 2026-10-28, PR #453; V16 plan approved 2026-10-29; V18–V20 plan approved 2026-11-11, QUESTIONS #673) |
| Related | D-08 tasks V16, V17, V19, V20; QUESTIONS #616, #618, #671, #673; ADR-M67 (team access); ADR-M91 (the runner on its own Engine); ADR-M19 (OpenBao bootstrap); ADR-M76 (the trial key file); ADR-M63 (TLS); runbook T11 §3.2, §5, §5.1; `platform/deploy/README.md` "Fresh deployment"; rules R035, R081 |

## 1. Context

A fresh deployment on a server takes 14 steps by hand. Steps 3–5 alone are OpenBao `init`, `unseal`, `configure`, a new root token, an admin token that lives one hour, and ten credentials commands; step 6 needs a database URL built by hand from `.env`. `pnpm trial:up` already runs these steps, but only with throw-away keys on a developer machine (ADR-M76). QUESTIONS #616 asked for one guided command for steps 2–7 on a server, and Harry accepted it with binding changes: the root token only for `configure`; one admin token for steps 4 and 5; no token in an environment variable, a command line or a log; a revoked root token on any stop before `configure`; a refusal without a terminal; the screen and scroll-back cleared after each share; `-pgp-keys` by default.

## 2. Decision

### 2.1 One sequence, three callers

The step code of README steps 3–7 moves from `platform/deploy/trial/src/up.ts` into `platform/deploy/steps/` (a TypeScript project like `trial/`, not a workspace package). `pnpm server:setup` (`platform/deploy/server-setup/`), `pnpm trial:up` and the live test `pnpm test:fresh-deploy` use it, so the three keep one sequence (R081). `trial:up` and `server:setup` import its built files (`../../steps/dist/*.js`, the layout at run time); the tests read its sources through a Vitest alias, so `pnpm test` needs no build. `test:fresh-deploy` runs steps 2–7 through `serverSetup()` itself, with a scripted terminal that plays the three key holders and throw-away keys; steps 8–14 stay in `deploy-steps.ts`, which `test:upgrade` also uses on older release checkouts.

### 2.2 Key custody (T11 §3.2)

- The command calls `bao operator init -format=json` itself, through `docker compose exec`, and holds the output in memory only.
- When the settings name a PGP public key for every key holder, `init` gets `-pgp-keys` (the default). The public keys go to a temporary folder of the container on stdin, and are removed at once. Each share comes back encrypted for its holder: the command never sees a share in clear. Either all three keys or none: a mix is a settings error.
- Each share is shown to one named holder at a time. Before and after each one, the command clears the screen and the scroll-back (`ESC [3J ESC [H ESC [2J`); the holder confirms the copy with Enter. No share is written to a file.
- The command refuses to run when stdout or stdin is not a terminal, so a share or a prompt can never go to a file or a pipe. The Claude Code hook refuses `pnpm server:setup` and its `node … server-setup/dist/main.js` form (R035).

### 2.3 Tokens

- `configure` gets a new option, `--issue-admin-token`: just before it revokes the root token, it creates one admin token (role `platform-admin`, at most 1 hour) and prints it as its last line, `admin-token: <token>`. `bootstrap.sh` refuses the option when its stdout is a terminal, and with `--keep-token`. So the root token is used for `configure` and nothing else, and one admin token covers steps 4 and 5 and the credentials commands of step 7. `trial:up` uses the same option, so it no longer keeps the root token for steps 4 and 5.
- In the run that initialises OpenBao, `configure` gets init's own root token. In any other run (a new start after a stop, or an admin token close to its hour), two key holders type their shares at a hidden prompt; the command makes a new root token in memory (`root-token.sh`), runs `configure` again (safe to run again), and gets a new admin token. `configure` revokes the new root token.
- A stop before `configure` succeeds (Ctrl-C at a prompt, SIGINT, SIGTERM or SIGHUP between steps, a failed child) revokes the root token. A token counts as revoked only when OpenBao revokes it or answers "permission denied"; a sealed or unreachable OpenBao is no answer. While OpenBao is still sealed (between `init` and `unseal`) nothing can revoke a token: the command says so and records it in the progress file (`leftoverRoot`), and the next start, once it holds a new root token from two shares, revokes every other root token by its accessor before it runs `configure`. A sealed OpenBao accepts no token, so the old one is of no use until then.
- A `configure` that fails after it made the admin token revokes that token. The admin token is revoked when the command stops or ends; when OpenBao does not confirm it, the command says so (it expires within the hour).
- While the shares are handed out they exist only in the command's memory: a Ctrl-C there warns that a stop means a new `init` on wiped volumes and shows the share again; a second Ctrl-C stops. `init` output that holds the shares is used even when the child then exits with an error.
- Every secret file the settings name must be readable by its owner only (mode 600 or stricter), or the command refuses it.
- Every token, share, password and key reaches a child on stdin. None goes into an argument or an environment variable. Every value is kept in a `SecretBag`, so a failure shows the end of a child's output redacted. The migrations read the owner's URL from standard input (`migrate-cli --url-stdin`, new), not from `SDLC_DB_MIGRATION_URL`.
- `api-github-oauth-credentials` reads its token from `/dev/tty` when it can. The command starts it in a new session without a controlling terminal (`detached`), so it reads the token from stdin.

### 2.4 Settings, steps and starting again

- The settings file is YAML outside the repository (`server-settings.example.yaml`). It holds paths and public keys, never a secret: the key holders, the GitHub App, the model providers (`anthropic` with a key file or a hidden prompt, `ollama` with its address), the optional parts of step 7 (`observability`, `knowledge`, `dashboard-signin`, `dashboard-actions`) and `throwaway_tls` (development machines and tests only).
- Step 2 runs `compose:env`, which never overwrites. A new `.env` gets empty LiteLLM keys (server mode). An existing one with LiteLLM keys, or with a trial project, is refused. A new `.env` stops the command after step 2, so OpenBao's certificate comes from the company CA first (T11 §3c), unless `throwaway_tls` is set.
- Each step checks the state before it acts: OpenBao uninitialised, sealed or unsealed; the migrations (running them when none is pending changes nothing); the credentials already delivered. A progress file next to `.env` (`server-setup-progress.json`, mode 600, ignored by Git) records the steps and commands done and where the last run stopped, with step names, codes and times only. A new start says where the last run stopped.
- A failure names the step, the child that failed and the README section; it ends with `pnpm doctor`. Every message goes through the catalog (`serverSetup.*`).

### 2.5 Team access and the runner link (V20, version 1.1)

- Two optional sections of the settings (QUESTIONS #673). `access`: the host name (a DNS name, never an IP address), the bind address, the port (default 8443), the CLI's IPv4 addresses, `tls_dir` and, optionally, the company CA's folder. `runner_link`: the link address, the runner host's source block and its Docker host (`ssh://` or `unix:///`, the forms `bootstrap.sh runner-credentials` accepts). Neither holds a secret.
- Step 2 writes their env keys (`SDLC_ACCESS_*`, `SDLC_API_TRUSTED_PROXY` = the proxy's address, `SDLC_RUNNER_LINK_ADDR`, `SDLC_RUNNER_SOURCE_CIDR`, `SDLC_RUNNER_DOCKER_HOST`), also on a new env file before the stop for the certificate. An empty key, or the template's default port, is set; a key that holds another value is refused before anything changes (`env_conflict`), never overwritten.
- The runner host's address is in the env file before `configure`, so the AppRole `runner` accepts it at once and the key holders meet once (README "Before you start on a server"). When it is added after `configure` was done, the next start runs `configure` again (two shares) and delivers `runner-credentials` again, now into the runner host's volume. Step 5 needs the runner host's Engine (D-08 V18); the command does not set it up.
- Step 7 with `runner_link`: it removes a runner of an earlier start from the platform's Engine (`compose rm --stop --force sdlc-runner docker-socket-proxy npm-proxy`, once), then starts the profile `runner-link` instead of `sandbox`; with `knowledge` it restarts only the worker. It ends by saying how to start the runner on the runner host.
- Step 7 with `access`: `access:tls import <folder>` once, when the folder is given, then the profile `access`; `up.sh` checks the settings and the certificate as before. With the dashboard sign-in, the public origin is the proxy's (`https://<host>[:<port>]`, ADR-M67 §2.8); another `dashboard.public_origin` is a settings error.

### 2.6 Steps 8–13 (V19, version 1.2)

- Four more keys of the settings, all or none: `tenant` (slug, name), `admin` (email, name), `project_file` (the V17 file) and `sandbox_image` (an image by digest). `ai_record` is optional. None is a secret. Without the four keys, the command ends after step 7 as before, and steps 8–14 stay by hand.
- The steps run after step 7, once the admin token is revoked: they need the api, not OpenBao. Code: `server-setup/src/team-steps.ts`.
- Step 8:
  - `adlc ops bootstrap`. The `platform_app` URL is built from the env file and goes on standard input: `adlc ops … --db-url-stdin` is new for every `ops` command. It is never in `SDLC_DB_URL`.
  - The token comes back in the child's output, which the command keeps in memory. It is shown once, between two clears of the screen and the scroll-back, then given to `adlc login --token-stdin`.
  - A second start skips the step when `adlc whoami` works. When the tenant exists and the admin is logged out, it issues a new token for the admin (`adlc ops token issue`) instead.
- Steps 9–12:
  - The command copies the project file into a private temporary folder. In the copy, `sandbox.image` is set from the settings and the agent's instructions file gets an absolute path. A project file that names another image is refused before step 8.
  - `adlc admin project apply --dry-run` shows the numeric GitHub IDs, and the operator confirms them. Then `--yes` applies the copy, and the copy is removed. A second run finds nothing to change.
- Step 13:
  - With `ai_record`, the command runs `adlc ops ai-record set` on behalf of Person A of the project file (QUESTIONS #671), with the version that `ai-record show` gave.
  - It skips the step when the record already matches the settings.
- The command never approves the agent, never issues a team member's token and never creates an intent. It ends with the commands that `apply` leaves to each person, and step 14 for Person A.
- Markers in the progress file: `8`, `9`, `13`.
- `pnpm test:fresh-deploy` runs the command twice: steps 2–7, then, with the sandbox image built, steps 8–13. A fake GitHub API over HTTPS answers the lookups.

## 3. Consequences

- One sequence for the server, the trial and the live test: a change of a README "Fresh deployment" step changes `platform/deploy/steps` and the tests that check it.
- The real initialisation (A10 PR 3) needs fewer hand-made commands, and no person sees a root or admin token.
- Still by hand: the company CA certificate (T11 §3c), the GitHub App, the key holders' presence, the sandbox image of step 10, and step 14 (and steps 8–13 without their settings).
- With PGP keys, a key holder's copy of their share is encrypted text that only their private key opens; the paper copy is the decrypted share, written on their own computer (T11 §3.2).
- Not covered: the self-hosted model provider (`vllm`, ADR-M71) stays a manual step 4 entry; the profile `models-local` is not started by the command.
