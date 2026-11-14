// Dependency injection tokens. The app injects with `@Inject(TOKEN)` everywhere, so it needs no
// decorator metadata and no SWC transform in tests (ADR-M26 section 2.1).
export const DATABASE = Symbol('PlatformDatabase');
export const REGISTRY = Symbol('Registry');
export const SETTINGS = Symbol('ApiSettings');
export const CLOCK = Symbol('Clock');
export const INTENTS = Symbol('IntentsService');
export const ESCALATIONS = Symbol('EscalationsService');
export const AI_RECORDS = Symbol('AiRecordsService');
export const SPECS = Symbol('SpecsService');
export const PLANS = Symbol('PlansService');
export const MEMORY = Symbol('MemoryService');
export const LESSONS = Symbol('LessonsService');
export const RUNS = Symbol('RunsService');
export const COST = Symbol('CostService');
export const METRICS = Symbol('MetricsService');
export const EVIDENCE = Symbol('EvidenceService');
export const INTENT_SIGNALS = Symbol('IntentWorkflowSignals');
export const SIGN_IN = Symbol('SignInEndpoints');
export const PASSKEYS = Symbol('PasskeyEndpoints');
export const EVALUATIONS = Symbol('EvaluationsService');
export const EVAL_TASKS = Symbol('EvaluationTasksService');
export const ADMIN_STEP_UP = Symbol('AdminStepUp');
