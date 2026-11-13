# Roadmap

Generated from the backlog (`scripts/generate-backlog.py`, the same source as [design/D-08](design/D-08-mvp-backlog.md)); do not edit by hand. The platform grows release by release; **v0.1.0 is the baseline**: the whole G1–G8 flow with evidence, audit and token cost ([what it includes](design/MVP-DONE.md)). Each task gets its own plan before it is built, so the order can change. Ideas and questions: [GitHub Discussions](https://github.com/hoanghainh1188/governed-adlc-fw/discussions).

| Milestone | Goal |
|---|---|
| M-E | The trial, run by the community (QUESTIONS #340) |
| UX | Friendlier for users and deployers: v0.1.1, v0.2.0, then v0.3.0 with the agent measures and `sdlc help`; V17 in v0.8.0 (QUESTIONS #355, #364, #420, #424) |
| DEV | Rules as checks for contributors and Claude Code: a rules register, hooks, lint and tests (QUESTIONS #479) |
| EVAL | Evaluation for managers: they plan evaluations, get reports and recommendations to improve agents, prompts and models; on the server and on developer machines. After v0.3.0, before EXT (QUESTIONS #450) |
| EXT | Other Git hosts first, then other agents, tools for agents, document knowledge: v0.6.0, X12 in v0.7.0 (QUESTIONS #361, #420, #424; v0.5.0 has the X09 spike) |
| Models | Self-hosted models: L01 PR 1 and L03 in v0.6.0; then L01 PR 2 and the L03b measurement (QUESTIONS #362, #424) |
| Server | A team on a server: v0.7.0 with O01, O02, H04, H05, V15; v0.8.0 with H02, H03, V16; O03 in v0.10.0; O04, O05 in v0.11.0; toward v1.0 (QUESTIONS #363) |
| Later | Not scheduled yet (was "MVP+1"; U01–U03 were started early there and are done; U07 and U08 are done in v0.8.0) |
| M-F | Adjust gates, budgets and rules from the trial data, then a trial on a real internal tool (D-02 §13.3) |

## M-E: The trial, run by the community (QUESTIONS #340)

- **V01** The trial M-E by the community: a trial guide, a report template, `sdlc trial report` (done, v0.1.0)
- **V02** `pnpm trial:up`: the whole trial set-up on a developer machine in one command (done, v0.1.0)
- **V03** Create the GitHub App from a manifest (done, v0.1.0)

## UX: Friendlier for users and deployers: v0.1.1, v0.2.0, then v0.3.0 with the agent measures and `sdlc help`; V17 in v0.8.0 (QUESTIONS #355, #364, #420, #424)

- **V04** Publish the platform's images to GHCR for each release (done, v0.1.1)
- **V05** Install the `sdlc` command with one command (npm package `agentic-sdlc-cli`) (done, v0.1.1)
- **V06** `sdlc next <INT>`: where an intent is and what to do now (done, v0.1.1)
- **V07** `doctor`: check a deployment and a login, and say what to fix (done, v0.2.0)
- **V08** The trial stack survives a reboot (done, v0.2.0)
- **V09** Team access from other machines (TLS reverse proxy) (done, v0.2.0)
- **V10** A friendlier CLI: `sdlc help`, hints, clearer errors (done, v0.3.0)
- **V11** Plan the dashboard's actions (design only) (done, v0.1.1)
- **U05** Dashboard sign-in with GitHub and server-side sessions (done, v0.2.0)
- **U06** Dashboard writes: CSRF, origin check, passkey step-up (done, v0.2.0)
- **V12** Release process: SemVer, a tag-driven release workflow, upgrade notes (done, v0.2.0)
- **L02** Evaluation harness: agents, models and prompts measured on a fixed task set (data for the GPU decision) (done, v0.3.0)
- **V13** Agent efficiency report from real runs: `sdlc metrics agents` (done, v0.3.0)
- **V17** `sdlc admin project apply`: a project and its team from one file (done, v0.8.0)
- **H01** Threat model for agent runs and attack tests (done, v0.3.0)

## DEV: Rules as checks for contributors and Claude Code: a rules register, hooks, lint and tests (QUESTIONS #479)

- **W01** Rules as checks: a rules register, hooks, lint and tests, a shorter CLAUDE.md (done, v0.5.0)

## EVAL: Evaluation for managers: they plan evaluations, get reports and recommendations to improve agents, prompts and models; on the server and on developer machines. After v0.3.0, before EXT (QUESTIONS #450)

- **L04** Evaluations on the server, one engine for the server and developer machines (done, v0.4.0)
- **L05** Evaluation plans that managers make themselves (done, v0.4.0)
- **L06** Evaluation reports and recommendations for managers (done, v0.5.0)
- **L07** A project's own task set from its merged intents (done, v0.5.0)
- **L08** Design: evaluations in the agent register's approvals (done, v0.5.0)
- **L09** Evaluations in the agent register's approvals (done, v0.5.0)
- **L10** Evaluations in the agent recertification (done, v0.5.0)

## EXT: Other Git hosts first, then other agents, tools for agents, document knowledge: v0.6.0, X12 in v0.7.0 (QUESTIONS #361, #420, #424; v0.5.0 has the X09 spike)

- **X09** Spike: other Git hosts (GitLab, Backlog Git, Bitbucket) (done, v0.5.0)
- **X01** Spike: a second, open-source coding agent (Aider or OpenCode) (done, v0.6.0)
- **X02** Design: a tool register and MCP tools for agents (done, v0.6.0)
- **X03** A second agent adapter and the agent register's adapter column (done, v0.6.0)
- **X14** Spike: an open-source MCP gateway in front of a run's tools (done, v0.6.0)
- **X04** The tool register and the first tool: search the project's documents (done, v0.6.0)
- **X07** A context snapshot for every run (done, v0.6.0)
- **X11** Context condensing for agent runs (done, v0.6.0)
- **X12** Design: agent memory across runs (done, v0.7.0)

## Models: Self-hosted models: L01 PR 1 and L03 in v0.6.0; then L01 PR 2 and the L03b measurement (QUESTIONS #362, #424)

- **L01** A self-hosted model service (vLLM) on an optional GPU host
- **L03** GPU sizing note for leadership (done, v0.6.0)
- **L03b** Measure a 30B-class model on a rented GPU

## Server: A team on a server: v0.7.0 with O01, O02, H04, H05, V15; v0.8.0 with H02, H03, V16; O03 in v0.10.0; O04, O05 in v0.11.0; toward v1.0 (QUESTIONS #363)

- **A10** Resource measurement + backup / restore drill + internal CA / TLS
- **V15** Release on the tag: one workflow builds the images, the lock file is a release asset (done, v0.7.0)
- **V16** `pnpm server:setup`: a guided fresh deployment on a server (steps 2–7) (done, v0.8.0)
- **V18** One command to set up the runner host (done, v0.12.0)
- **V19** `pnpm server:setup` runs steps 8–13 (done, v0.12.0)
- **V20** Team access and the runner link in the `server:setup` settings (done, v0.12.0)
- **H02** Dependencies an agent adds: licence, known vulnerabilities, name checks (done, v0.8.0)
- **H03** Design: deleting a client's data on request (done, v0.8.0)
- **H03a** Client data deletion 1: tenant states and the anonymization of people (done, v0.12.0)
- **H03b** Client data deletion 2: the worker's purge of files, traces and indexes (done, v0.12.0)
- **H03c** Client data deletion 3: the request, the approval and the status commands (done, v0.12.0)
- **H04** A secret scan of a run's diff before G5 (done, v0.7.0)
- **H05** A size bound for a change a person must review (done, v0.7.0)
- **H07** A Docker authorization plugin that checks the body of container requests (done, v0.12.0)
- **O01** The runner in its own VM or with rootless Docker (done, v0.7.0)
- **O02** A tested upgrade between two releases (done, v0.7.0)
- **O03** Operational alerts (done, v0.10.0)
- **O04** Data that only grows: run events, sessions, challenges, partitions (done, v0.11.0)
- **O05** Key rotation: the Run Contract signing key and the processes' secret IDs (done, v0.11.0)

## Later: Not scheduled yet (was "MVP+1"; U01–U03 were started early there and are done; U07 and U08 are done in v0.8.0)

- **U07** Dashboard wave 1: kill a run, gate decisions, escalations (done, v0.8.0)
- **U08** Dashboard wave 2: create an intent with its spec, submit a plan, evidence packs (done, v0.8.0)
- **U09** Dashboard wave 3: administration (done, v0.14.0)
- **V14** Human-effort baseline for the agent report (done, v0.14.0)
- **H06** An optional stronger sandbox runtime (gVisor or Kata) (done, v0.14.0)
- **X05** Documents outside the repository (Office, PDF, Confluence, Drive, Backlog)
- **X06** A code index for agents (Tree-sitter or SCIP and pgvector) (done, v0.14.0)
- **X08** Knowledge for people and the G8 learning loop (design first)
- **X10** An adapter for a second Git host
- **X13** Agent memory
- **O06** Real repositories: very large trees, monorepos, repositories without CI or AGENTS.md (done, v0.13.0)
- **O07** Load test: many intents and tenants at once

Also later, not yet planned as tasks: webhooks instead of polling, a full policy engine (OPA or Cedar), an incident module, break-glass access, automatic rollback, the recertification workflow, client reports, SSO and Kubernetes, several agents in one intent, the deferred approval queue, PQC metrics (D-02 §4.2); PostgreSQL row-level security (D-03 §9, D-05 §8); a support policy for older CLI versions against a newer server (QUESTIONS #440).
