// Shared AuthZ denylist and the legacy Docker AuthZ plugin server (H07, ADR-M105).
export {
  AUTHZ_RULES,
  AUTHZ_RULES_PATH,
  evaluateAuthz,
  evaluateAuthzRaw,
  type AuthzDecision,
  type AuthzRules,
} from './authz-eval.js';
export { startAuthzPlugin, type AuthzPluginOptions } from './server.js';
