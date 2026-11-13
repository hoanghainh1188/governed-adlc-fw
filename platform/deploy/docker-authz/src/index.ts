// Shared AuthZ denylist and the legacy Docker AuthZ plugin server (H07, ADR-M105).
export {
  AUTHZ_RULES,
  AUTHZ_RULES_PATH,
  AUTHZ_RUNTIMES,
  evaluateAuthz,
  evaluateAuthzRaw,
  type AuthzDecision,
  type AuthzOptions,
  type AuthzRules,
} from './authz-eval.js';
export { OPERATOR_HEADER, startAuthzPlugin, type AuthzPluginOptions } from './server.js';
