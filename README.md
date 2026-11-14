<div align="center">

```text
    ___                    __  _        _____ ____  __    ______
   /   | ____ ____  ____  / /_(_)____  / ___// __ \/ /   / ____/
  / /| |/ __ `/ _ \/ __ \/ __/ / ___/  \__ \/ / / / /   / /     
 / ___ / /_/ /  __/ / / / /_/ / /__   ___/ / /_/ / /___/ /___   
/_/  |_\__, /\___/_/ /_/\__/_/\___/  /____/_____/_____/\____/   
      /____/                                                    
```

**Human-in-the-Loop AI Software Delivery Platform**  
*Autonomous AI Agents • 8 Quality Gates • Cryptographic Audit Trail • Multi-Agent Sandboxes*

[![Release](https://img.shields.io/badge/release-v0.16.0-blue.svg)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docs: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-docs.md)
[![Node: 24 LTS](https://img.shields.io/badge/node-24%20LTS-brightgreen.svg)](package.json)
[![Trial: Ready](https://img.shields.io/badge/community%20trial-ready-green.svg)](TRIAL.md)

</div>

# Agentic SDLC Framework

**A way to let AI coding agents take part in software delivery without giving up control.** The framework has two parts that work together:

| Part | What it is | For |
|---|---|---|
| **Handbook** (`handbook/`) | Policies, a 6-phase process, 8 gates, roles, templates, checklists and runbooks | People: leadership, PM / BrSE (project manager, bridge system engineer), developers, reviewers, testers |
| **Platform** (`platform/`) | Self-hosted software that **enforces** the handbook: runs AI agents through the 8 gates, keeps evidence and an audit log, and measures tokens and cost | The delivery team, every day |

The handbook says **what must happen and why**. The platform **makes sure it happens**. The design documents (`design/`) connect the two.

Built for small and medium software companies, including those working for Japanese clients. Everything is in plain English, written for non-native readers; the platform's messages go through a catalog, so Vietnamese and Japanese can be added.

**Status (2026-11-14): v0.16.0 is released ([CHANGELOG](CHANGELOG.md)); built, tested, and trial-ready.** The platform supports multiple agent adapters (OpenHands, OpenCode), an isolated MCP tool gateway, a runner on its own rootless Docker Engine or VM, secret scanning and a size limit before review, a dependency check of every agent change, decisions in the dashboard confirmed with a passkey, a guided server set-up (`pnpm server:setup`), operational alerts by webhook or e-mail (`pnpm alerts`), and key rotation (`rotate-credentials`).

---

## Quickstart: try it on one machine

The trial runs the whole platform on your own machine with a fictional sample project. Plan **a few hours to one day** for the set-up; the set-up command itself takes 20 to 40 minutes.

**What you need first:** macOS or Linux with Docker Compose v2.24+, 16 GB of memory (32 GB with a local model), about 30 GB of disk, Node.js 24, pnpm 10, OpenSSL 3, Git, **two GitHub accounts** (Person A asks for a change, Person B reviews it), and a model: Ollama, or an Anthropic API key. Details: [TRIAL.md §1](TRIAL.md#1-what-you-need).

```bash
# 1. Get the latest release and its tools
git clone https://github.com/hoanghainh1188/governed-adlc-fw.git
cd governed-adlc-fw
git checkout v0.16.0
corepack enable && pnpm install

# 2. On GitHub: fork harryforge/pilot-order-inventory, turn on Actions,
#    protect main, add Person B (TRIAL.md §3.1). Then create your GitHub App:
pnpm github-app:create --out ~/secrets/sdlc-trial-app.private-key.pem

# 3. Fill in the settings file (a copy outside the repository), then set up everything
cp platform/deploy/trial/trial-settings.example.yaml ~/trial-settings.yaml
pnpm trial:up --settings ~/trial-settings.yaml

# 4. Check the stack and your login (Person A's config folder from the settings file)
pnpm doctor
XDG_CONFIG_HOME=<Person A's config folder> pnpm adlc doctor
```
Then take the first sample task through the gates: [TRIAL.md §5](TRIAL.md#5-run-the-tasks). The step-by-step guide, with what each step does and how to start the stack again after a reboot: [TRIAL.md](TRIAL.md).

---

## 1. In one sentence

> AI takes part in every stage of software development, but every **intent** (one change to make) passes **8 gates** (G1–G8) with **the right human approvers**, **evidence**, an **audit log that cannot be altered**, and **token and cost measured** per client, project and intent.

![Overview: 6 phases and 8 gates](diagrams/svg/d1-overview-6-phases.svg)

Red: always approved by a person (HITL, human in the loop). Orange: oversight depends on risk. Blue: an automatic policy check. Details: [codes table §4](handbook/00-introduction/05-codes.md).

## 2. Where to start

| You are | Read |
|---|---|
| **Trying the platform** in the community trial | [TRIAL.md](TRIAL.md): what you need, the set-up, three sample tasks, and the report |
| **Leadership** deciding whether to adopt | This page, then handbook Part I: [Ch.1 summary](handbook/01-policy/ch01-executive-summary.md) and [Ch.9 adoption roadmap](handbook/01-policy/ch09-adoption-roadmap.md) |
| **Bringing a project team onto the platform** (tech lead, leadership) | [platform/ROLLOUT-GUIDE.md](platform/ROLLOUT-GUIDE.md): where each role starts, the rollout step by step, the first week, common mistakes |
| **Preparing your application's repository** (Person A, the intent owner, or repo owner) | [ROLLOUT-GUIDE step 1](platform/ROLLOUT-GUIDE.md#step-1-prepare-the-repository-person-a-the-repository-owner-12-days): the two repositories, agent instructions, Spec Kit and BMAD |
| **New to the platform** | [The platform in five minutes](platform/PLATFORM-IN-5-MINUTES.md), then the [tutorial: your first feature](platform/TUTORIAL-FIRST-FEATURE.md). Every guide in one list: [platform/README.md](platform/README.md) |
| **A team member** (Person A: owner/executor; Person B: independent approver; PM / BrSE) | [platform/USER-GUIDE.md](platform/USER-GUIDE.md): one intent from G1 to G8, by role, with CLI commands and troubleshooting |
| **Installing and operating the platform** (operator) | [platform/deploy/README.md](platform/deploy/README.md): deployment, GitHub App, TLS proxy, rootless runner Engine, backup/restore, unseal, upgrade |
| **Working on the platform's code** (not needed to use it) | [CONTRIBUTING.md](CONTRIBUTING.md) and [platform/GETTING-STARTED.md](platform/GETTING-STARTED.md) (dev stack, test GitHub App, live tests) |
| **Releasing the platform** (maintainer) | [RELEASING.md](RELEASING.md): release process, immutable release assets (`images.lock`), SemVer rules |

A word you do not know? The [glossary](handbook/00-introduction/02-glossary.md) explains the terms, and the [codes table](handbook/00-introduction/05-codes.md) explains the codes (G1–G8, L0–L4, HITL, HOTL, AUDIT).

## 3. How it works

**Two repositories.** The platform is installed once on a server and serves many projects. Each project keeps its code in its own GitHub repository; the platform reaches it through a GitHub App, runs agents on a temporary clone inside isolated sandboxes, and opens pull requests there. It never keeps a working copy of your code.

What it does keep: each run's diff, as evidence, for at least 180 days. Tracing (Langfuse) records model prompts and token usage per run.

![Two repositories: the platform and your project](diagrams/svg/d14-two-repositories.svg)

**An intent goes through eight gates.** An intent is one change to make (`INT-2026-0007`). Person A asks for it; Person B, the independent reviewer and approver, reviews and approves what was produced.

| Gate | What happens |
|---|---|
| G1 | Person A describes the change, its risk and data class |
| G2 | A specification with acceptance criteria is linked |
| G3 | A plan specifies which files the agent may change; Person B approves it |
| G4 | The platform validates the agent, tool permissions, and budget |
| G5 | The agent works in an isolated sandbox. Platform checks plan limits, budget, scans for secrets (Gitleaks), and verifies diff review size |
| G6 | The platform pushes the change and waits for CI and security scans |
| G7 | Person B reviews the pull request and merges it |
| G8 | Person B approves the release with the sealed Evidence Pack |

**The oversight of each gate depends on risk.** Low-risk work passes some gates automatically when conditions hold (HOTL, human on the loop) with a **block window** (4 working hours by default). High-risk work lets the agent only write a proposal patch kept as evidence. Critical work never runs an agent.

**People in a "2+N" team:**
- **Person A** (intent owner & executor): Creates intent, writes specs and plans, guides the agent.
- **Person B** (independent approver): Approves plans (G3), reviews and merges PRs (G7), approves releases (G8).
- **Second approver**: Required for sensitive changes (database migrations, payments, personal data, Critical risk).
- **PM / BrSE**: Records client consent for AI usage and handles disclosure notes.
- **N agents**: Autonomous coding workers bound strictly to approved file scopes, budgets, and sandbox constraints.

**What the platform never does:**
- Never let the producer of a change approve it at review (G7) or release (G8).
- Never merge a pull request or deploy to production automatically: people do.
- Never give an agent a real model provider key, direct access to secrets, or push rights to the default branch.
- Never change or delete an audit record.

## 4. System Architecture & Topology

The platform is designed as an **orchestration + policy + cryptographic evidence layer** built on top of existing developer tools and cloud infrastructure, enforcing strict separation between control and execution planes.

### 4.1 System Context & External Positioning (Ecosystem Boundary)

How the platform interfaces with **2+N team members**, external **Git forges / CI**, **LiteLLM model gateways**, and **underlying infrastructure**:

<p align="center">
  <img src="assets/architecture-context.svg" alt="Governed Agentic SDLC System Context & External Positioning" width="100%" />
</p>

| External / Peer Boundary | Protocol / Mechanism | Role & Security Boundary | Handled By |
|---|---|---|---|
| **2+N Human Roles** | HTTPS / WebAuthn, Terminal REST | Person A guides and plans; Person B independently reviews and approves (G3/G7/G8); PM/BrSE manages client AI consent. | `adlc` CLI, Dashboard, GitHub UI |
| **Project Git Repository** | GitHub App, Git refspec push | Temporary clones inside runner; pushes `agent/INT-...` branches with single-use tokens; zero persistent code storage on platform. | `runner`, `git-github` adapter |
| **Actions CI & Scanners** | Checks API & Code Scanning | G6 gate reads CI check runs and security alerts; critical findings trigger mandatory escalation. | `worker`, `git-github` adapter |
| **LiteLLM Model Gateway** | REST / OTLP (OpenTelemetry) | Per-run virtual keys with strict budget ceilings (80% warn, 100% stop); auto-revocation; streaming traces to Langfuse. | `model-litellm` adapter, LiteLLM |
| **Cloud & Local LLMs** | Anthropic / OpenAI / vLLM / Ollama | Models execute code reasoning; never receive long-lived cloud credentials or direct default-branch push rights. | LiteLLM, vLLM, Ollama |
| **OpenBao Transit & Secrets** | Ed25519 Transit Engine, AppRole | Cryptographically signs Run Contracts; provides single-use wrapped tokens for runner operations. | `@sdlc/secrets`, OpenBao |
| **PostgreSQL & SeaweedFS** | TCP / SQL, S3 WORM Object Lock | Append-only audit log with SHA-256 hash chains; sealed Evidence Packs locked for ≥180 days. | `@sdlc/core`, SeaweedFS |

---

### 4.2 Internal Architecture & Component Topology (Inside the Platform)

Inside the platform monorepo (`platform/`), services and packages are organized into **5 clean architectural layers**:

<p align="center">
  <img src="assets/architecture-internal.svg" alt="Governed Agentic SDLC Internal Component & Package Topology" width="100%" />
</p>

1. **Layer 1 – Entrypoints & User Clients (`platform/apps/*`):**
   * **`adlc` CLI:** Interactive CLI for developers and platform operators (`intent`, `plan draft`, `gate status`, `doctor`).
   * **Preact Web Dashboard:** SSR governance portal with GitHub OAuth, server-side sessions, and WebAuthn passkey-confirmed decisions.
   * **GitHub App Poller:** Regular pollers that ingest GitHub issue comments (`/approve G3`, `/kill`), PR reviews, and CI status.
2. **Layer 2 – Control Plane Services (`platform/apps/api` & `worker`):**
   * **`api` (NestJS):** REST API endpoints for user actions, agent registry, intent proposals, and dashboard static file hosting.
   * **`worker` (Temporal):** Stateful G1–G8 orchestrator, HITL/HOTL block window coordinator, database escalation SLA clocks, and retention purge loops.
3. **Layer 3 – Core Governance Modules (`@sdlc/core` & `@sdlc/config`):**
   * **Gate Engine & Policy:** Enforces canonical risk tiers, oversight modes, separation of duties (Rule M21: producer never approves), and dual approval.
   * **Intent & Plan Registry:** Verifies Markdown specs (≥1 acceptance criterion required) and validates path scopes in submitted YAML plans.
   * **Cost Controller:** Issues per-run virtual keys, tracks real-time token spend, and revokes credentials immediately upon completion.
   * **Evidence Builder & Audit Log:** RFC 8785 canonical JSON + SHA-256 tamper-evident hash chains, sealed Evidence Packs, and daily compliance anchors.
4. **Layer 4 – Execution Plane & Isolated Runner (`platform/apps/runner`):**
   * **Runner Daemon:** Operates on the dedicated `sdlc-runner` task queue; verifies Ed25519 Run Contracts; injects plan constraints into agent prompts.
   * **Safety Gates:** Performs pre-G5 Gitleaks secret scanning (fail-closed), checks diff review size limits (40 files / 1500 lines), and checks added dependencies.
   * **Air-Gapped Docker Sandboxes:** Network restricted exclusively to LiteLLM and local package proxy (`verdaccio`); zero host credentials or cloud keys in containers.
5. **Layer 5 – Adapter Plugins & Shared Contracts (`@sdlc/adapters/*`):**
   * Decoupled connectors conforming to `@sdlc/contracts`: `git-github`, `model-litellm`, `evidence-s3`, `agent-openhands`, `agent-opencode`, and `traces-langfuse`.

---

## 5. Supported Capabilities & Matrix

| Area | Supported today (v0.16.0) |
|---|---|
| **Agents** | OpenHands, OpenCode (pluggable via Agent Adapter Kit) |
| **Agent Tools** | MCP Gateway (`agentgateway`) per run with isolated containers (`read_documents`) |
| **Runner Isolation** | Shared Docker Engine or **Independent Rootless Engine / VM** (prevents volume mounting attacks) |
| **Security Gates** | Pre-G5 secret scanning via Gitleaks, diff review size threshold enforcement; before G6, a check of the dependencies an agent adds (licences, install scripts, look-alike names) |
| **Git Hosts** | GitHub (GitLab, Bitbucket designed in Milestone EXT) |
| **Sandboxes** | Node.js / TypeScript (`node24`), network restricted to LiteLLM & package proxy |
| **Models** | Cloud LLMs via LiteLLM; self-hosted local models via vLLM on server GPU |
| **Set-up** | `pnpm server:setup` (a guided fresh deployment on a server), `pnpm trial:up` (a trial on one machine), `adlc admin project apply` (a project and its team from one file) |
| **Operations** | `pnpm doctor` (read-only checks of a deployment, including the last backup, secret ID ages and table sizes), `pnpm alerts` (what changed, to a chat webhook or e-mail, from the server's timer), `pnpm backup` / `pnpm restore` (encrypted with age), the signing key rotating by itself and `rotate-credentials` |
| **Audit & Evidence** | RFC 8785 canonical JSON + SHA-256 tamper-evident hash chain; exportable sealed Evidence Pack |
| **Dashboard** | Preact SPA with GitHub OAuth, server-side sessions and CSRF protection; gate and escalation decisions confirmed with a passkey, the kill switch, intents with their spec, plans and Evidence Packs |

## 6. Technology Stack

| Layer | Choice |
|---|---|
| Platform Services | TypeScript: NestJS (API), Temporal (Workflow Engine), Sandbox Runner, CLI (`adlc`), Dashboard (Preact) |
| Infrastructure | PostgreSQL, Temporal, LiteLLM, Langfuse, SeaweedFS (S3-compatible storage), Valkey, OpenBao (Vault-compatible secrets & transit signing) |
| Runner Security | Rootless Docker Engine / HAProxy relays, Gitleaks, kernel cgroup limits, `NoNewPrivs` |
| Deployment | Docker Compose on self-hosted servers; no mandatory cloud vendor lock-in |
| Licences | Code: [MIT](LICENSE); Documentation: [CC BY 4.0](LICENSE-docs.md). All 3rd-party dependencies permit commercial use ([D-01](design/D-01-build-vs-buy.md)). |

## 7. Repository Layout

```text
.
├── handbook/        # Process handbook: policies (Ch.1–9), playbook (Ch.10–20), templates (T1–T18)
├── platform/
│   ├── apps/        # api, worker, runner, cli, dashboard
│   ├── packages/    # core, contracts, config, messages, secrets, telemetry, adapters/*
│   ├── deploy/      # Docker Compose, OpenBao, SeaweedFS, rootless runner-host set-up
│   ├── tests/       # unit, integration, and end-to-end upgrade tests
│   ├── README.md    # index of platform guides
│   ├── PLATFORM-IN-5-MINUTES.md, TUTORIAL-FIRST-FEATURE.md, USER-GUIDE.md, ROLLOUT-GUIDE.md
├── design/          # Design specifications (D-xx), architectural decisions (ADR-Mxx)
├── diagrams/        # Mermaid sources and SVG diagrams
└── scripts/         # Backlog and validation tools
```

## 8. Key Documents

- [Codes Table](handbook/00-introduction/05-codes.md): Canonical codes (G1–G8, L0–L4, HITL/HOTL, risk tiers)
- [Glossary](handbook/00-introduction/02-glossary.md): Clear definitions for intent, block window, producer, etc.
- [MVP Architecture (D-03)](design/D-03-mvp-architecture.md) & [Data Model (D-05)](design/D-05-data-model.md)
- [Roadmap (ROADMAP.md)](ROADMAP.md) & [Changelog (CHANGELOG.md)](CHANGELOG.md)
- [Operator Deployment Guide](platform/deploy/README.md) & [Rollout Guide](platform/ROLLOUT-GUIDE.md)
- [Security Policy](SECURITY.md) & [Contributing Guidelines](CONTRIBUTING.md)

## 9. Help & Community

- **Questions & Discussions**: [GitHub Discussions](https://github.com/hoanghainh1188/governed-adlc-fw/discussions)
- **Issues & Bug Reports**: [Open an issue](https://github.com/hoanghainh1188/governed-adlc-fw/issues/new/choose) (never include tokens, credentials, or client code).
- **Security Inquiries**: Follow the coordinated disclosure guidelines in [SECURITY.md](SECURITY.md).
- **Operator Runbooks**: [Troubleshooting](platform/deploy/README.md#troubleshooting) & [OpenBao Runbook (T11)](handbook/03-templates/T11-openbao-runbook.md).

## 10. Licence

The code is [MIT](LICENSE). The documentation (`handbook/`, `design/`, `diagrams/`) is [CC BY 4.0](LICENSE-docs.md): reuse it, also commercially, with credit. Both stay open. The components the platform reuses keep their own licences; every one allows commercial use ([build vs buy](design/D-01-build-vs-buy.md)).
