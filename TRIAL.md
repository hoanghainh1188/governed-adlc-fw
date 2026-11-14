# Try the platform: the community trial

The platform is built and tested, but no team has used it on a project yet. **We ask you to try it** on a fictional sample project and tell us what you found. Your report decides what changes next: gates that are too heavy, budgets, rules, messages, the user interface (milestone M-F, `design/D-02-mvp-scope.md` §13.3).

- **What you do:** deploy the platform on your own machine, take a few sample tasks through the 8 gates (G1–G8) with an AI agent, and send a short report as a GitHub issue.
- **What you need:** a machine with Docker, two GitHub accounts (one for the person who asks for the change, one for the person who reviews it), and an AI model: a local one with Ollama, or an API key.
- **What it costs:** your time (about one day to set up, half a day per task, mostly waiting) and, with an API model, a few US dollars of tokens. The platform caps the spend of each task.
- **No real data.** The sample project is fictional. Never use client code or real personal data in the trial.

> **Status (2026-11-14):** the latest release is **v0.15.0** ([CHANGELOG](CHANGELOG.md)). Start the trial from the latest release. The trial does not turn on the dashboard's GitHub sign-in and actions; without them the dashboard only reads, and you decide gates with comments and the CLI. To add them later: [Fresh deployment, step 7](platform/deploy/README.md#7-start-the-platform), the optional dashboard sign-in with GitHub and the dashboard actions.

The full plan behind this page, with every measure and rule: [`design/M-E-TRIAL-PLAN.md`](design/M-E-TRIAL-PLAN.md).

---

## 1. What you need

| Item | Minimum | Notes |
|---|---|---|
| Machine | macOS or Linux with Docker Engine or Docker Desktop, Docker Compose v2.24+ | Windows: use WSL 2 (not tested) |
| Memory | **16 GB** with an API model; **32 GB** with the local model | The platform uses about 3 GB, each agent sandbox up to 2 GB. The local model `gpt-oss:20b` needs about 14 GB more; on a 24 GB machine it swapped |
| Disk | About 30 GB free | Images (about 10 GB), the sandbox image (about 3 GB), the local model (about 13 GB) |
| Tools | Node.js 24, pnpm 10 (`corepack enable`), OpenSSL 3, Git | [Requirements](platform/deploy/README.md#requirements) |
| GitHub | **Two accounts** (Person A and Person B) | See section 2 |
| A model | Ollama with `gpt-oss:20b`, **or** an Anthropic API key with a spend limit | Section 4 |

**What the sandbox protects, and what it does not.** The agent runs in a sandbox with no internet, no secrets and no route to the platform; everything it changes is checked outside the sandbox and a person merges it. Two things stay your job: the platform's runner controls the Docker on your machine, so use a machine whose Docker you accept as exposed (not one with other people's data or a shared Docker); and read the whole change before you approve it, because the agent may have added a package or a file you did not ask for ([threat model](design/ADR-M80-threat-model.md)).

## 2. Who does what (two people)

The platform's main rule is that the person who makes a change never approves it (separation of duties). The trial measures exactly that, so it needs two roles:

| Role | In the trial |
|---|---|
| **Person A** (the intent owner) | Creates the intents, links the specs, writes the plans, approves G1 and G2 |
| **Person B** (the independent reviewer) | Approves the plan (G3), reviews and merges the agent's pull request (G7), approves the release (G8) |

Best: two people. If you are alone, you may use a second GitHub account for Person B, but **say so in the report**: your waiting times then mean something else, and we count them apart. The platform has no single-person mode, and will not get one (`design/QUESTIONS.md` #341).

## 3. Set up

### 3.1. The sample project

1. **Fork** [`harryforge/pilot-order-inventory`](https://github.com/harryforge/pilot-order-inventory) to the account of Person A (or an organisation you own). It is a small order and inventory application (Vue, NestJS, PostgreSQL) with ten task specs in `docs/specs/` (T01–T10).
2. In the fork, turn on **Actions** (forks start with Actions off).
3. Protect `main` (Settings → Branches): require a pull request, **1 approval**, and the status check **`ci-ok`**; no direct pushes. Add Person B as a collaborator with write access.

### 3.2. The platform

1. Clone this repository and check out the latest release (`git checkout v0.15.0`; the [CHANGELOG](CHANGELOG.md) names the latest one). Then `corepack enable` and `pnpm install`. Every release since v0.1.1 publishes its images on GHCR, so a release checkout pulls the platform images and the sandbox image, pinned by digest, instead of building them: faster, and the images you run are the scanned and signed ones ([Verify the published images](platform/deploy/README.md#verify-the-published-images)). Keep the checkout unchanged, or the images are built locally again (`pnpm images mode` says which).
2. Create **your own GitHub App** and install it on your fork only. In a terminal, run `pnpm github-app:create --out ~/secrets/sdlc-trial-app.private-key.pem`, open the local page it prints, press the button and confirm on GitHub; it saves the private key (mode 600) and prints the client ID and the install link ([Create the GitHub App](platform/deploy/README.md#create-the-github-app-operator), option A). By hand instead: option B there. Keep the private key in a file outside every repository, readable only by you (`chmod 600 <file>`).
3. Clone **your fork** somewhere on the machine (the agent's instructions are read from `AGENTS.md` on its `main` branch).
4. Choose a model (section 4). For the local model: `ollama pull gpt-oss:20b` first. For an API model: put the key alone in a file, `chmod 600`.
5. Copy [`platform/deploy/trial/trial-settings.example.yaml`](platform/deploy/trial/trial-settings.example.yaml) to a place **outside the repository**, and fill it in: your fork and its clone, the App's client ID and key file, the model, and Person A and Person B (e-mail, GitHub login and numeric ID, and a config folder each).
6. Run the whole set-up in one command, in a terminal:
   ```bash
   pnpm trial:up --settings ~/trial-settings.yaml
   ```
   First it asks you to choose a **passphrase** (at least 12 characters, typed twice, not shown). Then it follows [Fresh deployment](platform/deploy/README.md#fresh-deployment-operator), steps 2–13, for you, in 20 to 40 minutes: OpenBao with throw-away keys, every credential, the database, the platform (`core models platform sandbox`), the tenant (Person A is its admin), the project with Person A and Person B, the sandbox image (published, or built when the release has none), the agent, the trial settings of [M-E-TRIAL-PLAN §6](design/M-E-TRIAL-PLAN.md#6-project-configuration-for-the-trial) and the AI record (data class `internal`). At the end, Person A and Person B are each logged in, in their own config folder. Run Person B's commands as `XDG_CONFIG_HOME=<Person B's folder> pnpm adlc …`.

   You may also install the command from npm, at the version of your checkout (`npm install -g @hoanghainh/governed-adlc@<version>` from v0.9.0, `agentic-sdlc-cli@<version>` before it, [USER-GUIDE §2](platform/USER-GUIDE.md#install-the-adlc-command)), and write `adlc …` instead of `pnpm adlc …`; the logins are the same.

What `trial:up` refuses and keeps safe:

- It refuses a machine with another stack of the platform (`platform/deploy/.env` or `sdlc_*` volumes), `NODE_ENV=production`, no Docker, too little memory, no OpenSSL 3 as `openssl` (on macOS the default is LibreSSL: [Requirements](platform/deploy/README.md#requirements)), a key file others can read, or an existing login in a config folder. It never removes or overwrites them.
- The OpenBao keys are **throw-away**. The root token is kept in memory only and revoked at the end. The two key shares that unseal OpenBao are kept in the **key file** `trial-openbao-keys.age` next to the env file (`platform/deploy/trial-openbao-keys.age`), encrypted with your passphrase (age, scrypt), mode 600, ignored by Git; they never reach the terminal or a log (`design/QUESTIONS.md` #356, `design/ADR-M76-trial-key-file.md`).
- **After a reboot or `pnpm trial:down`**, start the stack again, in a terminal:
  ```bash
  pnpm trial:start
  ```
  It asks for your passphrase (three tries), unseals OpenBao, applies the database migrations and starts the platform; your intents and logins are kept. When OpenBao is still unsealed it asks nothing. A wrong passphrase unseals nothing.
- **If you forget the passphrase**, nobody can unseal the stack again. Its data is fictional: remove it with `pnpm trial:down --wipe --settings ~/trial-settings.yaml` and run `pnpm trial:up` again; your intents are lost.
- **A trial stack lives at most 90 days.** Its processes' credentials end after 90 days and a trial stack cannot renew them (no root token). `trial:start` warns from day 80; then wipe it and set it up again.
- A trial stack set up before `trial:start` existed has no key file: it works until the next reboot or `trial:down`, then `trial:start` says so; wipe it and set it up again.
- When `trial:up` stops with an error: remove the stack with `--wipe`, fix the cause it names, and run it again.
- `pnpm trial:down` stops the stack and keeps its key file; `--wipe` removes its volumes, its env file, its key file and the two logins, after you type the project name (`sdlc-trial`). It never touches another Compose project.
- In a script (not a terminal), give the passphrase on the first line of standard input with `--passphrase-stdin`; never as an argument or an environment variable (other users of the machine can see both).

The stack is for the trial only. It can never hold client data. For a server, follow [Fresh deployment](platform/deploy/README.md#fresh-deployment-operator) by hand, with real key holders (runbook T11).

**By hand instead (the fallback).** Follow [Fresh deployment](platform/deploy/README.md#fresh-deployment-operator), steps 1–14, with these values:

- tenant: any slug, for example `trial`; project: `pilot`, repository: your fork;
- users: Person A and Person B, each linked to their GitHub account (numeric ID), with the roles `person_a` and `person_b`; the operator (you) is the tenant admin;
- step 11 (the agent): the model of section 4, the instructions file `AGENTS.md` of your fork;
- step 12 (the configuration): add the trial settings of [M-E-TRIAL-PLAN §6](design/M-E-TRIAL-PLAN.md#6-project-configuration-for-the-trial), at least `verification.required_checks: [ci-ok]` and `oversight.hotl_block_window` of 1 working hour;
- step 13 (the AI record): data class `internal` (the project is fictional).

Steps that print or ask for keys, tokens or key shares: run them **yourself, in a terminal**. Never paste their output into a chat tool, an issue or a report.

## 4. Choose a model

With `pnpm trial:up`, choose the model in the settings file (`model.provider`): it stores the key or the Ollama address in OpenBao for you. By hand, follow the links in the table.

| Model | How | Notes |
|---|---|---|
| **Local:** `gpt-oss:20b` with Ollama | `ollama pull gpt-oss:20b` (a local tag, never a `:cloud` model), then store its address in OpenBao: [runbook T11 §5d](handbook/03-templates/T11-openbao-runbook.md#5d-litellm-keys-compose-profile-models), "a local Ollama model". Gateway name `gpt-oss-20b` | No API cost; slower; the quality is not that of an API model. Leave the profile `observability` off on a small machine |
| **API:** Claude Haiku | Store the key at `kv/litellm/providers/anthropic` ([T11 §5d](handbook/03-templates/T11-openbao-runbook.md#5d-litellm-keys-compose-profile-models), step 2). Gateway name `claude-haiku-4-5-20251001` | Set a spend limit at the provider first. The platform caps each task (USD 10 by default) and each run (USD 2) |

Every model call goes through the platform's gateway (LiteLLM); the agent never sees your key.

## 5. Run the tasks

Read [platform/USER-GUIDE.md](platform/USER-GUIDE.md) first: it takes one intent from G1 to G8, step by step, with the commands of each role.

| Order | Task (spec in your fork's `docs/specs/`) | Risk | What should happen |
|---|---|---|---|
| 1 | **T01** Japanese labels on the product list | Low | The full path G1 → G8: the agent writes the change, Person B reviews and merges it, Person B approves the release |
| 2 | **T09** Multiple warehouses | High | The agent only **proposes**: no branch, no pull request. Person A downloads the proposal (`adlc evidence proposal <INT> --output <file>`) and ends the intent (`adlc gate reject G4 <INT> --reason-code other`) |
| 3 | **T10** Delete orders older than 5 years | Critical | The platform **refuses** to run the agent: the intent is `blocked` at G4 |
| More (optional) | T02–T08 | Low, Medium | Each one like T01. Medium risk makes G2 and G3 human decisions |

For each task: create the intent on its own GitHub issue in your fork, link the spec, write the plan file and merge it through a pull request, then let the gates run (USER-GUIDE §3). While you work, keep a short **log** per task: the minutes each step took, whether the agent's change met the spec, and anything that was unclear, slow or broken.

Stop and report at once if you see a `security` escalation, if `adlc audit verify` fails, or if anything looks like real client data.

## 6. Send your report

1. Make the report (counts and codes only; your project, intents, people and repository are not in it):
   ```bash
   pnpm adlc trial report --json > trial-report.json
   ```
   (Or `adlc trial report --json …` with the npm package.)
   A report for the whole tenant needs a tenant admin. After `pnpm trial:up` that is Person A, whose login is in the default config folder: run it as Person A, without Person B's `XDG_CONFIG_HOME`. If you set the platform up by hand, the operator runs it (the first user of `adlc ops bootstrap` is the tenant admin).
   Read the file before you send it.
2. Open an issue in this repository with the template **"Trial report"**: paste the JSON, your log, the model you used, your machine, and the problems you found (one issue per bug is even better: link them).
3. Never paste tokens, keys, `.env` values or client data into an issue. A security problem goes through [SECURITY.md](SECURITY.md), never into a public issue.

Thank you. When enough reports have arrived (for example from three teams), we publish a summary (`design/M-E-REPORT.md`) and adjust gates, budgets and rules from it.

## 7. Help

- Something does not work: first `pnpm doctor` (the stack; the trial uses the default env file `platform/deploy/.env`) and `adlc doctor` (your login): both say what to fix and change nothing ([Doctor](platform/deploy/README.md#doctor-pnpm-doctor)). Then [platform/deploy/README.md, Troubleshooting](platform/deploy/README.md#troubleshooting) and [USER-GUIDE §5](platform/USER-GUIDE.md#5-when-something-goes-wrong).
- A bug: open an issue with the bug template; say that you were in the trial.
- A word or a code you do not know: the [glossary](handbook/00-introduction/02-glossary.md) and the [codes table](handbook/00-introduction/05-codes.md).
