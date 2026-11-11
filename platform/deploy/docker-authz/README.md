# Docker AuthZ plugin (H07, ADR-M105)

Shared create-body denylist and the legacy Docker authorization plugin for the **runner Engine**.

- Rules: `src/authz-rules.json` + `src/authz-eval.ts` (`evaluateAuthz`)
- Plugin process: `src/server.ts` / `src/main.ts` (`sdlc-docker-authz`)
- Install (rootless): `scripts/install-rootless.sh` (see runbook T11 §5g-1). Socket under `$HOME/.local/share/sdlc-docker-authz/`; `.spec` in `/etc/docker/plugins/` for RootlessKit discovery.

The plugin runs as a **host process**, never as a container on the Engine it guards. Build:

```sh
pnpm exec tsc -b platform/deploy/docker-authz
```
