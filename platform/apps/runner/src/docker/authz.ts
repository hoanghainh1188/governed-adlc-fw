// Re-export the shared AuthZ denylist (H07, ADR-M105). Source: @sdlc/docker-authz.
export {
  AUTHZ_RULES,
  AUTHZ_RULES_PATH,
  evaluateAuthz,
  evaluateAuthzRaw,
  type AuthzDecision,
  type AuthzRules,
} from '@sdlc/docker-authz';
