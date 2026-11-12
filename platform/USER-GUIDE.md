# User guide: taking one intent through the platform

For **Person A, Person B, the second approver and PM / BrSE** who use the platform for the first time. It walks one intent (one change to make) from G1 to G8 and points to the handbook for details; the [glossary](../handbook/00-introduction/02-glossary.md) explains the words. Operators who install the platform read [deploy/README.md](deploy/README.md) instead; developers read [GETTING-STARTED.md](GETTING-STARTED.md). To set up a whole team first (people, roles, repository, agent), see [ROLLOUT-GUIDE.md](ROLLOUT-GUIDE.md). New to the platform? Read [the platform in five minutes](PLATFORM-IN-5-MINUTES.md) and follow the [tutorial](TUTORIAL-FIRST-FEATURE.md) first.

Version 0.15, 2026-10-12. Written by Claude Code; kept in line with the platform and the handbook usage sections (Ch.13–15, Ch.18–20). Changes: the version history at the end.

---

## 1. What the platform does for you

You describe a change; an AI agent writes the code in an isolated sandbox; people approve at eight gates; the platform keeps the evidence and the cost.

<a id="who-decides"></a>**Who decides each gate.** This table is the platform's default (project setting `oversight.matrix`; the policy behind it is the handbook [codes table §4](../handbook/00-introduction/05-codes.md#4-eight-gates-g1g8-with-risk-based-oversight)). Other documents link here.

| Gate | Question | Who decides (default) |
|---|---|---|
| G1 Intent, scope, risk | What problem, what scope, what risk? | Person A, at every risk tier |
| G2 Specification | Is the spec complete and clear? | Person A; Person B at High and Critical risk. At Low risk the platform passes it (HOTL) when its condition holds ([acceptance criteria](../handbook/02-playbook/ch19-approval-queues.md#g2-acceptance-criteria)) |
| G3 Plan | Is the plan right? Which files may change? | Person B. At Low risk the platform passes it (HOTL), unless a change flag such as `migration` forces Person B |
| G4 Execution boundary | May the agent run, with which limits? | The platform (policy check) at Low and Medium risk; Person A at High risk. At Critical risk the agent never runs |
| G5 Scope and budget | Did the run stay in the plan and the budget? | The platform; a person decides the escalation when the run broke a limit |
| G6 Verification | Did CI pass? Any security finding? | The platform at Low (sampled afterwards, AUDIT) and Medium (HOTL) risk; Person B at High and Critical risk, and at any risk when a security finding is at or above the threshold (default `high`) or the findings cannot be read |
| G7 Review and merge | Is the pull request good? | Person B, by a **GitHub review**; also the second approver for flagged changes (migration, payment, personal data, production infrastructure, breaking change, safety function) and at Critical risk. Then a person **merges** |
| G8 Release | Release it? | Person B; also the second approver at Critical risk |

Three rules that never change:

- **The producer of a change never approves it** at G7 or G8; the creator still approves G1. Who the producers are: [handbook Ch.15 §15.10.1](../handbook/02-playbook/ch15-p5-release.md#producers).
- **No gate passes by silence.** A gate that waits for you waits until a person with the role decides. HOTL gates pass only when their conditions hold, and you can still block them within the **block window** (4 working hours by default; how it works: [handbook Ch.19 §19.8b](../handbook/02-playbook/ch19-approval-queues.md#block-window)).
- **The platform never merges and never deploys.** People do.

Risk tiers decide how far the agent may go: Low and Medium → it changes code (L2, controlled change); High → it only writes a proposal (L1, execute in sandbox); Critical → it never runs (L0, assist). Details: the handbook [codes table §3](../handbook/00-introduction/05-codes.md#3-risk-tiers).

## 2. Before your first intent

### Install the adlc command

From release v0.9.0 on, the `adlc` command is on npm as **`@hoanghainh/governed-adlc`**. You need Node.js 24 only; no checkout, pnpm or build:

```bash
npm install -g @hoanghainh/governed-adlc
adlc --version
```

- **Use the platform's version.** `adlc --version` prints the release; install the one your platform runs (ask your operator): `npm install -g @hoanghainh/governed-adlc@<version>`, for example `@0.12.0`. To update: the same command with the new version.
- **Before v0.9.0** the package was `agentic-sdlc-cli` and the command `sdlc`. For a platform older than v0.9.0, install `agentic-sdlc-cli@<version>`. To move: `npm uninstall -g agentic-sdlc-cli`, then install the new package. Your login stays: `adlc` reads the old one (`~/.config/sdlc/`) until it saves its own (`~/.config/adlc/`). From v0.10.0 there is no `sdlc` command: write `adlc` in your scripts (v0.9.x installed both, ADR-M100).
- **Trust.** From v0.9.1 on, every version is published by this repository's GitHub Actions from a release tag, with npm provenance (npm shows the commit and the workflow that built it). Version 0.9.0, the first of `@hoanghainh/governed-adlc`, was published by hand, without provenance (the old package `agentic-sdlc-cli`: by hand for 0.1.1, with provenance from v0.2.0 to v0.8.0). The package has no dependencies: everything it needs is in one file, and `THIRD-PARTY-NOTICES` lists the bundled open-source packages.
- **Operator commands.** `adlc ops …` is in the package too, but works only on the platform server, with `SDLC_DB_URL` ([deploy/README.md](deploy/README.md)).
- To remove it: `npm uninstall -g @hoanghainh/governed-adlc`.

**From a checkout (developers).** Run the CLI from a checkout of this repository (Node.js 24, pnpm 10; `corepack enable` once):

```bash
git clone https://github.com/hoanghainh1188/governed-adlc-fw.git
cd governed-adlc-fw
pnpm install && pnpm build
```

Then choose one way to call it:

- **From the repository root, without installing:** `pnpm adlc <command>`, for example `pnpm adlc whoami`. It compiles the CLI first when needed.
- **As `adlc` everywhere, with pnpm:** run `pnpm setup` once (it creates pnpm's global folder and adds it to your shell profile; open a new terminal after it), then link the CLI:

  ```bash
  cd platform/apps/cli
  pnpm link --global
  ```

  `pnpm --filter @sdlc/cli link --global` does not work (pnpm refuses `--filter` here). To remove the link: `pnpm uninstall --global @sdlc/cli`.
- **As `adlc` everywhere, with an alias:** add `alias adlc='node <checkout>/platform/apps/cli/dist/main.js'` to your shell profile.

After a `git pull`, run `pnpm install && pnpm build` again. The examples in this guide write `adlc …`; with the first way, write `pnpm adlc …`.

### Account and login

1. **Account.** A tenant admin (who manages users, projects and roles for your company on the platform) creates your platform user, links your GitHub account (by its numeric ID) and gives you your roles on the project. Ask them; you cannot give roles to yourself.
2. **API token and login.** You get a first API token (`sdlc_pat_…`) from the tenant admin. Keep it in your password manager, never in chat or a ticket.

   The address (`--api-url`) depends on where the platform runs:

   | Where the platform runs | Address | Who tells you |
   |---|---|---|
   | On your own machine (`pnpm trial:up`, a development stack) | `http://127.0.0.1:8090` | Nobody: the default. After `pnpm trial:up` you are already logged in |
   | On the server itself | `http://127.0.0.1:8090` | The operator, if they changed the port |
   | On a team server, from your computer (team access, [deploy/README.md](deploy/README.md#team-access-operator)) | `https://<server name>:8443` | The operator; with a company or test certificate authority also its `ca.pem`: `export NODE_EXTRA_CA_CERTS=<path to ca.pem>` |

   Plain `http://` works only for this machine; every other address is `https://`, and the certificate is always checked: never turn certificate checks off. Without team access, run `adlc` on the server. Comment commands and reviews on GitHub work from anywhere.

   ```bash
   adlc login --api-url http://127.0.0.1:8090
   adlc whoami
   adlc doctor
   adlc token create --name laptop
   ```

   - **Log in:** `adlc login` asks for the API token at a hidden prompt.
   - **Check:** `adlc doctor` checks your login and the API (TLS, your API token and when it ends, your roles, the CLI's version against the API's) and says what to fix. It changes nothing and never prints your token.
   - **Your own token:** the first token a tenant admin issues for you lives at most 7 days. `adlc token create --name laptop` prints a new token of your own once. Log in again with it.
   - **Revoke the first token:** `adlc token list`, then `adlc token revoke --id <ID>`. Details: [handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-adlc-command).
3. **The project AI record** (the client's recorded consent to AI use) must allow the data class of your work (how sensitive its information is). Person A or the PM / BrSE writes it once per project with `adlc ai-record set …` ([handbook Ch.19 §19.8b](../handbook/02-playbook/ch19-approval-queues.md#ai-record)); check it with `adlc ai-record show --project <slug>`. Without it, intents cannot enter G1.

## 3. One intent, step by step

The example is task T01 of the sample repo, Low risk. Where Medium or High risk differs, it says so.

**Lost? Ask the platform.** `adlc help` lists the guides and the commands; after a command that moves an intent, the CLI prints the likely next step, and after a failure, what to do. At any step, `adlc next <INT>` prints where the intent is, who it waits for, why it is held, and what **you** do now: the command or comment to type, or that it waits for someone else. It reads the intent and your roles only and changes nothing; it never tells a producer of a change to approve it.

### Step 1. Create the intent (Person A)

Open a GitHub issue for the change, then:

```bash
adlc intent create --project pilot --title "Japanese labels on the product list" \
  --risk low --data-class internal --issue <issue number>
```

You get a code such as `INT-2026-0007`. The platform posts a status comment on the issue: **submitted, waits at G1**. From now on, every status change appears there.

### Step 2. G1 (Person A)

Check the goal, scope and risk, then approve on the issue:

```text
/approve G1
```

(or `adlc gate approve G1 INT-2026-0007`). Write commands on the **first line of a new comment**; editing a comment never changes a decision.

### Step 3. Link the spec → G2 (Person A, or PM / BrSE)

The spec is a Markdown file **on the default branch** (`main`); the rules: [handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#spec-link):

```bash
adlc spec link INT-2026-0007 --path docs/specs/T01-product-list-japanese-labels.md
```

Or in one step when you create the intent: add `--spec docs/specs/T01-product-list-japanese-labels.md` to `adlc intent create`. If the link is refused, the intent is still created; run `adlc spec link` as above.

- **The spec needs at least one acceptance criterion**, at every risk tier; `adlc spec link` shows the count. How the platform finds them: [handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#g2-acceptance-criteria).
- **Low risk:** the platform passes G2 by itself (HOTL) and says until when it can be blocked (4 working hours by default).
- **Medium:** Person A approves G2. **High and Critical:** Person B approves G2.
- If the spec on `main` changes later, the intent goes back to G2 by itself.

### Step 4. Write and submit the plan → G3 (Person A writes, Person B approves)

1. Write `.sdlc/plans/INT-2026-0007.yaml` (the format: [handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#plan-file); template T13 is not yet aligned with it, so do not copy T13 as is):

   ```yaml
   plan:
     intent_id: INT-2026-0007
   tasks:
     - id: T1
       summary: Show Japanese labels on the product list screen
       allowed_paths: [apps/web/src/features/products/**]
       tools: [file_editor, terminal]
   ```

   - `allowed_paths` are the only files the agent may change.
   - `change_flags`: add one when the change is of that kind. Some flags make G3 a human decision (for example `migration`, `new_service_boundary`); some make G7 need two approvals (for example `migration`, `payment`, `personal_data`). The two lists: [codes table §4](../handbook/00-introduction/05-codes.md#4-eight-gates-g1g8-with-risk-based-oversight).
   - Every field, what the platform refuses, and how the agent reads the task text: [handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#plan-file).
   - From a Spec Kit or BMAD task list, `adlc plan draft` writes the file for you to complete ([§19.8c](../handbook/02-playbook/ch19-approval-queues.md#plan-draft)).
2. Open a pull request with the file, let Person B review it, and merge it into `main`.
3. Submit it: `adlc plan submit INT-2026-0007`.

- **Low risk without flags:** the platform passes G3 (HOTL). **Otherwise:** Person B checks the plan and its change flags, then `/approve G3`. The person who submitted the plan never approves G3.
- If the plan file on `main` changes later, G3 or G4 waits until you submit it again.

### Step 5. G4 and the run (the platform; Person A at High risk)

When G3 is passed and every block window is closed (section 1), the platform checks the agent, the limits and the budget, and starts the run. You see **run started** on the issue.

- **High risk:** Person A approves the run first: `/approve G4`. The agent then writes only a **proposal** (a patch, stored as evidence; nothing is pushed), and the intent pauses. Person A saves the patch with `adlc evidence proposal <INT> --output <file>`, takes it forward as a person (for example a pull request written by a person, or a new intent), then ends the intent with `adlc gate reject G4 <INT> --reason-code other --reason-ref <link>` ([handbook Ch.13 §13.10.4](../handbook/02-playbook/ch13-p3-coding.md#l1-proposal)). The platform starts no new run by itself.
- **Critical risk:** the platform **blocks** the intent; the agent never runs.
- At 80 % of the run's budget a warning comment appears; at 100 % the run stops ([budgets: handbook Ch.13 §13.10.4](../handbook/02-playbook/ch13-p3-coding.md#budgets)).
- To stop a run at any time: `/kill` on the issue, or `adlc run kill INT-2026-0007` (who may, and what happens: [handbook Ch.18 §18.8d](../handbook/02-playbook/ch18-timeouts-rollback-and-containment.md#188d-using-the-platform-the-kill-switch)).

### Step 6. G5 and G6 (the platform)

- **G5** compares the changed files with the plan and the cost with the budget. Outside the plan → back to G3. Over the budget or a stalled agent → paused with an escalation (section 5). Every check: [handbook Ch.13 §13.10.5](../handbook/02-playbook/ch13-p3-coding.md#13105-gate-g5-scope-and-budget).
- The platform then pushes the change to the branch `agent/INT-2026-0007` and **opens the pull request**.
- **G6** waits for CI (`ci-ok` on the sample repo). CI fails → a new run fixes it, up to 2 times by default; then back to G3. Security findings, or High risk → Person B approves G6. Every outcome, the retries and the timeout: [handbook Ch.14 §14.10.2](../handbook/02-playbook/ch14-p4-testing.md#14102-how-g6-reads-ci).

### Step 7. G7: review and merge (Person B; the second approver when flagged)

The issue shows **the pull request waits for review**.

1. Review the pull request on GitHub and submit **Approve** or **Request changes**. (`/approve G7` is refused: approvals are GitHub reviews.)
   - **Request changes** starts a new run: the agent reads **your** review and its line comments, and pushes a new commit. Approve again after it.
2. When the platform posts **ready to merge**, a person who is not a producer **merges** the pull request on GitHub. Merge only then, and only the commit that was approved.
3. The platform posts **merged**; the intent waits at G8.

Merging too early, or by a producer or a bot, stops the intent with a security escalation. Which reviews count, the second approver, and when G7 stops: [handbook Ch.15 §15.10.1](../handbook/02-playbook/ch15-p5-release.md#15101-gate-g7-review-and-merge).

### Step 8. G8: the release (Person B; + second approver at Critical)

The platform builds the **Evidence Pack** (what it holds: [handbook Ch.15 §15.10.2](../handbook/02-playbook/ch15-p5-release.md#15102-the-evidence-pack)) and asks for the release approval (how G8 decides: [§15.10.3](../handbook/02-playbook/ch15-p5-release.md#15103-gate-g8-release)).

```bash
adlc evidence show INT-2026-0007     # what your approval is bound to
adlc evidence export INT-2026-0007 --output INT-2026-0007.md
adlc gate approve G8 INT-2026-0007   # or /approve G8 on the issue
```

The platform seals the pack, records the metrics and closes the intent (status `done`; the comment says **released**). The client's AI disclosure note is in the pack; for a client that has its own format, your approval confirms that the note is ready.

## 4. Quick reference

### Comment commands (first line of a new comment on the issue or pull request)

| Command | Use |
|---|---|
| `/approve G<n>` | Approve the gate the intent waits at (not G7) |
| `/reject G<n> [reason_code] <reason>` | Reject. Ends the intent at G1–G6 and G8; at G7 the intent goes back to G3 |
| `/request-changes G<n> [reason_code] <reason>` | Ask for changes. At G1–G4 and G8 the intent stays at the gate; at G5, G6 (within the block window) and G7 a new run starts after G4 |
| `/ack ESC-…` / `/decide ESC-… <resume\|modify\|roll-back\|terminate\|escalate>` | Escalations (section 5; [handbook Ch.18 §18.8b](../handbook/02-playbook/ch18-timeouts-rollback-and-containment.md#188b-using-the-platform-escalations-ack-and-decide)) |
| `/kill` | Stop the intent's agent run |

Reason codes: `spec_unclear`, `tests_insufficient`, `security_finding`, `out_of_scope`, `policy_denied`, `budget_exceeded`, `ci_failed`, `other` (the full list: `gate_reason_code` in [design D-05 §5](../design/D-05-data-model.md#5-enumerations)). The platform keeps the code and a link to your comment, never your words: write reasons that can stay on GitHub, with no personal or client data.

### CLI commands you will use most

| Command | Use |
|---|---|
| `adlc next <INT>` | What do I do now: the next command or comment for you, or who it waits for |
| `adlc doctor` | Is my login and the API all right, and what do I fix |
| `adlc help [topic\|command]` | Short guides (getting started, roles, gates, comment commands, troubleshooting) and every command with an example; `adlc <command> --help` too |
| `adlc intent list` / `adlc intent show <INT>` | Where is my intent, what waits for whom |
| `adlc gate approve\|reject\|request-changes <G> <INT>` | Decide a gate (codes only; `--reason-code`) |
| `adlc spec link` / `adlc plan submit` | Inputs of G2 and G3 |
| `adlc escalation list` / `show` / `ack` / `decide` | Escalations |
| `adlc run list <INT>` / `adlc run kill <INT>` | Runs, kill switch |
| `adlc cost report --project <slug>` | Tokens and cost |
| `adlc metrics gates --project <slug>` | How long gates wait for people |
| `adlc metrics agents --project <slug>` | How agents and models did: ended well, CI first try, cost per merged intent |
| `adlc evidence build\|list\|show\|export <INT>` | The Evidence Pack |
| `adlc eval plan list\|show\|create\|change\|archive`, `adlc eval run <plan-id>`, `adlc eval list\|show` | Evaluation plans: agents, models and prompt variants measured on a fixed task set ([handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md)) |

Every command takes `--json`. Exit code 0 means done; 4 means log in again with a new API token. The other codes: [handbook Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#exit-codes).

### The dashboard

The dashboard shows intents by gate, escalations, cost and gate waiting times, and evaluation plans. With a GitHub sign-in and actions on, you can also decide a gate (except G7, which is the review and merge on GitHub), kill a run, acknowledge and decide an escalation, create an intent and link its spec, submit a plan, build an Evidence Pack, and act on evaluation plans. The proposal of a High-risk (L1) run is saved with `adlc evidence proposal` only; the page shows the command. Each gate or escalation decision is confirmed with a passkey. Its address: on the platform machine `http://localhost:8090/dashboard/` (write `localhost`, not `127.0.0.1`: the GitHub sign-in needs it); from another machine, through team access, `https://<server name>:8443/dashboard/`. With a GitHub sign-in and actions on, add a **passkey** there within 5 minutes of signing in: the dashboard asks for it before each gate or escalation decision. Where to open it, how to sign in, passkeys and what each screen shows: [handbook Ch.19 §19.8e](../handbook/02-playbook/ch19-approval-queues.md#198e-using-the-platform-the-dashboard).

## 5. When something goes wrong

| You see | What it means | What to do |
|---|---|---|
| **A command fails to reach the API**, or `adlc` says you are not logged in | The login, the API address, a certificate or the API itself | `adlc doctor` names the problem and the fix; a problem on the server goes to the operator (`pnpm doctor`) |
| **Cannot enter G1** (`ai_record_missing`, `data_class_not_allowed`) | The project's AI record is missing or does not allow the data class | Person A or PM / BrSE fixes the record; the intent enters G1 by itself |
| Your command gets a **reply** instead of a status comment | It was refused (wrong gate, no role, you are a producer, bad syntax) | Read the reason, write a new comment |
| **Plan resubmit needed** | The plan file on `main` is not the one you submitted | `adlc plan submit <INT>` again (Person B approves G3 again if it was at G4) |
| **Your intent does not move** | The platform holds it | `adlc next <INT>` says what to do about it; `adlc intent show <INT>` prints "Held: …" with the reason (and for a failed G4 check, which one); the dashboard shows the same under "What holds it" |
| **Back at G2** (spec changed) | Someone edited the spec on `main` | Approve G2 again (passed by itself at Low risk) |
| **Budget warning** | The run used 80 % of its budget | Nothing yet; at 100 % it stops and escalates |
| **An escalation** (ESC-…) | A run or a gate needs a person: over budget, out of scope, overdue gate, CI timeout, early merge… | The escalation owner named in the notice: `/ack ESC-…`, look at the cause, then `/decide ESC-… <decision>`. Who may, and what each decision does: [handbook Ch.18 §18.8b](../handbook/02-playbook/ch18-timeouts-rollback-and-containment.md#188b-using-the-platform-escalations-ack-and-decide) |
| **The gate is overdue** | Nobody decided within 1 working day | Decide the gate; the escalation closes by itself |
| **CI failed** | The agent's change does not pass `ci-ok` | Nothing: a new run tries again (2 times), then the intent goes back to G3 |
| The intent is **paused** | An escalation is open | Decide the escalation |

The work stays frozen while an escalation waits (except safe actions such as stopping a run). Nobody answering never means "go ahead": the escalation moves to the backup owner, then to governance.

## 6. Never

Your habits; what the platform itself never does (merge, deploy, give an agent a real key…) is in [README §3](../README.md#3-how-it-works).

- Approve your own work, or merge a pull request whose change you produced.
- Merge before the platform says **ready to merge**, or push to an `agent/INT-…` branch yourself.
- Put an API token in a command line, chat, ticket or comment.
- Put personal or client data in comments or reasons: the sample repo is public, and the platform's records are kept for years.
- Edit a comment to change a decision: write a new comment.

## 7. Where to read more

| Topic | Handbook |
|---|---|
| Comment commands, HOTL gates, deadlines, the AI record | [Ch.19 §19.8b](../handbook/02-playbook/ch19-approval-queues.md#198b-using-the-platform-gate-commands-in-comments) |
| The `adlc` command, specs, plans, cost and gate reports | [Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-adlc-command) |
| Setting up a team (admins) | [Ch.19 §19.8d](../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins) |
| G4, the run, G5 | [Ch.13 §13.10](../handbook/02-playbook/ch13-p3-coding.md#1310-using-the-platform) |
| The push, the pull request, G6 | [Ch.14 §14.10](../handbook/02-playbook/ch14-p4-testing.md#1410-using-the-platform) |
| G7, the Evidence Pack, G8, retention and holds | [Ch.15 §15.10](../handbook/02-playbook/ch15-p5-release.md#1510-using-the-platform) |
| Escalations, logs, the kill switch, loop detection | [Ch.18 §18.8b–§18.8d](../handbook/02-playbook/ch18-timeouts-rollback-and-containment.md#188b-using-the-platform-escalations-ack-and-decide) |
| Registering and approving agents | [Ch.20 §20.5b](../handbook/02-playbook/ch20-agent-and-model-lifecycle.md#205b-the-agent-register-on-the-platform) |
| The plan file format | [Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#plan-file) (template T13 is not yet aligned with it) |

## Version history

| Version | Date | Notes |
|---|---|---|
| 0.2 | 2026-10-08 | §2: install the `sdlc` command; §4: exit codes |
| 0.3 | 2026-10-09 | Words as in the glossary: intent, API token, block window, the gate short names |
| 0.4 | 2026-10-09 | Docs review PR C: §1 "Who decides each gate" is the one table of the defaults; the second approver at Critical risk at G7; the exit codes, the dashboard and the producers link to their sources |
| 0.5 | 2026-10-09 | Docs review PR C2: steps 3–8 and §4–§6 link to the handbook sections for the spec, the plan, budgets, the kill switch, G5, G6, G7, the Evidence Pack, G8 and escalations; change flags: G3 and G7 have two lists |
| 0.6 | 2026-10-09 | Docs review fixes: the login example, the AI record command, G2 approvers, the plan file format, what reject and request-changes do at each gate |
| 0.7 | 2026-10-09 | Docs review E2: §1 and §7 link to the handbook sections |
| 0.15 | 2026-10-12 | Docs review for v0.2.0: §2 the npm version is the platform's, provenance from v0.2.0 on, the first token lives at most 7 days, one place for the address; §4 the dashboard's address |
| 0.14 | 2026-10-12 | Task U06: §4, passkeys in the dashboard |
| 0.13 | 2026-10-12 | Task V07: `sdlc doctor`, check your login and the API (§2, §4, §5) |
| 0.12 | 2026-10-10 | Task V06: `sdlc next <INT>`, what to do now (§3, §4, §5) |
| 0.11 | 2026-10-10 | Task V05: §2, install the `sdlc` command from npm (`agentic-sdlc-cli`); the checkout ways stay for developers |
| 0.10 | 2026-10-09 | Task C13: step 5, saving an L1 proposal and ending the intent with a G4 rejection |
| 0.9 | 2026-10-09 | Task U03: step 3, `sdlc intent create --spec` links the spec in the same command |
| 0.8 | 2026-10-09 | Docs review E3 (readability): §2 login and token steps as a list; step 4 plan notes as a list; step 5 says how Person A takes an L1 proposal forward; step 8 says `done`; the version history moved here |
