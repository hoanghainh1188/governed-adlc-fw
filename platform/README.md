# Platform

The code and guides of the [Agentic SDLC Framework](../README.md) platform: the system that runs AI coding agents through the eight gates G1–G8 and keeps the evidence, the audit log and the cost. The platform is structured as a **modular monolith** ([design/D-03](../design/D-03-mvp-architecture.md), ADR-M01).

## Guides

| You want to | Read |
|---|---|
| Understand the platform quickly | [PLATFORM-IN-5-MINUTES.md](PLATFORM-IN-5-MINUTES.md) |
| Follow one feature from idea to release | [TUTORIAL-FIRST-FEATURE.md](TUTORIAL-FIRST-FEATURE.md) |
| Try the platform on your own machine (the community trial) | [TRIAL.md](../TRIAL.md) |
| Use the platform (install `adlc`, log in, take a task through G1–G8) | [USER-GUIDE.md](USER-GUIDE.md) |
| Bring a project team onto the platform | [ROLLOUT-GUIDE.md](ROLLOUT-GUIDE.md) |
| Install, restart, upgrade or remove the platform (operator) | [deploy/README.md](deploy/README.md); [runbook T11](../handbook/03-templates/T11-openbao-runbook.md) (OpenBao) |
| Develop the platform itself | [CONTRIBUTING.md](../CONTRIBUTING.md), [GETTING-STARTED.md](GETTING-STARTED.md), [CLAUDE.md](../CLAUDE.md) |
| Make a release (maintainer) | [RELEASING.md](../RELEASING.md) |

## Layout

```text
platform/
├── apps/             # api (NestJS), worker (Temporal, GitHub poller), runner (sandboxes, agent), cli (adlc), dashboard (Preact SPA with GitHub OAuth & passkey actions), tool-project-docs, tool-code-index
├── packages/         # core, contracts, config, messages, secrets, telemetry, api-schemas, workflow-client, agent-kit
│   └── adapters/     # git-github, agent-openhands, agent-opencode, model-litellm, evidence-s3, policy-simple, traces-langfuse
├── deploy/           # docker-compose.yml and its profiles, OpenBao bootstrap, server-setup, runner-host, scripts
├── sandbox-images/   # the sandbox images per toolchain (node24, node24-opencode)
├── tests/            # unit tests by area; integration/ (database, workflow, pilot scenarios)
├── spikes/           # throw-away experiments (OpenHands, WeKnora) and their results
├── tools/            # eslint-rules/ (module boundaries), release/ (the release gate, image checks), cli-package/ (the npm package build and check)
└── docs-images/      # screenshots used by the guides
```

Details: [design/D-03 §11](../design/D-03-mvp-architecture.md#11-code-layout-in-the-monorepo). The commands (`pnpm build`, `pnpm test`, …) are listed in [CLAUDE.md](../CLAUDE.md), section "Commands".
