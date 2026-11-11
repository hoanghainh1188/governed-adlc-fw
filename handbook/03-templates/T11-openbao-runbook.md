# T11 Runbook: operating OpenBao (unseal, root token, the processes' credentials, backup, restore)

> Status: **v0.49. Tested on a development machine with throw-away keys (tasks A03, 2026-09-25, and C03, 2026-09-26): sections 3.1, 4, 5, 5b, 5d and 8.1.** Sections 6 and 7 (backup, restore) are tested by `pnpm test:backup` on throw-away keys; section 8.3 (rekey) gives the commands; the drill on the real server is task A10 PR 3.
> Readers: key holders, infrastructure operator, the OpenBao admin (the operator who holds the admin token, section 5.1).
> The real initialisation on the internal server **has not been done**. It waits until leadership names the three key holders.

---

## 1. Purpose and scope

OpenBao is the platform's secret manager. It stores the platform secrets (GitHub App key, LiteLLM master key, model provider keys, database passwords) and signs Run Contracts with a key that never leaves it.

All OpenBao data is encrypted. After every restart OpenBao is **sealed**: it cannot answer any request until key holders **unseal** it with their key shares. If the key shares are lost, every secret is lost.

This runbook covers:
- the first initialisation and TLS (section 3c);
- unsealing after a restart;
- root tokens;
- daily admin work and AppRole secret IDs (an AppRole is OpenBao's login for a machine process: a fixed role ID plus a secret ID that expires);
- the keys of LiteLLM (model provider keys, master key, salt key);
- the credentials of every platform process (sections 5c–5o) and the image upgrade (4b);
- snapshot backup and restore;
- changing a key holder;
- troubleshooting;
- the operations log.

TLS on port 8200 is section 3c.

All commands run from the repo root on the server. They need Docker only. `pnpm openbao:bootstrap <command>` is the same as `platform/deploy/openbao/bootstrap.sh <command>`.

**OpenBao publishes no port on the host** (task A11, `design/QUESTIONS.md` #27). It is reachable only on the Compose network. Every admin and key-holder step therefore runs **inside the OpenBao container**: through `pnpm openbao:bootstrap …`, or through `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao …` as shown below. Do not publish the port to make admin work easier: a static test fails when a compose file publishes port 8200 or 8210.

## 2. Roles

| Role | Who | Holds | Does |
|---|---|---|---|
| Key holder 1 | A leadership representative (named by leadership) | Share 1 | Unseals, creates root tokens, rekeys |
| Key holder 2 | Tech lead / platform owner (named by leadership) | Share 2 | Same |
| Key holder 3 | Infrastructure operator (named by leadership) | Share 3 | Same |
| Infrastructure operator | IT / DevOps | Access to Docker on the server | Starts and stops the stack, runs backups, keeps the operations log |
| Platform admin | Named by the tech lead | Short-lived `platform-admin` tokens | Stores secrets, delivers AppRole credentials |

Rules:
- **3 shares, any 2 unseal.** Nobody holds two shares. If one person holds two roles above, leadership names someone else for one share.
- Every share is stored twice: in the holder's personal password manager, and on paper in a sealed, signed and dated envelope in the company safe. The safe has a log of who opened it and when.
- **Never** put a share or a root token on the OpenBao server, in the repo, in chat, in email, in an issue or in a screenshot.
- Access to Docker on the server = access to OpenBao's key-holder listener and to every container. Give it only to operators.

## 3. Initialisation (once)

### 3.1. On a development machine (throw-away keys)

Use this to learn the procedure and to test changes. The keys are worthless: delete the data afterwards.

```bash
pnpm compose:env               # once
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap init    # prints 3 shares and a root token ONCE
pnpm openbao:bootstrap unseal  # enter 2 of the shares (hidden input)
pnpm openbao:bootstrap configure   # enter the root token; it is revoked at the end
pnpm openbao:bootstrap status  # says unsealed
```

These are the first commands of the whole set-up, in the same order as on the server (`platform/deploy/README.md` "Fresh deployment" step 3; on a development machine `platform/GETTING-STARTED.md` Step 11b). On a development machine `pnpm compose:core` also works instead of the `docker compose … up` line, because LiteLLM uses the key from `.env` there.

Notes for a development machine:

- `init` and `root-token` print key shares and tokens to the terminal only: they refuse to run when their output is redirected or piped, and never write them to a file.
- `configure` is safe to run again. It needs a root token: `pnpm openbao:bootstrap root-token` makes one from two shares (section 5).
- The OpenBao audit log is `/openbao/logs/audit.log` on the volume `openbao-audit`.
- A stack started before task A03 has no fixed Compose subnet, and one started before task A11 has no fixed gateway (`SDLC_NETWORK_SUBNET`, default `172.30.0.0/24`, and `SDLC_NETWORK_GATEWAY`, default `172.30.0.1`; why: section 5b "Issuing a secret ID"): run `pnpm compose:down`, then `pnpm compose:core` once, then `configure` again.
- A `.env` created before task A11 still has `OPENBAO_HOST_PORT`: delete that line (it is not used), and add `SDLC_NETWORK_GATEWAY=172.30.0.1` (or the `.1` address of your own subnet).

To start again from zero: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core down -v` (this deletes **all** data of the stack).

### 3.1b. The trial stack's key file (`pnpm trial:up`, `pnpm trial:start`)

The community trial's stack (`pnpm trial:up`, `TRIAL.md` §3.2) runs on a developer machine with **throw-away keys**, and its data is fictional. It is the only place where key shares are kept in a file (task V08, `design/QUESTIONS.md` #356, `design/ADR-M76-trial-key-file.md`):

- **What:** `trial-openbao-keys.age` next to the trial's env file (by default `platform/deploy/trial-openbao-keys.age`), ignored by Git, mode 600. It holds the two shares that unseal OpenBao (the threshold), the Compose project and the time it was made, encrypted with a passphrase the person chose (age, scrypt). **Never the root token**: it is revoked at the end of `trial:up`, as on the server.
- **Who reads it:** only `pnpm trial:start`, only for the trial's own Compose project (`sdlc-trial`), never with `NODE_ENV=production`. It asks the passphrase, unseals with `bootstrap.sh unseal` (the shares on stdin), applies the migrations and starts the platform. By hand: `age -d platform/deploy/trial-openbao-keys.age` asks the passphrase and prints the record; do it only to debug a trial stack, never on a shared screen.
- **Its limits:** a forgotten passphrase means the stack cannot be unsealed again (wipe it: `pnpm trial:down --wipe`, then `pnpm trial:up`). The processes' secret IDs end after 90 days and a trial stack cannot renew them (no root token): `trial:start` warns from day 80. `pnpm trial:down --wipe` deletes the key file with the volumes.
- **Never on a server.** The internal server keeps the key-holder rules of sections 3.2 and 4: three holders, two shares to unseal, never a share in a file, a log or a chat. Never copy a trial key file, or its way of working, to a server.

### 3.2. On the internal server (real keys)

The procedure and `pnpm server:setup` are ready. The company server has not been initialised yet: it waits for the key holders and the CA certificate below (task A10, PR 3).

Preconditions:
- leadership has named the three key holders (section 2);
- OpenBao's certificate is issued with the company CA (section 3c);
- three envelopes, a pen, and access to the safe are ready;
- a room with no cameras, and screens that nobody else can see;
- the operations log (section 10) is open.

**With `pnpm server:setup` (the default, D-08 V16).** The command runs `platform/deploy/README.md` "Fresh deployment" steps 2–7, this section included, in one pass ([ADR-M98](../../design/ADR-M98-server-setup.md)). Its settings file names the three key holders, in the order the shares are shown.

Before the day:
- Each key holder makes a PGP key pair on their own computer (for example `gpg --full-generate-key`) and gives the operator the **public** key only: `gpg --export --armor <key ID> > holder-1.asc`. The settings file names the three files (`pgp_public_key_file`). This is the default and the better way: `init` encrypts each share with its holder's key (`-pgp-keys`), so neither the command nor the screen ever shows a share in clear.
- Without PGP keys (all three files left out), the command shows each share in clear, to one holder at a time.
- The settings file lives outside the repository, mode 600, next to the GitHub App key and the model key files (example: `platform/deploy/server-setup/server-settings.example.yaml`).

Steps:
1. The operator runs `pnpm server:setup --settings <file>` in a terminal on the server (the server's console, or SSH from the macOS Terminal app). It refuses to run when its output or input is redirected or piped. On a new `.env` it stops after step 2: replace OpenBao's certificate with the company CA's (section 3c), then run it again.
2. The command starts OpenBao, PostgreSQL and SeaweedFS only, then asks whether all key holders are present and the operations log is open. Press Enter to initialise.
3. For each share, the command clears the screen and the scroll-back and calls one key holder by name. Only that holder looks at the screen and presses Enter. The holder copies **only their own share** into their password manager and onto paper for their envelope, then presses Enter. The command clears the screen and the scroll-back again before it calls the next holder. With PGP keys the share shown is encrypted for that holder only. The holder copies the encrypted text into their password manager; only their private key opens it. They decrypt it on their own computer when it is needed (to unseal, to make a root token): `echo '<share>' | base64 -d | gpg -dq`. The paper copy for the envelope is the decrypted share, written by the holder on their own computer, never on the server.
4. Two key holders unseal: each types their own share (in clear) at the hidden prompt.
5. The command gives the initial root token, which it holds in memory only, to `configure`. `configure` creates one admin token (role `platform-admin`, section 5.1) and revokes the root token. Nobody sees either token. The command never uses the root token for anything else.
6. With that admin token, in the same pass, the command stores the shared secrets (section 5b, 5d) and runs every credentials command (sections 5d–5k). Then it runs the migrations, starts the platform, runs the credentials commands of the optional parts, revokes the admin token and ends with `pnpm doctor`.
7. Do not stop the command while the shares are handed out: they exist only in its memory, and a stop there means a new `init` on wiped volumes. A Ctrl-C there asks again before it stops. If the command stops before `configure` (Ctrl-C, an error, a closed terminal), it revokes the root token and says so. While OpenBao is still sealed it cannot revoke anything: it says so, and the next start revokes that root token (by its accessor) before it runs `configure`. If it stops later, the admin token is revoked. A new start says where the last run stopped and skips what is done. When it needs an admin token again, two key holders type their shares: the command makes a new root token, runs `configure` again (safe to run again) and gets a new admin token; `configure` revokes the new root token.
8. If the command says it could not revoke a root token, run it again soon (it revokes the old root token first) and record it in the operations log.
9. Close the terminal window. Check that no session recording kept the output (the command already cleared the scroll-back after each share; inside `tmux` or `screen`, also clear their history, for example `tmux clear-history`).
10. Each key holder seals their envelope, signs it across the seal, dates it, and puts it in the safe. Record it in the safe log.
11. Record the initialisation in the operations log: date, time, people present, PGP or clear shares, "root token revoked: yes".

**By hand (the fallback, and what the command does).**

1. The operator starts OpenBao, PostgreSQL and SeaweedFS only: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs`. Check: `pnpm openbao:bootstrap status` says `uninitialised`.
   - Not `pnpm compose:core`: on the server `.env` holds no LiteLLM keys (section 5d), so LiteLLM cannot become healthy before the profile `models` runs. The whole stack starts later (`platform/deploy/README.md`, "Fresh deployment", step 7).
   - SeaweedFS must run because the credentials commands of sections 5g–5k create SeaweedFS identities.
2. All three key holders are present. The operator runs `pnpm openbao:bootstrap init` in a terminal on the server. The script refuses to run if its output is redirected or piped.
3. Each key holder copies **only their own share** into their password manager, and writes it on paper for their envelope. The operator does not copy any share.
4. The operator notes the **initial root token** only long enough for step 6. It is not stored anywhere.
5. Two key holders unseal: `pnpm openbao:bootstrap unseal`. Each types their own share at the hidden prompt.
6. The operator runs `pnpm openbao:bootstrap configure` and types the root token. At the end the script prints `the root token is revoked`. Check it.
7. Clear the terminal and close it (`clear`, then close the window). Check that no scroll-back or session recording kept the output.
8. Each key holder seals their envelope, signs it across the seal, dates it, and puts it in the safe. Record it in the safe log.
9. Record the initialisation in the operations log: date, time, people present, "root token revoked: yes".

What `configure` sets up (details: `design/ADR-M19-openbao-bootstrap.md`):
- KV version 2 at `kv/`;
- Transit at `transit/`, with the Ed25519 key `run-contract` (not exportable, not deletable);
- AppRoles `api`, `worker`, `runner`, `cost-controller`, each reading only `kv/<its name>/…` (plus `kv/shared/github-app` for `api` and `worker`; the `runner` receives each run's GitHub token from the worker as a single-use wrapping token (a token that gives one process one secret, once), `design/ADR-M25-runner-sandbox.md` §2.11);
- the AppRole `litellm` for the LiteLLM sidecar: it reads the model provider keys, the LiteLLM salt key and the LiteLLM master key, nothing else (section 5d);
- the token role `platform-admin` (tokens of at most 1 hour);
- a check that the file audit device is on.

Settings (key shares, threshold, token and secret ID lifetimes) are in `platform/deploy/openbao/bootstrap/bootstrap.conf`. Access rules are in `platform/deploy/openbao/bootstrap/policies/*.hcl`. Changes to either go through a reviewed pull request, then `configure` again.

### 3c. TLS on port 8200: the CA, the certificate, renewal

OpenBao's listener 8200 speaks TLS on every machine (task A10, `design/ADR-M63-openbao-tls-and-backups.md`, QUESTIONS #20, #325). Every platform process verifies the certificate with the CA; there is no plain listener on the Compose network. The listener 8210 inside the container stays plain.

**Where the files are.** The env file names the folder: `SDLC_OPENBAO_TLS_DIR` (an absolute path) with `ca.pem`, `server.pem` and `server-key.pem` (mode 600). The job `openbao-tls-init` copies them into the volumes `openbao-tls` and `openbao-ca` at every start. **The CA's private key is never in this folder.**

**On a development machine (throw-away CA).** `pnpm compose:env` makes a throw-away CA and a certificate in `platform/deploy/openbao-tls/` (Git-ignored) and deletes the CA key at once. An `.env` made before A10: run `pnpm openbao:tls dev` once (it adds the folder and the variable), then `pnpm compose:core`. OpenBao's data stays; no unseal procedure changes.

**On the internal server (the company CA).** Done by the infrastructure operator, before the initialisation of section 3.2:

1. Make the CA in a folder **outside the repository**, for example on an encrypted USB drive: `pnpm openbao:tls ca /media/ca-usb/openbao-ca`. It writes `ca.pem` and `ca-key.pem` (5 years). It refuses a folder inside the repository and never overwrites a CA.
2. Set `SDLC_OPENBAO_TLS_DIR` in `platform/deploy/.env` to a folder outside the repository on the server, for example `/etc/sdlc/openbao-tls`.
3. Issue the server certificate: `pnpm openbao:tls server /media/ca-usb/openbao-ca` (1 year, names `openbao` and `127.0.0.1`).
4. Check: `pnpm openbao:tls check` shows both end dates.
5. Take the CA folder offline: the USB drive goes into the safe with the key shares' envelopes. Record it in the operations log (section 10).

**Renewal (every year; the reminder 30 days before the end).**

- `pnpm openbao:tls check` fails within 30 days of the end; `up.sh` prints a warning at every start; `pnpm doctor` shows both end dates (`openbao.tls_expiry`). Put the end date in the team calendar with a reminder 30 days before.
- To renew: take the CA folder out of the safe, run `pnpm openbao:tls server <ca-folder>`, then `pnpm openbao:tls reload`. OpenBao reads the new certificate and **stays unsealed**; the clients keep working (same CA). Put the CA folder back; record it in the operations log.
- A new CA (every 5 years, or after a leak): `pnpm openbao:tls ca` in a new folder, `server`, `reload`, then restart every client (`sdlc-api`, `sdlc-worker`, `sdlc-runner`, `litellm-agent`): they read `ca.pem` when they start.

### 3d. TLS for team access: the proxy's certificate

The team access proxy (`sdlc-access`, profile `access`, task V09, `design/ADR-M67-team-access.md`) speaks TLS on one LAN port with its own certificate. It names the host name people open (`SDLC_ACCESS_HOSTNAME`, never only an IP address: passkeys refuse it) and, optionally, the IPv4 addresses of `SDLC_ACCESS_IPS`. The commands are `pnpm access:tls …` (`platform/deploy/access/tls.sh`), built like section 3c.

**Where the files are.** `SDLC_ACCESS_TLS_DIR` (an absolute path; **outside the repository on a server**) holds `ca.pem`, `server.pem` and `server-key.pem` (mode 600). The job `access-tls-init` copies them into the volume `access-tls` at every start; the proxy reads that volume only. **Never put a CA's private key in this folder** (`import` refuses a folder that holds `ca-key.pem`).

**On the server.** Done by the infrastructure operator:

1. Set the team access settings in `platform/deploy/.env` (`platform/deploy/README.md`, "Team access (operator)").
2. Either take the certificate from the **company CA** (the usual case: company machines already trust it): put `ca.pem`, `server.pem` and `server-key.pem` in a folder and run `pnpm access:tls import <folder>`; it checks the chain, that the key belongs to the certificate and that the certificate names the host name and the IPs, then copies the files. Or issue it with the **internal CA of section 3c**: take the CA folder out of the safe, `pnpm access:tls server <ca-folder>` (1 year), put the folder back.
3. `pnpm access:tls check` shows both end dates and the names; `pnpm doctor` shows them too (`access.tls_*`).
4. Give people `ca.pem` when their machines do not trust the CA (the CLI: `NODE_EXTRA_CA_CERTS`). Record it in the operations log.

**On a test or development machine (throw-away CA).** `pnpm access:tls dev` makes a throw-away CA and the certificate in `platform/deploy/access-tls/` next to the env file (Git-ignored), deletes the CA key at once, and sets `SDLC_ACCESS_TLS_DIR`. Never for a server.

**Renewal (every year; the reminder 30 days before the end).** `pnpm access:tls check` fails within 30 days of the end; `up.sh` warns at every start of the profile; `pnpm doctor` shows the dates. Renew with `import` (a new certificate from the company CA) or `server <ca-folder>`, then `pnpm access:tls reload`: the job copies the files again and nginx reads them (SIGHUP) **without a restart**. People need a new `ca.pem` only when the CA changed.

## 4. Unseal after a server restart

1. The operator announces the restart in the internal channel.
2. After the restart, `pnpm openbao:bootstrap status` says `sealed`. The platform processes cannot read secrets until OpenBao is unsealed.
3. Two key holders run `pnpm openbao:bootstrap unseal` in turn, or one after the other in the same session. Each types their share at the hidden prompt. Remote access is allowed only over a secure connection (company VPN + SSH), never by sending the share to someone else.
4. `status` says `unsealed`. Check that the platform processes reconnect: `pnpm doctor` (read only, prints no secret) shows the services, the credentials and the logs' missing credentials in one list ([deploy README, Doctor](../../platform/deploy/README.md#doctor-pnpm-doctor)).
5. Record it in the operations log.

A wrong share is refused and OpenBao stays sealed. To reset a half-finished unseal, restart the `openbao` container.

## 4b. Upgrading the OpenBao image

The image is pinned in `platform/deploy/docker-compose.yml` (services `openbao` and `litellm-agent`, design/ADR-M17 §2.1). An upgrade comes as a reviewed pull request.

1. **On a real server, take a Raft snapshot first** (section 6) and copy it off the server. After a newer OpenBao has run on the Raft data, going back to the older image may not work: the newer version can write data the older one cannot read. The snapshot taken before the upgrade is the way back (section 7). On a development machine with throw-away keys this is optional.
2. Pull the new image and recreate the container. It starts **sealed**: unseal it (section 4) and check `status`.
3. Check that the platform processes log in again (their logs; `litellm-agent` renders its file).
4. Record the upgrade (old and new version) in the operations log.

Since 2.7.1, an AppRole secret ID stops working exactly at its expiry (`APPROLE_SECRET_ID_TTL`, 90 days), even before OpenBao's clean-up job (tidy) runs. A process that fails to log in after that time needs its credentials command again (sections 5d–5m, `pnpm openbao:bootstrap <process>-credentials`).

## 5. Root token: create only when needed, revoke immediately

Daily work never uses a root token. A root token is needed only to:
- run `configure` again (new policies, new AppRoles, changed settings);
- create `platform-admin` tokens;
- rekey (section 8.3).

Steps:
1. Record the reason in the operations log **before** you start.
2. Two key holders run `pnpm openbao:bootstrap root-token`. Each types their share at the hidden prompt. The script prints the new root token once.
3. Use it at once. For example: `pnpm openbao:bootstrap configure` (this revokes the token at the end), or create an admin token (section 5.1) and then revoke the root token.
4. Revoke it if it is still valid:
   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
     sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token revoke -self'
   ```
   Type the token (hidden) and press Enter.
5. Record the end time and "revoked: yes" in the operations log.

`root-token` works only through the key-holder listener `127.0.0.1:8210`, which is reachable only from inside the OpenBao container.

### 5.1. Admin token for daily work

With a root token (section 5). An admin token cannot create another admin token, so the 1-hour limit holds:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token create -role=platform-admin -field=token'
```

- The token lives **at most 1 hour** and cannot be renewed.
- It can store and update secrets under `kv/`, read AppRole role IDs, issue and revoke secret IDs, and read the public Run Contract key.
- It cannot change policies, mounts, the audit device or the Transit key, and cannot delete secrets.
- Admin work is rare in v0.1 (storing secrets once, rotating secret IDs every 3 months). Each admin session therefore needs two key holders for the root token. A personal admin login (for example user and password, or company single sign-on) is an open item (`design/ADR-M19-openbao-bootstrap.md` section 3).

## 5b. Secrets and AppRole secret IDs

### Storing a secret

With an admin token (hidden input, the value is read from stdin). The command asks for each value by name and ends with `stored` or `FAILED`; a silent failure is easy to miss behind hidden prompts:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'printf "Admin token (hidden): "; read -rs BAO_TOKEN; echo; export BAO_TOKEN; printf "Value (hidden): "; read -rs VALUE; echo; printf %s "$VALUE" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null && echo stored || echo FAILED'
```

A value nobody needs to know (the LiteLLM master key and salt key) is better made at random inside the container, so it never appears on a screen or a clipboard:

```bash
{ printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n' "$t"; } | \
  docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
  sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv put -mount=kv cost-controller/litellm-master-key value="sk-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n")" >/dev/null && echo stored || echo FAILED'
unset t
```

The salt key the same way at `litellm/salt-key`, without the `sk-` prefix (GETTING-STARTED Step 11b part 4 does both). Never change the salt key after LiteLLM's first start (section 5d).

| Secret | Path | Read by |
|---|---|---|
| GitHub App private key | `kv/shared/github-app` | `api`, `worker` (not `runner`, `design/QUESTIONS.md` #44) |
| LiteLLM master key (field `value`) | `kv/cost-controller/litellm-master-key` | `cost-controller`, `litellm` (one source for both, section 5d) |
| LiteLLM salt key (field `value`) | `kv/litellm/salt-key` | `litellm` |
| Model provider keys (field `api_key`), one entry per provider | `kv/litellm/providers/<provider>`, for example `kv/litellm/providers/anthropic` | `litellm` |
| `platform_app` database password of the API (field `password`) | `kv/api/database` | `api` (section 5e) |
| `platform_app` database password of the worker (field `password`) | `kv/worker/database` | `worker` (section 5f) |
| Database and SeaweedFS passwords of a process | `kv/<process>/…` | That process |

The GitHub App key is read by `api` and by the `worker` (it polls GitHub, posts gate comments, reads spec and plan files, issues the short-lived tokens of each run and opens pull requests; `design/QUESTIONS.md` #42). The runner never reads it: it receives each run's short-lived token from the worker as a single-use wrapping token (`design/QUESTIONS.md` #44). The key must **never** enter an agent sandbox.

### The GitHub App (task B05)

Create one GitHub App per installation of the platform (`design/ADR-M23-github-adapter.md` section 2.2):

- Permissions, webhook and installation: [platform/deploy/README.md, "The GitHub App's settings"](../../platform/deploy/README.md#github-app-permissions), the one list.
- Generate a private key. Store it with the App's client ID in `kv/shared/github-app` (fields `client_id` and `private_key`), then delete the downloaded `.pem` file. The admin token is typed at the hidden prompt; the key goes through stdin, never through a command-line argument:

```bash
{ read -rs t && printf '%s\n%s\n' "$t" "<client ID>" && cat /path/to/app.private-key.pem; } | \
  docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
  sh -c 'read -r BAO_TOKEN && read -r CLIENT_ID && export BAO_TOKEN && bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=-'
```

- Key rotation: generate a new key in GitHub, store it the same way, wait 10 minutes (the platform reads the key again after that), then delete the old key in GitHub.

### 5b.1. Development: the test GitHub App in the development OpenBao (task B06)

On a development machine, the worker (GitHub poller) reads the key of the **test** App `harryforge-sdlc-dev` (Client ID `Iv23liQtMQBwNyVYZuJt`, `platform/GETTING-STARTED.md` Step 11) from the development OpenBao, at `kv/shared/github-app`. Only throw-away OpenBao keys are used there. The production App gets its own key in the real OpenBao later.

- **The repository owner runs these commands in the macOS Terminal**, from the repository root. Never run them through a chat tool, and never paste the key or the token into a chat.
- The key is read from its file (`~/.config/sdlc-secrets/github-app-dev.pem`, mode 600, outside the repository) and goes to OpenBao on stdin. It is never typed, pasted, passed as an argument, written to the repository or a log, or kept in shell history.
- The admin token (section 5.1) is typed at a hidden prompt.

Before: OpenBao is running (`pnpm compose:core`), unsealed and configured (sections 3.1 and 4).

1. Store the Client ID and the key:
   ```bash
   KEY_FILE="$HOME/.config/sdlc-secrets/github-app-dev.pem"
   CLIENT_ID=Iv23liQtMQBwNyVYZuJt
   { printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n%s\n' "$t" "$CLIENT_ID" && cat "$KEY_FILE"; } | \
     docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
     sh -c 'read -r BAO_TOKEN && read -r CLIENT_ID && export BAO_TOKEN && bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null && echo stored'
   unset t
   ```
   The answer is `stored`.
2. Check. This prints the Client ID only, never the key:
   ```bash
   { printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n' "$t"; } | \
     docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
     sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv get -mount=kv -field=client_id shared/github-app'
   unset t
   ```
3. Keep the `.pem` file where it is: the optional live tests read it (`platform/GETTING-STARTED.md` Step 11). If the key ever leaves the machine, delete it in the App settings on GitHub and create a new one.
4. Deliver the worker's credentials (section 5f) and start it: `pnpm compose:platform`.

### Issuing a secret ID: sensitive, audited

A secret ID + role ID lets a process log in as that AppRole. Treat issuing one like handing over a key.

- Only the OpenBao admin issues secret IDs, only for a process being deployed or rotated, and records it in the operations log (role, date, reason, accessor, not the secret ID).
- Every issue is in the OpenBao audit log.
- A secret ID works only from the Compose network subnet and expires after **90 days**. The tokens a process gets at login work only from the same subnet. The network gateway (`SDLC_NETWORK_GATEWAY`) is left out: every process on the server reaches the containers from the gateway address, so a secret ID or token used on the server outside a container is refused (`design/QUESTIONS.md` #27, #37).
- Trust model: this stops users of the server without root rights, and credentials that leak out of a container. Root on the server is trusted: root can `docker exec` into any container. Access to root and to Docker on the server is controlled by server administration.
- Deliver it straight to the process as a file (section 5c). Never through chat or email.

```bash
# role ID (not secret)
bao read -field=role_id auth/approle/role/runner/role-id
# new secret ID: note the accessor in the operations log
bao write -f auth/approle/role/runner/secret-id
```

(Run inside the container, with `BAO_TOKEN` set to an admin token as above.)

## 5c. How a platform process uses its credentials

Each platform process (api, worker, runner, cost-controller) uses the OpenBao client `@sdlc/secrets` (design/ADR-M21). It reads these settings:

| Setting | Value |
|---|---|
| `SDLC_OPENBAO_ADDR` | `https://openbao:8200` (the process runs in Compose; OpenBao publishes no host port). Plain HTTP is not used anywhere since A10 |
| `SDLC_OPENBAO_CA_CERT_FILE` | `/run/sdlc/openbao-ca/ca.pem`, from the volume `openbao-ca` (section 3c). The client always checks the server certificate; there is no way to skip the check |
| `SDLC_OPENBAO_ROLE_ID_FILE` | File with the role ID |
| `SDLC_OPENBAO_SECRET_ID_FILE` | File with the secret ID: mode 600, on a tmpfs mount, readable only by the process |

- The role ID and the secret ID are **files**, never environment variables: anyone allowed to run `docker inspect` can read environment variables.
- **Rotating a secret ID** (every 90 days, section 8.1): run the service's credentials command (sections 5d–5m, one per credential; the full list: `platform/deploy/README.md`, Fresh deployment step 5). It issues a new secret ID, replaces the file, then destroys the old secret ID. The client reads the file again at its next login (at the latest when its token reaches the 4-hour maximum); restart the service to make it log in at once.
- The client renews its token by itself and logs in again when needed. It never writes a token, secret ID or secret value to its logs.

## 5d. LiteLLM keys (Compose profile `models`)

LiteLLM (the model gateway) gets its keys from OpenBao through a sidecar: an OpenBao Agent (service `litellm-agent`, same image as OpenBao). The sidecar logs in with the AppRole `litellm` and writes LiteLLM's configuration, with the keys, into a file in memory (tmpfs). LiteLLM reads the file when it starts. No model provider key is ever in `.env`, in the repo, in an image or in an environment variable (`design/QUESTIONS.md` #1, `design/ADR-M24-litellm-cost-controller.md`).

**The server always runs with the profile `models`:** `pnpm compose:models` (profiles `core` and `models`). Without the profile, LiteLLM starts with no models and uses the development keys from `.env`; that is for development machines only. On the server, leave `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` empty in `.env`.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `litellm`.
2. With an admin token, store three kinds of secret (section 5b shows how to pass a value on stdin):
   - the LiteLLM master key at `kv/cost-controller/litellm-master-key`, field `value` (it must start with `sk-`). The Cost Controller reads the same entry: there is only one master key;
   - the LiteLLM salt key at `kv/litellm/salt-key`, field `value`. **Never change it after the first start**: LiteLLM encrypts stored credentials with it;
   - one model provider key per provider at `kv/litellm/providers/<provider>`, field `api_key`:
     ```bash
     docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
       sh -c 'printf "Admin token (hidden): "; read -rs BAO_TOKEN; echo; export BAO_TOKEN; printf "Provider API key (hidden): "; read -rs VALUE; echo; printf %s "$VALUE" | bao kv put -mount=kv litellm/providers/anthropic api_key=- >/dev/null && echo stored || echo FAILED'
     ```
3. Deliver the sidecar's AppRole credentials. The command asks for an admin token (hidden), issues a new secret ID and writes it with the role ID into the sidecar's volume. It prints no secret:
   ```bash
   pnpm openbao:bootstrap litellm-credentials
   ```
   Record it in the operations log (role `litellm`, date, reason; not the secret ID).
4. Start: on the server every profile at once (`platform/deploy/README.md`, Fresh deployment step 7); on a development machine `pnpm compose:models`. LiteLLM waits until the sidecar has written the configuration.
5. Check: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models ps` shows `litellm-agent` and `litellm` as healthy.

**Developer machines only: a local Ollama model** (`design/QUESTIONS.md` #78). Ollama has no key; its entry holds the address LiteLLM uses (on Docker Desktop, `http://host.docker.internal:11434`). Store it with an admin token, then restart `litellm-agent` and `litellm`:
```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao kv put -mount=kv litellm/providers/ollama api_base=http://host.docker.internal:11434'
```
Pull the model first on the machine (`ollama pull gpt-oss:20b`, a local tag, never a `:cloud` model). Never on the internal server: it has no GPU.

**The real API-model run** (task E07, `design/QUESTIONS.md` #81: one real run with an API model before M-F; the trial M-E runs with the local Ollama model). On a development machine, in the macOS Terminal (never through a chat tool):

1. Store the Anthropic key at `kv/litellm/providers/anthropic` (step 2 above, the value at the hidden prompt). The key needs a spend limit at the provider; the run itself is capped at USD 1.00.
2. Restart the sidecar and LiteLLM so the model appears: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models restart litellm-agent litellm`. The gateway name is `claude-haiku-4-5-20251001` (the name carries the model version, `design/QUESTIONS.md` #93).
3. With the dev stack running (`pnpm compose:models`, GETTING-STARTED Step 13), run:
   ```bash
   SDLC_AGENT_API_REPORT=~/sdlc-agent-api-report.json pnpm test:agent-api
   ```
   The test needs Docker. It reads the LiteLLM master key once from the configuration the sidecar rendered (in memory only, never printed); the provider key never leaves LiteLLM. One agent task on a fixture repository (no client data), a virtual key with the seven labels and a cap of USD 1.00, then the spend synced into `cost_records`. It passes when the agent finishes, every LiteLLM spend-log row of the run has the seven labels and a cost above 0, `cost_records` matches it, the spend is within the cap, and the key is refused after the run.
4. The report file holds the numbers (time, calls, tokens in, out and cached, cost). They go into `design/MVP-DONE.md` §3; then #81 is closed.

A model appears in LiteLLM only when its provider has a key in `kv/litellm/providers/`. The list of models is in `platform/deploy/litellm/config.ctmpl`. To add a model, change that file in a reviewed pull request: every model declares `provider_type` (`api` or `self_hosted`), and a self-hosted model declares a cost per token above 0, because LiteLLM skips budget checks for a model that costs 0 (`design/D-07-model-and-token-management.md` section 3). Then restart LiteLLM.

### 5d.1. The self-hosted model (vLLM, Compose profile `models-local`)

On a server with an NVIDIA GPU, the profile `models-local` runs vLLM (`design/ADR-M71-self-hosted-model-vllm.md`, task L01). Set-up of the host, the model settings and the weights: `platform/deploy/README.md` "Self-hosted model". vLLM has no key: it is on the internal network `models`, which only LiteLLM joins. Its provider entry holds two values, and neither is a secret:

- `api_base`: `http://vllm:8000/v1`;
- `model`: the served name, equal to `SDLC_VLLM_SERVED_NAME` in `.env` (for example `qwen3-coder-30b-a3b-instruct`). It is the name agents use as their model.

Store it with an admin token, then restart the sidecar and LiteLLM:
```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao kv put -mount=kv litellm/providers/vllm api_base=http://vllm:8000/v1 model=qwen3-coder-30b-a3b-instruct'
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile models-local restart litellm-agent litellm
```
LiteLLM then serves the model as `self_hosted`, with an internal cost per token above 0 (a placeholder until task L03) and at most `SDLC_VLLM_MAX_NUM_SEQS` requests at a time. A `client_restricted` intent can use only this kind of model (`design/D-07-model-and-token-management.md` §4).

To stop using the model, first suspend the agents whose model is the served name (handbook Ch.20 §20.9). Then delete the entry (`bao kv metadata delete -mount=kv litellm/providers/vllm`) and restart `litellm-agent` and `litellm`.

### 5d.2. vLLM on a separate GPU host: the link's certificates (profile `models-remote`)

When the GPU is in a separate machine (the GPU host), the platform server reaches vLLM through a link with **mutual TLS**: both machines show a certificate of the same CA (`design/ADR-M71-self-hosted-model-vllm.md` §4, task L01 PR 2). The set-up of both machines: `platform/deploy/README.md` "Self-hosted model on a separate GPU host". The provider entry `vllm` is the same as in section 5d.1 (`api_base=http://vllm:8000/v1`): on the platform server, the link answers under the name `vllm`. These certificates are not kept in OpenBao.

There are two sets of files. Neither holds a CA key:

| Folder | Files | Goes to | Setting |
|---|---|---|---|
| `gpu-host/` | `ca.pem`, `server.pem` (names the GPU host), `server-key.pem` | The GPU host | `SDLC_GPU_LINK_TLS_DIR` in `platform/deploy/gpu-host/.env` |
| `platform/` | `ca.pem`, `client.pem` (`CN=sdlc-vllm-link`), `client-key.pem` | The platform server | `SDLC_VLLM_LINK_TLS_DIR` in `platform/deploy/.env` |

**Issue** them with the internal CA of section 3c (`openbao/tls.sh ca`), on the machine that holds the CA folder, into a new folder outside the repository (1 year):
```bash
pnpm gpu-link:tls issue <ca-folder> <gpu-host-name> <new-folder>
```
Copy `<new-folder>/gpu-host/` to the GPU host and `<new-folder>/platform/` to the platform server, for example with `scp -p` (the keys keep mode 600). Then delete `<new-folder>` from the CA machine.

**With the company CA** (when it exists, QUESTIONS #20): ask for one server certificate (the GPU host's name, `serverAuth`) and one client certificate (`CN=sdlc-vllm-link`, `clientAuth`). Put each in its folder with the CA certificate, under the names of the table, and check each folder:
```bash
pnpm gpu-link:tls check <gpu-host-folder> <gpu-host-name>
pnpm gpu-link:tls check <platform-folder>
```
With a company CA, the gateway still refuses every other company certificate: it accepts only the name `SDLC_GPU_LINK_CLIENT_CN`.

**Renew** 30 days before the end (`pnpm gpu-link:tls check`, `pnpm gpu-host:up` and `pnpm compose:models-remote` warn). Issue again into a new folder, copy the files over the old ones on each machine, then:
```bash
pnpm gpu-link:tls reload gpu-host   # on the GPU host
pnpm gpu-link:tls reload platform   # on the platform server
```
No restart is needed. While only one side has the files of a **new CA**, the link refuses every call: renew both sides together.

**A key is exposed** (a key file was copied to a wrong place): issue new certificates at once and reload both sides. The gateway has no revocation list. With the company CA, ask its owner to revoke the old certificate; until the old certificate ends, also change `SDLC_GPU_LINK_CLIENT_CN` on the GPU host and issue the new client certificate with that name (`SDLC_GPU_LINK_CLIENT_CN=<new name> pnpm gpu-link:tls issue …`). With the internal CA, make a new CA (section 3c) when the client key is exposed.

**Test machines only:** `pnpm gpu-link:tls dev <gpu-host-name> <new-folder>` makes a throw-away CA and both sets, and deletes the CA key at once.

### Rotation

| What | Steps |
|---|---|
| A model provider key | Store the new value (step 2). The sidecar writes the new configuration within about 5 minutes. Then restart LiteLLM: `docker compose … --profile core --profile models restart litellm`. Revoke the old key at the provider |
| The master key | Store the new value. Restart `litellm-agent`, then `litellm`. The Cost Controller reads the new value at its next read. Virtual keys already issued stay valid |
| The sidecar's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap litellm-credentials`, then restart `litellm-agent`. The command destroys the old secret ID itself (section 8.1) |
| The salt key | Never |

## 5e. The API (Compose profile `platform`)

The API (service `sdlc-api`, task B03) logs in with the AppRole `api` and reads the password of the database role `platform_app` from `kv/api/database` once, when it starts. The password is never in its environment or image (`design/ADR-M26-api-app.md` §2.6, `design/QUESTIONS.md` #67).

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `api`.
2. Store the password and deliver the API's AppRole credentials. The command asks for an admin token (hidden). It stores `PLATFORM_APP_DB_PASSWORD` from `platform/deploy/.env` at `kv/api/database`, issues a new secret ID, and writes the secret ID with the role ID into the volume `api-approle`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap api-credentials
   ```
   Record it in the operations log (role `api`, date, reason; not the secret ID).
3. Start. On the server every profile starts at once, after the migrations (`platform/deploy/README.md`, Fresh deployment steps 6–7); on a development machine `pnpm compose:platform` (profiles `core` and `platform`). The API listens on `127.0.0.1:8090`.
4. Check: `curl -s http://127.0.0.1:8090/health/ready` answers `{"status":"ok"}`.
5. The tenant and its first tenant admin: `platform/deploy/README.md`, Fresh deployment step 8 (`adlc ops bootstrap`, after the migrations; the token is printed once, so run it in a terminal). Operator commands on the database are `adlc ops …` (task B13, `design/ADR-M37-admin-onboarding.md`); everything else is done through the API (handbook Ch.19 §19.8d).

### Rotation

| What | Steps |
|---|---|
| The API's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap api-credentials`, then restart `sdlc-api`. The command destroys the old secret ID itself (section 8.1) |
| The `platform_app` password | Change it in PostgreSQL and in `.env`, run `pnpm openbao:bootstrap api-credentials`, then restart `sdlc-api` |

## 5f. The worker (Compose profile `platform`)

The worker (service `sdlc-worker`, task B06) polls GitHub and handles the comment commands (`design/ADR-M27-github-poller.md`). It logs in with the AppRole `worker`. It reads the password of the database role `platform_app` from `kv/worker/database` once, when it starts, and the GitHub App key from `kv/shared/github-app` every 10 minutes. No password or key is in its environment or image.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `worker`. The GitHub App key is stored (section 5b; on a development machine section 5b.1).
2. Store the password and deliver the worker's AppRole credentials. The command asks for an admin token (hidden). It stores `PLATFORM_APP_DB_PASSWORD` from `platform/deploy/.env` at `kv/worker/database`, issues a new secret ID, and writes it with the role ID into the volume `worker-approle`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap worker-credentials
   ```
   Record it in the operations log (role `worker`, date, reason; not the secret ID).
   The same command also delivers the second AppRole of the worker, `cost-controller`, into the volume `worker-cost-approle` (task C06, `design/ADR-M33-gate-g4.md` §2.5). With it, the worker runs the Cost Controller: it reads the LiteLLM master key (`kv/cost-controller/litellm-master-key`, section 5d) and hands agent runs to the runner. Without it the worker logs `worker.runs_off` and intents wait at G4. Record it in the operations log too (role `cost-controller`).
3. Start: on the server every profile at once (Fresh deployment step 7); on a development machine `pnpm compose:platform` (profiles `core` and `platform`). The worker publishes no port.
4. Check: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env logs sdlc-worker` shows `worker.started`, then one `poll.completed` per project and interval. The logs hold IDs and codes only.

### Rotation

| What | Steps |
|---|---|
| The worker's secret IDs (`worker` and `cost-controller`, every 90 days, section 8.1) | `pnpm openbao:bootstrap worker-credentials`, then restart `sdlc-worker`. The command destroys the old secret IDs itself (section 8.1) |
| The `platform_app` password | Change it in PostgreSQL and in `.env`, run `api-credentials`, `worker-credentials` and `runner-credentials`, then restart `sdlc-api`, `sdlc-worker` and `sdlc-runner` |
| The GitHub App key | Section 5b. No restart: the worker reads the key again after 10 minutes |

## 5g. The runner and sandboxes (Compose profile `sandbox`)

The runner (service `sdlc-runner`, task C04) creates one hardened sandbox per agent run (`design/ADR-M25-runner-sandbox.md`). It logs in with the AppRole `runner` and reads the password of the database role `platform_app` from `kv/runner/database` once, when it starts. It reaches Docker only through the socket proxy (`docker-socket-proxy`); it never mounts the Docker socket itself.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `runner`.
2. Check `SDLC_DOCKER_GID` in `platform/deploy/.env`: the group of `/var/run/docker.sock` on the host (`init-env.sh` fills it in; `stat -c %g /var/run/docker.sock` on Linux, `0` on Docker Desktop). With a wrong value the socket proxy cannot read the socket and stays unhealthy.
3. Store the password and deliver the runner's AppRole credentials. The command asks for an admin token (hidden). It stores `PLATFORM_APP_DB_PASSWORD` from `platform/deploy/.env` at `kv/runner/database`, issues a new secret ID, and writes the secret ID with the role ID into the volume `runner-approle`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap runner-credentials
   ```
   Record it in the operations log (role `runner`, date, reason; not the secret ID).
   - On the server the runner runs on **its own Docker Engine** (`design/ADR-M91-runner-own-engine.md`; deploy README "The runner on its own Docker Engine"). Then set `SDLC_RUNNER_DOCKER_HOST` (the runner's Engine) and `SDLC_RUNNER_SOURCE_CIDR` (the runner host's address as OpenBao sees it) in `platform/deploy/.env`, and run `configure` again first. The same command then writes the credentials into the runner host's volume, over the Docker connection; the secret ID still goes on standard input only. Only the AppRole `runner` accepts `SDLC_RUNNER_SOURCE_CIDR`. Restart the runner on the runner host: `platform/deploy/scripts/runner-host.sh restart`.
3b. Give the runner its SeaweedFS identity `runner-evidence`. SeaweedFS must run. The command asks for an admin token (hidden) and prints no secret:
   ```bash
   pnpm openbao:bootstrap runner-evidence-credentials
   ```
   - What it does: makes a new key pair inside the openbao container, stores it at `kv/runner/evidence` and registers it in SeaweedFS as `runner-evidence`.
   - What the identity may do: **write** under `evidence/proposals/` (the proposals of High-risk runs, `design/ADR-M33-gate-g4.md` §2.9) and `evidence/diffs/` (the diff of every run, `design/ADR-M34-gate-g5.md` §2.2); **read** under `evidence/diffs/` only (the push applies the checked diff, `design/ADR-M38-gate-g6.md` §2.2). No list, no read of proposals.
   - Upgrade note: an identity made before task C08 cannot read diffs, so pushes fail (`evidence_unavailable`). Run the command again once, then restart `sdlc-runner`.
   - Without it the runner still starts (log line `runner.evidence_missing`), but every High-risk run fails when it tries to store its proposal, and every other run fails at its end (`agent_changes_unavailable`): no run reaches G5 without its stored diff. Never run `weed shell s3.config.show` or `s3.configure` without `-apply` on the server: they print the keys. Admin work in SeaweedFS: section 5l.
4. Start: on the server every profile at once (Fresh deployment step 7); on a development machine `pnpm compose:sandbox` (profiles `core` and `sandbox`). It also starts the npm package proxy (`npm-proxy`, Verdaccio) and the local image registry (`registry`).
5. Check: `docker compose … ps sdlc-runner` shows `healthy`. The runner's log has one line with `"event":"runner.started"`.

### Sandbox images and the local registry

- The registry listens on **127.0.0.1 only** (`SDLC_REGISTRY_HOST_PORT`, default 5050) and has **no authentication**. Only operators logged in on the server can push. Never publish it on another address.
- Images are **always used by digest**, never by tag. Build and push, then copy the printed reference into the project configuration as `sandbox.image`:
  ```bash
  pnpm sandbox-image:build node24
  # prints localhost:5050/sdlc/sandbox-node24@sha256:<digest>
  ```
- On Docker Desktop (development) the Engine cannot push to a port published on the Mac. Use `platform/sandbox-images/build.sh node24 --no-push`: it prints the local reference by digest.
- **OpenCode image** (only for projects with an agent of the adapter `opencode`, handbook Ch.20 §20.5b). It is built on the `node24` image, so give that image by digest. Copy the printed reference into the project configuration as `sandbox.images.opencode`; `sandbox.image` stays the OpenHands image:
  ```bash
  NODE24=localhost:5050/sdlc/sandbox-node24@sha256:<digest> pnpm sandbox-image:build node24-opencode
  # prints localhost:5050/sdlc/sandbox-node24-opencode@sha256:<digest>
  ```
  The releases do not publish this image yet: build it on a release checkout too. Build it again whenever you build a new `node24` image.
- Old images: delete the manifest by digest (`curl -X DELETE http://127.0.0.1:5050/v2/sdlc/sandbox-node24/manifests/sha256:<digest>`; for OpenCode `sandbox-node24-opencode`), then run garbage collection: `docker compose … exec registry registry garbage-collect /etc/docker/registry/config.yml`. Keep every digest a project configuration still names.

### Rotation

| What | Steps |
|---|---|
| The `platform_app` password | See section 5f: all three credentials commands, then restart the three services |
| The runner's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap runner-credentials`, then restart `sdlc-runner`. The command destroys the old secret ID itself (section 8.1) |
| The runner's evidence key (`runner-evidence`, every 90 days or when it may have leaked) | `pnpm openbao:bootstrap runner-evidence-credentials`, then restart `sdlc-runner`. The old key stops working at once; do it when no run is ending and no push is under way (a failed push is tried again) |

### After a crash or restart

The runner cleans up by itself when it starts: it removes every sandbox, network and workspace volume that carries its instance label (`COMPOSE_PROJECT_NAME`). Runs that were still provisioning or running end as `failed` with `runner_restarted`. Nothing to do by hand. Run **one** `sdlc-runner` per Compose project: two runners with the same instance label would remove each other's sandboxes.

## 5h. The API's evidence identity (Evidence Packs)

The API builds and serves the Evidence Packs of intents (task E02, `design/ADR-M48-evidence-builder.md`, handbook Ch.15 §15.10.2). It uses its own SeaweedFS identity `api-evidence`, stored at `kv/api/evidence`. The AppRole `api` already reads `kv/data/api/*`, so `configure` needs no change.

What the identity may do:

| Prefix of the bucket `evidence` | Read | Write |
|---|---|---|
| `proposals/`, `diffs/` | Yes: the API reads every stored file back and checks its SHA-256 before it builds a pack | No |
| `packs/` | Yes | Yes (never overwrites; SeaweedFS lets write also delete, as for the runner: versioning keeps the content) |
| Anything else | No | No |

So the API can now read client code (proposals and diffs). It reads one file at a time, at most `SDLC_API_EVIDENCE_MAX_ITEM_MB` (default 256), keeps only the hash, and never logs the content.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4); SeaweedFS runs (`pnpm compose:core`).
2. Create the identity. The command asks for an admin token (hidden). It makes a new key pair inside the openbao container, stores it at `kv/api/evidence` and gives it to SeaweedFS as `api-evidence`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap api-evidence-credentials
   ```
   Record it in the operations log (identity `api-evidence`, date, reason; not the keys).
3. Restart the API: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile platform restart sdlc-api`.
4. Check: the API's log has no line with `api.evidence_missing`. `adlc evidence build <INT-…>` on an intent you may build answers with a version.

Without it the API still starts (log line `api.evidence_missing`), but `adlc evidence build` and `adlc evidence export` answer `evidence_unavailable`. Never run `weed shell s3.config.show` or `s3.configure` without `-apply` on the server: they print the keys. Admin work in SeaweedFS: section 5l.

### Rotation

| What | Steps |
|---|---|
| The API's evidence key (`api-evidence`, every 90 days or when it may have leaked) | `pnpm openbao:bootstrap api-evidence-credentials`, then restart `sdlc-api`. The old key stops working at once; a build that runs at that moment fails and can be repeated |

## 5i. The worker's evidence identity (G8 release packs)

At gate G8 the worker builds the intent's Evidence Pack itself before Person B approves the release (task E03, `design/ADR-M49-gate-g8.md`, handbook Ch.15 §15.10.3). It uses its own SeaweedFS identity `worker-evidence`, stored at `kv/worker/evidence`, with **the same rights as `api-evidence`** (section 5h table). The AppRole `worker` already reads `kv/data/worker/*`, so `configure` needs no change.

So three processes can read client code in the evidence store: the runner, the API and the worker. Each has its own key; the worker reads one file at a time, at most `SDLC_WORKER_EVIDENCE_MAX_ITEM_MB` (default 256), keeps only the hash, and never logs the content.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4); SeaweedFS runs (`pnpm compose:core`).
2. Create the identity (asks for an admin token, hidden; prints no secret):
   ```bash
   pnpm openbao:bootstrap worker-evidence-credentials
   ```
   Record it in the operations log (identity `worker-evidence`, date, reason; not the keys).
3. Restart the worker: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile platform restart sdlc-worker`.
4. Check: the worker's log has no line with `worker.evidence_missing`.

Without it the worker still starts (log line `worker.evidence_missing`), but intents wait at G8 (`evidence_unavailable`); people's rejections are still handled.

### Rotation

| What | Steps |
|---|---|
| The worker's evidence key (`worker-evidence`, every 90 days or when it may have leaked) | `pnpm openbao:bootstrap worker-evidence-credentials`, then restart `sdlc-worker`. The old key stops working at once; a build that runs at that moment fails, and the workflow tries again a minute later |

## 5j. Evidence retention: the purge identity and the lock

The worker deletes evidence files whose retention is over, and those of archived projects (task E05, `design/ADR-M51-evidence-retention.md`, D-02 FR-44). It uses its own SeaweedFS identity `worker-purge`, stored at `kv/worker/purge`. The AppRole `worker` already reads `kv/data/worker/*`, so `configure` needs no change.

**What the identity may do:**

| Right | Where | Why |
|---|---|---|
| `Write` (which includes delete in SeaweedFS) | `evidence/proposals/*`, `evidence/diffs/*`, `evidence/packs/*` | delete every version of a file whose retention is over |
| `BypassGovernanceRetention` | the same three prefixes | delete young files of an archived project, and pack files without a row |
| `PutObjectLegalHold`, `PutObjectRetention`, `GetObjectRetention` | the same three prefixes | holds; move the lock forward for projects that keep evidence longer |
| `List` | the bucket `evidence` | find versions and pack files without a row |

It has **no `Read`**: it never sees a file's content.

**The lock.** `seaweedfs-init` turns on object lock for the bucket `evidence`: mode GOVERNANCE, 180 days by default (`SEAWEEDFS_LOCKED_BUCKETS=evidence:GOVERNANCE:180`). From then on no writer (runner, API, worker) can delete a version during its first 180 days. Only `worker-purge` can bypass the lock, and only for an archived project or a pack file without a row. A legal hold (set for a held intent) refuses even that. The lock cannot be turned off again.

> The filer API that once skipped the lock (QUESTIONS #239) is closed since task A12: only the S3 API is reachable on the Compose network (section 5l).

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4); SeaweedFS runs, and `seaweedfs-init` ran after the update (`pnpm compose:core`). Its log ends with `bucket evidence locked (GOVERNANCE, 180 days)`.
2. Create the identity (asks for an admin token, hidden; prints no secret):
   ```bash
   pnpm openbao:bootstrap worker-purge-credentials
   ```
   Record it in the operations log (identity `worker-purge`, date, reason; not the keys).
3. Restart the worker: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile platform restart sdlc-worker`.
4. Check: the worker's log has a line `worker.retention_pass` every hour, with `mode: report`. It has no line `worker.retention_missing`.

### From `report` to `purge`

The loop starts in `report` mode: it counts what it would purge and deletes nothing. Deleting cannot be undone.

1. Read the report for each tenant on the server:
   ```bash
   SDLC_DB_URL=<platform_app URL> pnpm adlc ops retention report --tenant <slug>
   ```
   For each project it shows the retention days, how many files are stored, due now, held, of open intents, and purged.
2. Compare it with what you expect (the projects' `evidence_retention_days`, the holds).
3. Set `SDLC_WORKER_RETENTION_MODE=purge` in `platform/deploy/.env` and restart `sdlc-worker`. Record it in the operations log.
4. If the log shows `retention.guard_tripped`, the loop refused to purge a large share of a tenant at once (default: more than 20 % of its files, and more than 20 files). Check the report again. If it is right, raise `SDLC_WORKER_RETENTION_GUARD_PERCENT` for one pass, then set it back.

### Archived projects and Langfuse

- **Archiving.** A tenant admin archives a project with `adlc admin project archive --project <slug>`. It is refused while the project has open intents. The first pass in `purge` mode after the archive schedules the purge (audit `project.purge_scheduled`, log `retention.archive_purge_scheduled`); the worker purges the project's evidence files `SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS` (default 7) later. A project archived before you turned on `purge` gets the same 7 days from then. Held intents stay. When nothing is left, the audit log gets `project.purged`.
- **A mistaken archive.** There is no un-archive command. Within the grace period, set `projects.status` back to `active` on the server with the owner role, and record it in the operations log.
- **Langfuse** (task E08, `design/ADR-M53-langfuse-purge.md`). The same loop deletes the model-call traces of the intents it purges, by the same rules (open and held intents never), when the worker's Langfuse purge is on (section 5m). Langfuse deletes a few seconds later; the next pass confirms (`langfuse.purged` in the audit log). An archived project gets `project.purged` only after every finished, not held intent is confirmed, with `langfuse: purged`. With `SDLC_WORKER_LANGFUSE_URL=off` it records `langfuse: not_deployed`.
- **What the log says.**
  - `retention.langfuse_tag_mismatch`: a trace found by an intent's run tags carries another tenant, project or intent tag. Nothing of that intent is deleted, and its purge waits. Look at the trace in the Langfuse UI (filter by the tag `run_id:<run ID>`; the run IDs are in `adlc run list <INT>`). If the trace is the intent's, delete it by hand as below; the next pass confirms.
  - `retention.langfuse_guard_tripped`: one intent has more than 5,000 traces. Check it the same way; delete by hand if right.
  - `retention.langfuse_purge_pending`: Langfuse still shows traces after a request. Check that `langfuse-worker` runs.
  - `retention.langfuse_failed`, `retention.project_purge_waits_langfuse`: Langfuse cannot be reached, or the worker has no Langfuse credential (section 5m).
  - `retention.langfuse_project_mismatch`: the worker's Langfuse key belongs to another Langfuse project. Nothing is purged in Langfuse until it is fixed (section 5m step 1).
  - `retention.langfuse_tenant_guard_tripped`: too many intents of a tenant are due at once (the evidence guard settings). Check `pnpm adlc ops retention report --tenant <slug>`; raise `SDLC_WORKER_RETENTION_GUARD_PERCENT` for one pass if right.
- **Deleting traces by hand** (the cases above, or `project.purged` events from before E08 with `langfuse: manual`): on the server, never from a chat tool.
  1. In the Langfuse UI, filter the traces by the tag `run_id:<run ID>` of each run of the intent (or `tenant:<tenant slug>` and `project:<project slug>`), and check them.
  2. Delete them in the UI, or with `DELETE /api/public/traces` and the worker's Langfuse key.
  3. Remove the deleted rows from disk: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile observability exec clickhouse sh -c "echo 'ALTER TABLE default.events_full APPLY DELETED MASK; ALTER TABLE default.events_core APPLY DELETED MASK' | clickhouse-client --multiquery"`.
  4. Record the date and the number of traces in the operations log.

### Rotation

| What | Steps |
|---|---|
| The purge key (`worker-purge`, every 90 days or when it may have leaked) | `pnpm openbao:bootstrap worker-purge-credentials`, then restart `sdlc-worker`. The old key stops working at once; a pass that runs at that moment fails and the next one tries again |

## 5k. The daily audit anchor

Once a day the worker writes each tenant's latest audit hash to SeaweedFS, outside the database (task E05 PR 2, `design/ADR-M51-evidence-retention.md` §2.9, D-05 §7.4). `adlc audit verify` finds a changed row, but not a whole chain that someone with database access rewrote with new hashes. An older anchor still shows that.

**What is written.** One file per tenant and UTC day, `audit-anchors/<tenant ID>/<YYYY-MM-DD>.json`: the tenant ID, the `seq` and `hash` of its last audit row, the hash version and the time. The bucket `audit-anchors` is versioned and carries object lock **COMPLIANCE, 731 days** (`seaweedfs-init`, `SEAWEEDFS_LOCKED_BUCKETS`): nobody can delete an anchor or shorten its lock through S3, the admin included. The lock cannot be turned off.

**The identity** `worker-anchor`, stored at `kv/worker/anchor`:

| Right | Where | Why |
|---|---|---|
| `Write` | the bucket `audit-anchors` | write the day's anchor (once: `If-None-Match`) |
| `Read`, `List` | the bucket `audit-anchors` | read every anchor back and compare it with the database |
| `GetObjectRetention` | the bucket `audit-anchors` | check that a new anchor got the COMPLIANCE lock |

Nothing in `evidence`.

**When.** In the retention loop (every `SDLC_WORKER_RETENTION_INTERVAL_MINUTES`, 60 by default), before the retention steps, once per tenant and UTC day. Each tenant: first every anchor is read and compared with the row at its `seq`, then today's anchor is written. Days the worker was down get no anchor: an anchor is never back-dated.


### First set-up

1. `seaweedfs-init` ran after the update (`pnpm compose:core`). Its log ends with `bucket audit-anchors locked (COMPLIANCE, 731 days)`.
2. Create the identity (asks for an admin token, hidden; prints no secret):
   ```bash
   pnpm openbao:bootstrap worker-anchor-credentials
   ```
   Record it in the operations log (identity `worker-anchor`, date, reason; not the keys).
3. Restart `sdlc-worker` (section 5j, step 3).
4. Check the worker's log: one line `worker.audit_anchored` per tenant with `outcome: written`, `seq` and `hash`, and a line `worker.anchor_pass` every pass. No line `worker.anchor_missing`, `worker.audit_anchor_unlocked` or `worker.audit_anchor_mismatch`.

The `hash` in `worker.audit_anchored` is the second copy D-05 §7.4 asks for: keep the worker's logs with the operations log.

### On `worker.audit_anchor_mismatch`

The line names the tenant, the anchor's date, its `seq` and a reason. It never holds a hash. The tenant's audit log gets one `audit.anchor_mismatch` event per check, with counts and the first reason.

| Reason | Meaning |
|---|---|
| `hash_mismatch` | The row at that `seq` has another hash than on that day: the chain was rewritten after it |
| `seq_missing` | No row at that `seq`: rows were deleted |
| `anchor_versions` | The anchor key has a delete marker or a second version: someone wrote over it with the anchor key. The original version is still there |
| `anchor_invalid` | A file in the tenant's folder is not a well-formed anchor of that tenant and date |

Treat every mismatch as a security incident (handbook Ch.6, level `incident`):

1. Stop writers: stop `sdlc-api` and `sdlc-worker` so the chain does not grow while you look.
2. Check the chain on the server: `SDLC_DB_URL=<platform_app URL> pnpm adlc ops audit verify --tenant <slug>`. A broken chain names its first broken `seq`. A chain that verifies but does not match the anchor was rewritten as a whole.
3. Read the anchor of that day with the admin identity, on the server, never from a chat tool. Compare its `seq` and `hash` with the row in the database and with the last database backup that is older than the anchor's date.
4. For `anchor_versions`: rotate the anchor key at once (below). List the key's versions; the oldest version is the real anchor.
5. Restore the database from the last good backup (section 7 and task A10) if rows were changed or deleted. Record the incident (template T9).
6. **Only that tenant's anchors and hashes** go into the incident note or to the tenant. Never send one tenant another tenant's anchors, hashes or log lines.

The same mismatch is reported again every day until the database is restored: anchors cannot be removed.

### `worker.audit_anchor_unlocked`

A new anchor did not get COMPLIANCE for at least 730 days: someone changed the bucket's default lock. Run `seaweedfs-init` again (`pnpm compose:core`): it sets `COMPLIANCE`, 731 days back. Anchors written before keep their own lock. Record it in the operations log.

### Rotation

| What | Steps |
|---|---|
| The anchor key (`worker-anchor`, every 90 days, when it may have leaked, or after `anchor_versions`) | `pnpm openbao:bootstrap worker-anchor-credentials`, then restart `sdlc-worker`. The old key stops working at once |

### Development machines

Anchors on a development volume stay 731 days and cannot be removed through S3. They are small (about 200 bytes per tenant and day). `pnpm compose:down` with `-v` removes the volume, anchors included. Throw-away test projects remove their volume.
## 5l. SeaweedFS admin work

Since task A12 (`design/ADR-M52-seaweedfs-internal-access.md`) only the S3 API of SeaweedFS (port 8333) is reachable on the Compose network. The master, the volume server and the filer listen on `127.0.0.1` inside the container `seaweedfs`, and they need JWT keys. No other container, and no host process, can reach them.

**The keys.** `platform/deploy/seaweedfs/start.sh` makes four new random keys at every start and writes them to `/etc/seaweedfs/security.toml` inside the container (mode 600). They are kept nowhere else: not in `.env`, not in OpenBao. A restart rotates them; nothing to do. If the script cannot write them, SeaweedFS does not start: the container log has a line `seaweedfs-start: …`. Fix the cause (usually a read-only or full file system) and start it again. Never copy the file or print it.

**Admin commands** run only inside the container, with the master at `127.0.0.1`:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core exec seaweedfs weed shell -master=127.0.0.1:9333
```

- The service name `seaweedfs` as the master address does not work any more: the master does not listen on the network.
- The `*-credentials` commands of `pnpm openbao:bootstrap` do this for you.
- Never run `s3.config.show`, or `s3.configure` without `-apply`: they print the keys.
- `weed shell` inside the container can delete anything, locked files too (`fs.rm`). Use it only for the commands of this runbook, and record each use in the operations log.
- `seaweedfs-init` runs in the network namespace of `seaweedfs` (Compose `network_mode: service:seaweedfs`). Never give another service that setting.

**After the A12 update:** run `pnpm compose:core` once. It recreates `seaweedfs` with the new settings and runs `seaweedfs-init` again. Existing data stays readable; the identities are kept.

## 5m. The worker's Langfuse purge

The worker's retention loop (section 5j) also deletes the model-call traces of purged intents in Langfuse (task E08, `design/ADR-M53-langfuse-purge.md`). The traces hold prompts and responses: client data.

**What it does, per pass, in `purge` mode:**
- asks Langfuse to delete the traces of each due intent, found by the intent's run tags and checked tag by tag; confirms on a later pass;
- deletes Langfuse's raw OTLP files (`langfuse/events/otel/…` in SeaweedFS) older than `SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS` (24), **for every tenant**: one file holds a whole batch of several tenants, so they cannot be deleted per project. Langfuse cannot replay older files any more (a repair tool we do not use);
- after a pass that confirmed deleted traces, at most once a day, removes the deleted rows from ClickHouse's disk (`APPLY DELETED MASK`; log `retention.langfuse_compacted` with its duration).

In `report` mode it only counts (`langfuseDue`, `langfuseRawFound` in `worker.retention_pass`).

**The credentials**, one OpenBao entry `kv/worker/langfuse`, read only by the `worker` AppRole:

| Part | Rights | Made by |
|---|---|---|
| The worker's own Langfuse project key | Langfuse OSS keys have no scopes: it could also read prompts and send traces. The worker never asks for prompts | You, once, in the Langfuse UI |
| ClickHouse user `sdlc_purge` | `ALTER DELETE` on `default.events_full` and `default.events_core` only (`APPLY DELETED MASK` needs it). It reads nothing, but could delete every row of the two tables | The command below |
| SeaweedFS identity `worker-langfuse` | `List:langfuse`, `Write:langfuse/events/otel/*` (delete); never read | The command below |

The collector keeps its own key (Langfuse's init key in `.env`).

### First set-up

Needs the profiles `core` and `observability` running, and OpenBao unsealed. Run it in a terminal on the server, never through a chat tool.

1. **Make the worker's Langfuse key.** Sign in to Langfuse (`http://127.0.0.1:${LANGFUSE_HOST_PORT}`, the admin account of `.env`). Open the project "Agentic SDLC platform" → Settings → API keys → Create new API key. Name it `sdlc-worker-purge`. Keep the window open: the secret key is shown once.
2. **Store it and make the other two credentials:**
   ```bash
   pnpm openbao:bootstrap worker-langfuse-credentials
   ```
   It asks for an admin token, the public key (`pk-lf-…`) and the secret key (`sk-lf-…`), all hidden. It stores `kv/worker/langfuse`, applies the SeaweedFS identity and the ClickHouse user, checks both, and prints no secret. Then close the Langfuse window.
   - The command makes the user as `sdlc_admin`, a ClickHouse user that answers only inside the container (`platform/deploy/clickhouse/sdlc-admin.xml`; it may manage users and grant `ALTER DELETE` on the two event tables, nothing else). Langfuse's own user `langfuse` cannot create users (ADR-M63 §6). On a server updated from before A10, restart ClickHouse once first (`pnpm compose:obs`); an existing `sdlc_purge` keeps working.
3. **Turn it on.** Set `SDLC_WORKER_LANGFUSE_URL=http://langfuse-web:3000` in `platform/deploy/.env`. (`up.sh` also sets it when `observability` is in the same call or Langfuse's ClickHouse volume exists: Langfuse's data stays in its volumes when the profile is off.) Restart `sdlc-worker`. The start log has no `worker.langfuse_missing`; the first pass logs no `retention.langfuse_project_mismatch` (the key must belong to the project "Agentic SDLC platform", `LANGFUSE_INIT_PROJECT_ID`).
4. Record the date in the operations log.

### Rotation

| What | Steps |
|---|---|
| The ClickHouse password and the S3 key (every 90 days, or when they may have leaked) | Make a new Langfuse key as in step 1, run `pnpm openbao:bootstrap worker-langfuse-credentials`, restart `sdlc-worker`, then delete the old Langfuse key in the UI. The old password and S3 key stop working at once |
| The Langfuse key only (it may have leaked) | The same steps; delete the old key in the Langfuse UI at once |

## 5n. The dashboard's GitHub sign-in: the App's client secret

People sign in to the dashboard with GitHub through the platform's GitHub App (task U05, `design/ADR-M73-dashboard-actions.md` §2.2). The api exchanges the sign-in code with the App's **client secret**. It lives in OpenBao at `kv/api/github-oauth` (field `client_secret`), read only by the `api` AppRole. The client ID stays in `kv/shared/github-app`. Sign-in is off until you turn it on.

**Never** paste the client secret into a chat, an issue, a log or a file in a repository. Run every step yourself, in a terminal on the machine of the stack (the macOS Terminal app on a developer machine), never through a chat tool.

### First set-up

Needs `core` running and OpenBao unsealed.

1. **The App.**
   - A new App from `pnpm github-app:create`: the client secret is in `<key file>.client-secret` (mode 600), and the App already lists the callback URL `http://localhost:8090/v1/auth/github/callback` (add others with `--callback-url`).
   - An existing App (for example the development App `harryforge-sdlc-dev`): on GitHub, open the App's settings. Add the callback URL `<public origin>/v1/auth/github/callback` (on a developer machine `http://localhost:8090/v1/auth/github/callback`). Keep **Expire user authorization tokens** on and **Request user authorization (OAuth) during installation** off. Press **Generate a new client secret**; it is shown once.
2. **Store it.** From a file:
   ```bash
   pnpm openbao:bootstrap api-github-oauth-credentials < ~/secrets/sdlc-app.private-key.pem.client-secret
   ```
   or at the hidden prompt (copy it from GitHub, paste it, press Enter):
   ```bash
   pnpm openbao:bootstrap api-github-oauth-credentials
   ```
   Both ask for an admin token at a hidden prompt first. The answer is `stored: kv/api/github-oauth (client_secret)`. Delete the `.client-secret` file afterwards.
3. **Turn it on.** In `platform/deploy/.env`: `SDLC_API_WEB_SIGNIN=github` and `SDLC_API_PUBLIC_ORIGIN=http://localhost:8090` (the address people open; `https://…` behind a proxy; plain `http://` only on `localhost`, never `127.0.0.1`). Restart `sdlc-api` (`pnpm compose:platform`). The start log has no `api.web_signin_off`.
4. **Check.** Open `http://localhost:8090/dashboard/`, choose the tenant and **Sign in with GitHub**. Only active users with a linked GitHub identity get in (`adlc admin identity link`). A refusal shows the same message whatever the cause; the api logs `api.signin_refused` with a code (`cause`).
5. Record the date in the operations log.

### Rotation

| What | Steps |
|---|---|
| The client secret (every 90 days, or when it may have leaked) | On GitHub, generate a new client secret, store it as in step 2. The api reads it again within 10 minutes; no restart. Then delete the old client secret on GitHub |
| Everyone signed in must sign in again (an incident) | A tenant admin: `adlc admin user sign-out --user <id or email>` for each person; a person: **Sign out everywhere** in the dashboard |

### Notes

- Sessions are stored as hashes in `web_sessions`; they end after 30 idle minutes or 8 hours (`SDLC_API_SESSION_IDLE_MINUTES`, `SDLC_API_SESSION_MAX_HOURS`), at sign-out, when a user is disabled or an identity unlinked.
- The api revokes each person's GitHub token right after it read the account ID; the platform never acts on GitHub as the person.
- WebKit (Safari) keeps no `Secure` cookie on `http://localhost`, so Safari cannot sign in with GitHub there; use Chrome or Firefox (ADR-M73 §4, tested 2026-10-12).

## 5o. The worker's index of project documents (`knowledge-db`)

A plan with a `read_documents` register tool (task X04, `design/ADR-M89-project-docs-index.md`) needs an index of the project's Markdown documents. The worker builds it in its run preparation, in `knowledge-db`: a PostgreSQL with pgvector of its own (Compose profile `knowledge`), never the platform's database. The worker connects as the role `knowledge` (owner of the database `knowledge`, may create roles, no superuser). Its password lives in OpenBao at `kv/worker/knowledge-db` (field `password`), read only by the `worker` AppRole. The superuser password of `knowledge-db` is `KNOWLEDGE_DB_SUPERUSER_PASSWORD` in `.env`, as for the platform's PostgreSQL.

Without the index, a run whose plan asks for a `read_documents` tool fails (`tool_unavailable`, run event `knowledge_unavailable`). Other runs are not affected.

The tool itself reads the index with a **short-lived login of its run** (task X04 PR 3b). OpenBao's database secrets engine (mount `database/`) makes it: the worker writes one OpenBao role per run, `kdocs-<run_id>`, whose only grant is the project's read role, reads one login that lives as long as the run may, and revokes it at the end of the run or at a kill. OpenBao logs in to `knowledge-db` as the role `kdocs_issuer` (may create and drop roles, holds each project's read role with the admin option only, cannot read an index itself). Its password is rotated inside OpenBao: nobody knows it, and it is never stored in a KV entry. Without this set-up, a run with a `read_documents` tool fails with `tool_unavailable` (code `credentials_unavailable`).

### First set-up

Needs the profiles `core` and `knowledge` running, and OpenBao unsealed. Run it in a terminal on the server, never through a chat tool.

1. Start the profile: `pnpm compose:knowledge` (or add `knowledge` to your `up.sh` call). `up.sh` sets `SDLC_WORKER_KNOWLEDGE_DB_URL=postgresql://knowledge@knowledge-db:5432/knowledge` when the profile is in the same call or the volume of `knowledge-db` exists; set it in `.env` otherwise.
2. Make and set the password:
   ```bash
   pnpm openbao:bootstrap worker-knowledge-credentials
   ```
   It asks for an admin token (hidden), makes a random password inside the OpenBao container, stores it at `kv/worker/knowledge-db` and sets it on the role `knowledge` through `psql` in `knowledge-db` (the SQL on standard input; the session logs no statement). It prints no secret.
3. Set up the tools' logins (needs `pnpm openbao:bootstrap configure` first, which mounts `database/`):
   ```bash
   pnpm openbao:bootstrap knowledge-issuer-credentials
   ```
   It asks for an admin token (hidden). It makes a random password inside the OpenBao container, writes the connection `knowledge-db` of the database engine with it (roles `kdocs-*` only), sets up the role `kdocs_issuer` in `knowledge-db` through `psql` (the SQL on standard input; the session logs no statement), then has OpenBao rotate the password (`rotate-root`). It prints no secret. The worker's policy allows `database/roles/kdocs-*`, `database/creds/kdocs-*` and the revocation of those leases only.
4. Restart `sdlc-worker` and `sdlc-runner`. The start log has no `worker.knowledge_missing` and no `worker.knowledge_off`.
5. The embedding model `bge-m3` must be on LiteLLM: on a developer machine `ollama pull bge-m3` with the `ollama` provider stored (section 5d). Record the date in the operations log.
6. Register the tool (handbook Ch.20 §20.5c): build its image with `pnpm tool-image:build project-docs` (or take `pnpm images get TOOL_PROJECT_DOCS` on a release checkout).

### Rotation

Run `pnpm openbao:bootstrap worker-knowledge-credentials` again (every 90 days, or when the password may have leaked), then restart `sdlc-worker`. The old password stops working at once.

Run `pnpm openbao:bootstrap knowledge-issuer-credentials` again to repair the issuer (for example after a restore of `knowledge-db`); it ends with a new password that only OpenBao knows. The tools' own logins need no rotation: each lives one run. To end every login of one run by hand (for example when the worker was down at a kill), revoke its prefix with an admin token: `bao lease revoke -prefix database/creds/kdocs-<run_id>`. A login also ends by itself at its `VALID UNTIL` time.

### Retention

The retention loop (section 5j) deletes an index version from `knowledge-db` when every intent that used it is finished and not held and it was not used for the project's evidence retention (never under 180 days), and every version of an archived project after the archive grace. Each deletion appends `knowledge.purged`. A later pass also sweeps what a failed delete or a failed build left in `knowledge-db` after one hour (`knowledgeSwept`). In `report` mode it only counts (`knowledgeDue` in `worker.retention_pass`). A failure logs `retention.knowledge_failed` with a code; the next pass tries again.

## 6. Daily backup

The whole platform is backed up by one command, `pnpm backup` (`platform/deploy/backup/backup.sh`, task A10, `design/ADR-M63-openbao-tls-and-backups.md` §5, QUESTIONS #326–#329). It writes one folder per run into `SDLC_BACKUP_DIR`:

| File | What |
|---|---|
| `postgres.sql.age` | Every database (`pg_dumpall`), while the platform runs |
| `openbao.snap.age` | OpenBao's Raft snapshot, through the AppRole `backup` (it may read only the snapshot) |
| `volume-seaweedfs-data.tar.age`, `volume-openbao-audit.tar.age`, `volume-clickhouse-data.tar.age` | The evidence, the audit anchors and Langfuse's files; OpenBao's audit log; ClickHouse (when it exists). SeaweedFS and ClickHouse stop for about a minute while they are copied |
| `env.tar.age`, `openbao-tls.tar.age` | The env file (passwords and keys: a restore needs them) and OpenBao's TLS folder |
| `MANIFEST` | The SHA-256 and size of every file, the commit and the images; no secret |

**Two jobs, both required:** the backups, and the key shares (sections 2 and 3), kept apart. The snapshot is useless without two shares; the backups are useless without the age private key.

**Set up once (infrastructure operator):**

1. Install `age` on the server (`apt-get install age`; macOS `brew install age`).
2. Make the backup key pair on a machine that is **not** the server, for example the laptop of a key holder: `age-keygen -o sdlc-backup-key.txt`. It prints the public key (`age1…`).
3. Put the **private key** file offline with the key shares (an encrypted USB drive in the safe, and the password managers of two key holders). It never goes to the server.
4. On the server, write the public key into a file, for example `/etc/sdlc/backup-recipients.txt`, and set in `platform/deploy/.env`: `SDLC_BACKUP_DIR` (a mounted NAS or an external disk, outside the repository), `SDLC_BACKUP_AGE_RECIPIENTS` (that file), and optionally `SDLC_BACKUP_KEEP` (default 14).
5. After the A10 update, run `configure` again once (a root token, section 5: it adds the AppRole `backup`), then `pnpm openbao:bootstrap backup-credentials` (admin token; prints no secret). Rotate it with the others every 3 months (section 8.1).
6. Install the daily timer: copy `platform/deploy/backup/sdlc-backup.service` and `sdlc-backup.timer` to `/etc/systemd/system/`, change `WorkingDirectory` and `User`, then `systemctl enable --now sdlc-backup.timer` (every night at 02:30). Or call `pnpm backup` from cron.
7. Run `pnpm backup` once by hand and check the folder.

**Every day (automatic) and every week (a person):**

- `pnpm backup` keeps the newest `SDLC_BACKUP_KEEP` folders and removes the older ones. A failed run writes no folder and exits with an error: `journalctl -u sdlc-backup` shows why.
- Once a week, check that today's folder exists and its files are not empty. Copying the target folder further away (another site) is the company infrastructure's job.
- Treat every backup like the server: it holds personal data, client code (the evidence) and every password, encrypted.

## 6b. Operational alerts

`pnpm alerts` (task O03, `design/ADR-M101-operational-alerts.md`) runs the checks of `pnpm doctor` and sends what changed to the operator: a stopped or unhealthy service, a sealed OpenBao, a full disk or backup target, a backup that did not run, a TLS certificate near its end. It works while the platform is down and OpenBao is sealed. A message never holds a secret, an env value or a log line. Settings and the message: `platform/deploy/README.md`, section "Alerts".

**Set up once (the infrastructure operator):**

1. Choose the channels: a chat webhook (Slack, Google Chat, Mattermost, Rocket.Chat, or your own receiver with the `json` format), e-mail through the server's `sendmail`, or both.
2. For a webhook, put the URL alone in a file the operator account reads, mode 600, outside the repository: `install -m 600 /dev/null /etc/sdlc/alert-webhook-url`, then write the URL with an editor (never with `echo` on the command line: the shell history keeps it). Set `SDLC_ALERT_WEBHOOK_FILE` to that file. The URL is a secret: whoever holds it can post to the channel.
3. For e-mail, set `SDLC_ALERT_EMAIL_TO` (and `SDLC_ALERT_EMAIL_FROM` if your mail relay needs it). The server's mail system sends it; the platform holds no SMTP password.
4. `pnpm alerts --test`: every channel gets a test message. Then `pnpm alerts --dry-run`: what would be sent now, nothing changed.
5. Install the timer: copy `platform/deploy/alerts/sdlc-alerts.service` and `sdlc-alerts.timer` to `/etc/systemd/system/`, change `WorkingDirectory` and `User`, then `systemctl enable --now sdlc-alerts.timer` (every 10 minutes). Or the cron line in the unit file.

**When an alert comes:** each line names the check and its fix (a command, a section of this runbook or of the deploy README). Run `pnpm doctor` on the server for the full picture. A sealed OpenBao: section 4. A backup that did not run: `journalctl -u sdlc-backup`, then section 6. A certificate near its end: section 3c or 3d. The same problem comes again every `SDLC_ALERT_REMIND_HOURS` (24) until it is fixed, then a "resolved" line.

**If the webhook URL leaks:** make a new one in the chat tool, remove the old one there, and write the new URL into the file. Nothing else holds it.

## 7. Restore and the recovery drill

`pnpm restore <backup folder> <age private key file>` (`platform/deploy/backup/restore.sh`) restores a backup into an **empty** stack: a test machine for the drill, or a new server after a loss. It refuses when the env file or the project's volumes exist.

**The drill: first before the first real data, then every 3 months and whenever a key holder changes.** Tested automatically on throw-away keys by `pnpm test:backup` (CI).

1. On a test machine with Docker, `age` and a checkout of the same commit as the backup (`MANIFEST`, line `commit`): copy one backup folder there, and bring the age private key and two key holders.
2. `pnpm restore <folder> <private key file>`. It checks every file against `MANIFEST` (a changed or missing file stops it before anything is written), writes `platform/deploy/.env` and the TLS folder, fills the volumes, loads the databases, and restores OpenBao's snapshot over a throw-away initialisation. OpenBao is then **sealed with the original keys**.
3. Two key holders unseal with their **original** shares: `pnpm openbao:bootstrap unseal` (section 4).
4. Deliver the credentials of every process again (`platform/deploy/README.md`, "Fresh deployment" step 5; their volumes are not in the backup), then `platform/deploy/scripts/up.sh core models platform sandbox`.
5. Check:
   - `pnpm openbao:bootstrap status` says `unsealed`; the Transit key `run-contract` exists;
   - `SDLC_DB_URL=… pnpm adlc ops audit verify` passes for every tenant;
   - `curl -s http://127.0.0.1:8090/health/ready` answers;
   - an Evidence Pack of a closed intent opens (`adlc evidence show`).
6. On a test machine, destroy everything afterwards (`docker compose … down -v`, the env file, the TLS folder). Record the drill, its date and the people in the operations log (section 10).

## 8. Changing a key holder, rotating secret IDs

### 8.1. Access review every 3 months (handbook Ch.3)

Every 3 months, and when someone changes project:
- check the list of key holders and people with Docker access on the server;
- **rotate every AppRole secret ID** in one pass: `pnpm openbao:bootstrap rotate-credentials` asks for the admin token once and runs `api-credentials`, `worker-credentials`, `runner-credentials`, `litellm-credentials` and `backup-credentials` for every AppRole that has a secret ID here (task O05, `design/ADR-M102-key-rotation.md`). `pnpm doctor` and `pnpm alerts` warn 14 days before a secret ID ends (`SDLC_APPROLE_WARN_DAYS`). The single commands stay, one per credential: `worker-credentials` (AppRoles `worker` and `cost-controller`), `runner-credentials`, `litellm-credentials`, `backup-credentials` and the evidence, purge, anchor and Langfuse credentials (sections 5d–5m and 6; the full list: `platform/deploy/README.md`, Fresh deployment step 5). Each command:
  1. issues a new secret ID;
  2. writes it with the role ID into the service's volume;
  3. then destroys **every other** secret ID of the AppRole. It keeps the one named by the accessor of the new secret ID, never the newest by time (`design/QUESTIONS.md` #140).

  If the delivery fails, nothing is destroyed. If destroying fails, the command fails with a message; run it again. Then restart the service and check it logs in. If `rotate-credentials` stops in the middle, it names what it renewed so far: running it again is safe, and every service it named as written needs a restart.
- record the review in the operations log.

Secret IDs expire after 90 days in any case, so a missed rotation shows up as a failed login.

- **One process per AppRole.** After a rotation an AppRole has exactly one secret ID. Do not run a second instance of a service with its own secret ID: the next rotation would cut it off. Several instances of a service need a new design.
- A lost or leaked secret ID of a process that is not deployed through these commands: destroy it by its accessor, `bao write auth/approle/role/<role>/secret-id-accessor/destroy secret_id_accessor=<accessor>`.

### 8.2. After a leaked secret ID or token

Destroying a secret ID does **not** end the tokens already issued from it. They stay valid until they expire (TTL, time to live: 1 hour, at most 4 hours), and they work only from the Compose network.

1. Rotate at once: run the service's credentials command (section 8.1) and restart the service.
2. If a token of the role may have leaked too, revoke all tokens of that AppRole. This needs a root token (section 5), because it lists every token accessor. Replace `api` with the role. The command prints only a count:
   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -it openbao sh -c '
     stty -echo; printf "Root token (hidden): "; IFS= read -r BAO_TOKEN; stty echo; echo; export BAO_TOKEN
     role=api; n=0
     for a in $(bao list -format=json auth/token/accessors | tr -d "[]\", "); do
       bao token lookup -format=json -accessor "$a" 2>/dev/null | grep -q "\"role_name\": \"$role\"" || continue
       bao token revoke -accessor "$a" >/dev/null && n=$((n + 1))
     done
     echo "revoked $n token(s) of the AppRole $role"'
   ```
   The service logs in again with its new secret ID at its next request. Revoke the root token afterwards (section 5).
3. Record the leak, the rotation and the revocation in the operations log.

### 8.3. Rekey when a key holder changes

> Not yet tested: the rekey commands need an interactive terminal. The `bao operator rekey` command may call token-protected endpoints, as `bao operator generate-root` does in OpenBao 2.5+. The A10 drill checks the commands below and adds a `bootstrap.sh rekey` command if needed.

When a key holder leaves or changes role, create a **new set of shares** and destroy the old envelopes:

1. Leadership names the new holder. Record the change in the operations log.
2. Two current key holders start the rekey inside the container, on the key-holder listener:
   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
     sh -c 'BAO_ADDR=http://127.0.0.1:8210 bao operator rekey -init -key-shares=3 -key-threshold=2'
   ```
3. Each of the two holders runs `bao operator rekey -nonce=<nonce>` (same `docker compose exec … sh -c 'BAO_ADDR=http://127.0.0.1:8210 …'`) and types their share at the hidden prompt.
4. The new 3 shares are printed once. Handle them as in section 3.2 steps 3, 7 and 8: one share for each holder, including the new one.
5. Unseal test: restart the `openbao` container and unseal with two **new** shares.
6. Destroy the old envelopes in front of a witness. Record it in the safe log and the operations log.
7. Run a recovery drill (section 7) with the new shares.

### 8.4. The Run Contract signing key: rotation and revocation

The worker signs every Run Contract, every evaluation contract and every task-check contract with the Transit key `run-contract`; the runner checks the signature through Transit (task O05, `design/ADR-M102-key-rotation.md`, ADR-M22 §2.4). Each signature names its key version (`vault:v<N>:…`), and `run_contracts.key_version` keeps it.

**Rotation (automatic).** `configure` sets `auto_rotate_period` on the key (`TRANSIT_AUTO_ROTATE_PERIOD` in `bootstrap.conf`, default 2160h = 90 days). OpenBao then makes a new key version by itself; nobody needs to act. New contracts use the new version. Contracts signed before keep verifying until they expire (`run.contract_validity_minutes`, minutes). The key never leaves OpenBao, so there is no key file to replace anywhere.

- A deployment set up before O05: run `configure` once more (a root token, two key holders, section 5) to set the period.
- Check the period: `bao read -field=auto_rotate_period transit/keys/run-contract` (seconds; 7776000 = 90 days), with the admin token inside the OpenBao container.
- Rotate at once by hand (for example after an access review): `bao write -f transit/keys/run-contract/rotate` with a root token.

**Revocation of a leaked or doubtful key version.** The key cannot be exported, so a leak means someone could make OpenBao sign: treat it as a leaked root or worker token first (section 8.2). Then, with a root token:

1. Rotate: `bao write -f transit/keys/run-contract/rotate`. Note the new version: `bao read -field=latest_version transit/keys/run-contract`.
2. Refuse every older version: `bao write transit/keys/run-contract/config min_decryption_version=<new version>`. From now on Transit refuses every signature of an older version, and the runner refuses those contracts (`bad_signature`). A run or an evaluation whose contract was issued before this step does not start; start the intent's run, or the evaluation, again.
3. Record it in the operations log with the old and the new version.

**Check that nothing still uses an old version.** Contracts that have not expired, by key version (read only, as the operator):

```sql
select 'run' as kind, key_version, count(*) from run_contracts where expires_at > now() group by key_version
union all
select 'evaluation', key_version, count(*) from evaluation_run_contracts where expires_at > now() group by key_version
union all
select 'task check', key_version, count(*) from evaluation_task_check_contracts where expires_at > now() group by key_version;
```

After a revocation only the new version may appear. After an automatic rotation older versions disappear within `run.contract_validity_minutes`.

## 9. Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `OpenBao is not reachable` | Container not running | `pnpm compose:core`; `docker compose … logs openbao` |
| `OpenBao is sealed; unseal it first` | Restart | Section 4 |
| `OpenBao is not initialised` | New, empty volume | Section 3. If you expected data, **stop**: you may be on the wrong volume or project |
| `output is not a terminal` | `init` or `root-token` run with output redirected or piped | Run it again in a normal terminal. This is intended |
| `a root token is required` | `configure` got an admin token or an expired token | Section 5 |
| `a root token generation is already in progress` | An earlier `root-token` was interrupted | Inside the container: `BAO_ADDR=http://127.0.0.1:8210 bao delete sys/generate-root/attempt`, then try again |
| `the key share was rejected` | Mistyped or old share | Try again carefully. After a rekey, old shares no longer work |
| A process says `AppRole login failed (HTTP status …)` | Secret ID expired (90 days), destroyed, wrong, or used outside the Compose subnet (the gateway address counts as outside) | Section 8.1; check that the process runs in a container on the Compose network, `SDLC_NETWORK_SUBNET`, `SDLC_NETWORK_GATEWAY` and the secret ID file (section 5c) |
| `curl http://127.0.0.1:8200/…` on the server fails | OpenBao publishes no host port (by design, task A11) | `pnpm openbao:bootstrap status`, or `docker compose … exec openbao bao status` |
| A process says `OpenBao at … is sealed` | Restart. Compose still shows OpenBao as healthy: healthy only means the API answers | Section 4 |
| A process says `OpenBao at … is not initialised` | New, empty volume, or the wrong Compose project | Section 3. If you expected data, **stop** and check the volume |
| A process says `The OpenBao policy of this process does not allow …` | The process asked for a path outside its policy | Correct the path in the process. Change a policy only through `bootstrap/policies/` and `configure` |
| A process says `The certificate of OpenBao at … could not be verified` | A new CA the process has not read yet, an expired server certificate, or an address other than `openbao` | `pnpm openbao:tls check`; after a new CA restart the clients (section 3c). Never turn the check off |
| A process says `… does not use TLS` | An `http://` address | Use `https://openbao:8200` |
| `openbao` does not start; `openbao-tls-init` exited with `… missing in SDLC_OPENBAO_TLS_DIR` | The certificate folder is not set, or a file is missing | Development: `pnpm openbao:tls dev`. Server: section 3c |
| `openbao` stays unhealthy after a renewal | The new certificate is not signed by the CA in `openbao-ca` | `pnpm openbao:tls check`, then `pnpm openbao:tls reload` |
| `no file audit device` | `openbao.hcl` changed | Restore the `audit "file"` block. OpenBao also refuses requests when it cannot write the audit log: check the `openbao-audit` volume (disk full, permissions) |
| `litellm-agent` stays unhealthy; LiteLLM does not start | OpenBao is sealed, the sidecar's secret ID is missing or expired, or the master key or salt key is not stored | Section 4; `pnpm openbao:bootstrap litellm-credentials`; section 5d step 2. `docker compose … logs litellm-agent` shows the reason (never a key) |
| LiteLLM exits with `no rendered configuration (Compose profile models) and no LITELLM_MASTER_KEY` | Started without the profile `models` and without a development master key | On the server: `pnpm compose:models`. On a development machine: set `LITELLM_MASTER_KEY` in `.env` |
| `could not deliver the litellm credentials` | Wrong or expired admin token, or `configure` has not created the AppRole `litellm` yet | Section 5.1; run `configure` again after an upgrade |
| `sdlc-api` restarts with "Cannot read SDLC_OPENBAO_ROLE_ID_FILE" or "no password field" | `api-credentials` was not run, or the volume was removed | Section 5e, step 2 |
| `sdlc-runner` restarts with `runner.start_failed` ("no password field", "Cannot read SDLC_OPENBAO_ROLE_ID_FILE") | `runner-credentials` was not run, or the volume was removed | Section 5g, step 3 |
| The runner logs `runner.evidence_missing`, or High-risk runs fail with `agent_proposal_unavailable` or `agent_proposal_failed`, or runs fail with `agent_changes_unavailable` | `runner-evidence-credentials` was not run, SeaweedFS was reset, or the bucket `evidence` is missing. Or the sandbox's workspace was larger than `SDLC_RUNNER_EXPORT_MAX_MB` (everything, `node_modules` included, default 8192), or its files outside the ignore rules were larger than `SDLC_RUNNER_WORKSPACE_MAX_MB` | Section 5g, step 3b; check that `seaweedfs-init` completed; raise the limit only if the workspace is really that large |
| The API logs `api.evidence_missing`, or `adlc evidence build` / `export` answers `evidence_unavailable` | `api-evidence-credentials` was not run, SeaweedFS was reset, or the API was not restarted after the command | Section 5h |
| `adlc evidence build` answers `evidence_hash_mismatch` or `evidence_missing` | A stored evidence file (a proposal or a diff) was changed or deleted in SeaweedFS after it was recorded. The audit log has an `evidence.check_failed` event | **Treat it as a possible security incident** (handbook Ch.18): do not "fix" the file; tell Person B. SeaweedFS keeps older versions of the bucket `evidence`: the original can be found by its SHA-256 |
| `docker-socket-proxy` stays unhealthy, or the runner says it cannot reach the Docker socket (`EACCES`) | `SDLC_DOCKER_GID` is not the group of the host's Docker socket | Section 5g, step 2; then `pnpm compose:sandbox` again |
| A run fails with `image_unavailable` | `sandbox.image` names a digest the local registry does not have, or the registry is down | Section 5g, sandbox images: push the image again and check the digest |
| A run fails with `image_not_configured` | The agent's adapter is `opencode`, and the project configuration has no `sandbox.images.opencode` | Section 5g, sandbox images: build the OpenCode image and set it |
| A run fails with `adapter_mismatch` | The image for the agent's adapter is built for another adapter (its label `sdlc.agent.adapter`; an image without the label counts as OpenHands). For example `sandbox.images.opencode` names the `node24` image | Section 5g, sandbox images: set the image built for that adapter |
| A run fails with `adapter_unavailable` | The runner does not have the agent's adapter: it is older than the release that added it | Rebuild or pull `sdlc-runner` at the platform's version, then restart it |
| A run fails with `agent_runner_not_attachable` or `agent_model_unreachable` | `SDLC_RUNNER_SELF_CONTAINER` is not the runner's container name, or `SDLC_RUNNER_AGENT_LLM_URL` (`alias:port`) is not in the run's egress list | Check the `sdlc-runner` environment in `platform/deploy/docker-compose.yml` (design/ADR-M29 §2.7) |
| A model is missing in LiteLLM | Its provider has no key in `kv/litellm/providers/`, or LiteLLM was not restarted after the key was stored | Section 5d |
| Compose says the network has a different configuration | `SDLC_NETWORK_SUBNET` or `SDLC_NETWORK_GATEWAY` changed | `pnpm compose:down`, then `pnpm compose:core`. Then run `configure` again (secret IDs are bound to the subnet without the gateway) |
| `the Compose network has no fixed gateway` from `configure` | The network was created before A11 | `pnpm compose:down`, then `pnpm compose:core`, then `configure` again |

## 10. Operations log template

Keep one log per installation. Never write a share, a token or a secret ID in it.

| Date and time (UTC) | Action | People present | Reason | Result | Root token revoked? | Signed |
|---|---|---|---|---|---|---|
| 2026-MM-DD hh:mm | e.g. unseal after restart / root token for configure / secret ID issued (role, accessor) / drill / rekey | | | | yes / n/a | |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | Outline; content written by Claude Code in A03/A10 |
| 0.2 | 2026-09-25 | Claude Code (task A03) | Full content. Sections 3.1, 4, 5, 5b and 8.1 tested on a development machine with throw-away keys (`bootstrap.sh`, live test `pnpm test:openbao`). Sections 6, 7 and 8.2 to be tested in A10. The real initialisation (3.2) is described, not performed |
| 0.3 | 2026-09-25 | Claude Code (task A04) | Section 5c (client settings, credential files, secret ID rotation without restart); tokens bound to the subnet; troubleshooting rows for the client messages; host-port exception (`design/QUESTIONS.md` #27) |
| 0.4 | 2026-09-26 | Claude Code (task A11) | OpenBao publishes no host port: all admin work through `docker compose exec` (section 1); gateway left out of the bound CIDRs and the trust model (section 5b, `design/QUESTIONS.md` #27, #37); `SDLC_OPENBAO_ADDR` in section 5c; troubleshooting rows |
| 0.5 | 2026-09-26 | Claude Code (task B05) | The `worker` AppRole also reads the GitHub App key `kv/shared/github-app` (`design/QUESTIONS.md` #42); section 5b: creating the GitHub App, storing and rotating its key (not yet tested with a real App) |
| 0.6 | 2026-09-26 | Claude Code (task C03) | Section 5d: LiteLLM keys through the OpenBao Agent sidecar (profile `models`), `litellm-credentials`, rotation; AppRole `litellm`; key table; troubleshooting rows (`design/QUESTIONS.md` #1, ADR-M24) |
| 0.7 | 2026-09-27 | Claude Code (task B03) | Section 5e: the API reads the `platform_app` password from `kv/api/database` with the AppRole `api`; `api-credentials`, rotation; key table row; troubleshooting row (`design/QUESTIONS.md` #67, ADR-M26). Tested with throw-away keys (`pnpm test:api`) |
| 0.8 | 2026-09-27 | Claude Code (task C04) | The `runner` AppRole no longer reads `kv/shared/github-app`; the worker hands it each run's token as a single-use response-wrapped token (`design/QUESTIONS.md` #44). Existing installations: run `configure` again to load the new `runner` and `worker` policies |
| 0.9 | 2026-09-27 | Claude Code (task B06) | Section 5b.1: storing the test GitHub App key in the development OpenBao from its file (run by the owner in the macOS Terminal); section 5f: the worker reads `kv/worker/database` and `kv/shared/github-app` with the AppRole `worker`, `worker-credentials`, rotation; key table row |
| 0.10 | 2026-09-27 | Claude Code (task C04, session 3) | Section 5g: the runner reads the `platform_app` password from `kv/runner/database` (`runner-credentials`); `SDLC_DOCKER_GID`; the local registry (127.0.0.1 only, no authentication, images by digest, clean-up); clean-up after a restart; troubleshooting rows (ADR-M25). Tested with throw-away keys (`pnpm test:runner-compose`) |
| 0.11 | 2026-09-27 | Claude Code (task C05) | Troubleshooting row: agent runs that cannot reach the Agent Server or LiteLLM (ADR-M29) |
| 0.12 | 2026-09-27 | Claude Code (task C05, session 2) | Section 5d: a local Ollama model on developer machines only (`kv/litellm/providers/ollama`, field `api_base`; QUESTIONS #78) |
| 0.13 | 2026-09-27 | Claude Code (task C06, session 2a) | Section 5f: `worker-credentials` also delivers the AppRole `cost-controller` (volume `worker-cost-approle`); the worker runs agent runs with it; rotation row |
| 0.14 | 2026-09-30 | Claude Code (test maintenance) | Section 8.1: the credentials commands destroy every other secret ID of the AppRole after the delivery; one process per AppRole; new section 8.3: tokens of an old secret ID stay valid until their TTL, how to revoke the tokens of one AppRole after a leak (`design/QUESTIONS.md` #140). Tested with throw-away keys (`pnpm test:openbao`) |
| 0.15 | 2026-09-27 | Claude Code (task C06, session 2b) | Section 5g step 3b: `runner-evidence-credentials` (write-only SeaweedFS identity `runner-evidence` at `kv/runner/evidence`); rotation and troubleshooting rows (ADR-M33 §2.9). Tested with throw-away keys (`pnpm test:runner-compose`) |
| 0.16 | 2026-10-03 | Claude Code (task C07, PR 1) | Section 5g step 3b: the identity `runner-evidence` also writes run diffs under `evidence/diffs/` (run the command again once after the update); troubleshooting row `agent_changes_unavailable` (ADR-M34 §2.2). Tested with throw-away keys (`pnpm test:runner-compose`) |
| 0.17 | 2026-10-03 | Claude Code (task B13, PR 2) | Section 5e step 5: the first tenant admin with `sdlc ops bootstrap`; the operator commands are `sdlc ops …` (renamed from `sdlc admin …`, ADR-M37 §2.8) |
| 0.18 | 2026-10-03 | Claude Code (task C08, PR 1) | Section 5g step 3b: the identity `runner-evidence` also reads run diffs (`Read:evidence/diffs/*`), which the push applies; run the command again once after the update (ADR-M38 §2.2, QUESTIONS #155). Tested with throw-away keys (`pnpm test:runner-compose`) |
| 0.19 | 2026-10-04 | Claude Code (task E02) | Section 5h: `api-evidence-credentials` (SeaweedFS identity `api-evidence` at `kv/api/evidence`: reads proposals and diffs, reads and writes packs), rotation; troubleshooting rows `evidence_unavailable` and failed hash checks (ADR-M48). Tested with throw-away keys (`pnpm test:openbao`) |
| 0.20 | 2026-10-04 | Claude Code (task E03) | Section 5i: `worker-evidence-credentials` (SeaweedFS identity `worker-evidence` at `kv/worker/evidence`, the same rights as `api-evidence`), rotation (ADR-M49). Tested with throw-away keys (`pnpm test:openbao`) |
| 0.21 | 2026-10-04 | Claude Code (task E05, PR 1) | Section 5j: `worker-purge-credentials` (SeaweedFS identity `worker-purge` at `kv/worker/purge`: delete, bypass, legal hold and lock on the evidence prefixes, list, no read), the GOVERNANCE lock on `evidence`, from `report` to `purge`, archived projects, the manual Langfuse deletion, rotation (ADR-M51) |
| 0.22 | 2026-10-04 | Claude Code (task E05, PR 2) | Section 5k: the daily audit anchor (bucket `audit-anchors`, COMPLIANCE 731 days; `worker-anchor-credentials`: SeaweedFS identity `worker-anchor` at `kv/worker/anchor`), what to do on `worker.audit_anchor_mismatch` and `worker.audit_anchor_unlocked`, rotation (ADR-M51 §2.9). Tested with throw-away keys (`pnpm test:openbao`) |
| 0.23 | 2026-10-04 | Claude Code (task A12) | New section 5l: SeaweedFS admin work only inside the container (`-master=127.0.0.1:9333`), the JWT keys made at each start, a failed start; section 5j: the filer gap is closed (ADR-M52, QUESTIONS #239, #245, #246). Tested with throw-away keys (`pnpm test:seaweedfs`, `pnpm test:openbao`) |
| 0.24 | 2026-10-05 | Claude Code (task E08) | Section 5j: the Langfuse purge in the loop, its log lines, deleting traces by hand (by run tags), `APPLY DELETED MASK`; new section 5m: the worker's Langfuse purge, `kv/worker/langfuse` (the worker's own Langfuse key made in the UI, the ClickHouse user `sdlc_purge`, the SeaweedFS identity `worker-langfuse`), `worker-langfuse-credentials`, turning it on, rotation (ADR-M53) |
| 0.25 | 2026-10-05 | Claude Code (task E07) | Section 3.2 step 1: on the server, start only `openbao`, `postgres` and `seaweedfs` before the initialisation (`up.sh core` fails while `.env` holds no LiteLLM keys; found by `pnpm test:fresh-deploy`). Section 5d: the real API-model run (`pnpm test:agent-api`, QUESTIONS #81); the Anthropic gateway name is `claude-haiku-4-5-20251001` (QUESTIONS #93) |
| 0.26 | 2026-10-06 | Claude Code (coordinator) | Section 5d: the API-model run is needed before M-F; the trial M-E runs with the local Ollama model (QUESTIONS #81) |
| 0.27 | 2026-10-07 | Claude Code (coordinator) | Sections 5b and 5d: the commands that store a secret name each hidden value and end with `stored` or `FAILED`; the master and salt keys made at random inside the container (found while setting up a development machine from scratch, GETTING-STARTED Step 11b) |
| 0.28 | 2026-10-07 | Claude Code (issue #177, PR 2) | New section 4b: upgrading the OpenBao image (a Raft snapshot first on a real server, no going back to an older version after the newer one ran, unseal, secret IDs end at their expiry since 2.7.1). Tested with throw-away keys (`pnpm test:openbao` on 2.7.1) |
| 0.29 | 2026-10-08 | Claude Code (docs fix PR A) | Status line shows the current version; section 5b: the GitHub App permissions as in GETTING-STARTED Step 11, the runner never reads the App key (QUESTIONS #44); section 5j: `ops retention report --tenant <slug>` |
| 0.40 | 2026-10-12 | Claude Code (docs review for v0.2.0) | Sections 3c and 3d are subsections of section 3, like 3.1 and 3.2 (heading level only; the links stay the same) |
| 0.41 | 2026-10-22 | Claude Code (task X03, PR 3) | Section 5g: the OpenCode sandbox image `node24-opencode` and `sandbox.images.opencode`; troubleshooting: `image_not_configured`, `adapter_mismatch`, `adapter_unavailable` (ADR-M88) |
| 0.43 | 2026-10-24 | Claude Code (task X04, PR 3b) | Section 5o: the tools' short-lived logins to `knowledge-db` (database secrets engine, one role per run `kdocs-<run_id>`, the issuer `kdocs_issuer`, `knowledge-issuer-credentials`, revocation by prefix), restart of `sdlc-runner`, building the tool image (ADR-M89 §2.7, QUESTIONS #540) |
| 0.42 | 2026-10-23 | Claude Code (task X04, PR 3a) | New section 5o: the worker's index of project documents in `knowledge-db` (profile `knowledge`), `kv/worker/knowledge-db`, `worker-knowledge-credentials`, rotation, retention and `knowledge.purged` (ADR-M89) |
| 0.43 | 2026-10-24 | Claude Code (task L01, PR 1) | New section 5d.1: the provider entry `vllm` of the self-hosted model (profile `models-local`, ADR-M71); no key, two values that are not secrets |
| 0.45 | 2026-10-29 | Claude Code (task V16) | Section 3.2: `pnpm server:setup` runs the initialisation, the shared secrets and every credentials command in one pass: PGP-encrypted shares by default, the screen and scroll-back cleared after each share, the root token only for `configure`, one admin token; the manual steps stay as the fallback |
| 0.46 | 2026-10-29 | Claude Code (docs, newcomer review) | Section 3.2: heading without "described, not yet done"; the procedure is ready, the company server waits for the key holders and the CA certificate (A10 PR 3) |
| 0.47 | 2026-10-30 | Claude Code (task O03) | Section 6b: operational alerts with `pnpm alerts` (a webhook URL in a file of mode 600, e-mail through `sendmail`, the systemd timer, what to do when an alert comes and when the URL leaks) |
| 0.48 | 2026-10-30 | Claude Code (task O05) | Section 8.1: `rotate-credentials` renews every AppRole secret ID with one admin token; the warning 14 days before. New section 8.4: the signing key rotates by itself every 90 days; revoking a version with `min_decryption_version`; how to check that nothing uses an old version |
| 0.49 | 2026-11-11 | Claude Code (task L01, PR 2) | New section 5d.2: the certificates of the mutual TLS link to vLLM on a separate GPU host (profile `models-remote`, ADR-M71 §4): issue, company CA, renewal, an exposed key |
| 0.44 | 2026-10-24 | Claude Code (task O01, PR 2) | Section 5g step 3: the runner on its own Docker Engine (`SDLC_RUNNER_DOCKER_HOST`, `SDLC_RUNNER_SOURCE_CIDR`, `runner-host.sh restart`; ADR-M91) |
| 0.39 | 2026-10-12 | Claude Code (task V08) | New section 3.1b: the trial stack's key file (the two shares encrypted with a passphrase, `pnpm trial:start`, its limits; never on a server; QUESTIONS #356, #415–#419, ADR-M76) |
| 0.38 | 2026-10-12 | Claude Code (task V09, PR 2) | New section 3d: the team access proxy's certificate (company CA `import`, internal CA `server`, throw-away `dev`, `check`, renewal with `reload` without a restart, the 30-day reminder). Tested with throw-away certificates (`pnpm test:access`, `access-static.test.ts`) |
| 0.37 | 2026-10-12 | Claude Code (task V07, PR 2) | Sections 3c and 4: `pnpm doctor` shows the certificates' end dates and checks the platform after an unseal |
| 0.36 | 2026-10-10 | Claude Code (task U05) | New section 5n: the GitHub App's client secret for the dashboard's GitHub sign-in (`kv/api/github-oauth`, `pnpm openbao:bootstrap api-github-oauth-credentials`), turning sign-in on, rotation, signing everyone out (ADR-M73 §2.2, QUESTIONS #385–#389) |
| 0.35 | 2026-10-09 | Claude Code (task A10, PR 2) | Sections 6 and 7 rewritten: `pnpm backup` (every database, OpenBao's snapshot through the AppRole `backup`, the volumes, the env file and the TLS folder, each encrypted with age to `SDLC_BACKUP_DIR`; QUESTIONS #326–#329), the systemd timer, `pnpm restore` into an empty stack and the drill. Tested with throw-away keys (`pnpm test:backup`) |
| 0.34 | 2026-10-09 | Claude Code (task A10, PR 1) | New section 3c: TLS on 8200 everywhere (QUESTIONS #20, #325), the throw-away CA on development machines, the company CA on the server (`pnpm openbao:tls ca`, `server`), renewal without unsealing (`reload`), the 30-day reminder; section 5c and the troubleshooting rows. Tested with throw-away certificates (`pnpm test:openbao`, `tls.test.ts`) |
| 0.33 | 2026-10-09 | Claude Code (docs review E3) | Readability: AppRole, tidy, TTL and the wrapping token explained at first use; one name for the wrapping token; section 3.2 step 1 and section 5g step 3b split into short items |
| 0.32 | 2026-10-09 | Claude Code (docs review E2) | Sections 5d, 5e, 5f, 5g: on the server every profile starts at once after the migrations (Fresh deployment step 7); the tenant bootstrap is Fresh deployment step 8, not a step of 5e |
| 0.31 | 2026-10-09 | Claude Code (docs review fixes) | Title and scope: the processes' credentials are in this runbook; the filer gap note removed (closed by A12, section 5l); sections 8.2 and 8.3 in order; rotation covers sections 5d–5m; "OpenBao admin" for the operator with the admin token |
| 0.30 | 2026-10-09 | Claude Code (docs review PR C) | Section 3.1: the same first commands as the fresh deployment, and the development notes moved from `platform/deploy/README.md` (configure again, audit log path, subnet and gateway of old stacks, `OPENBAO_HOST_PORT`); section 5b: the GitHub App permissions link to `platform/deploy/README.md` |
