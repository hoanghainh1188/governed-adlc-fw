// Shape of the project configuration (design/D-05 section 6.1 `project_configs`, D-08 A05).
// `@sdlc/config` parses, validates and hashes it; policy and workflow code only read it.
// Keys are snake_case, exactly as written in the YAML file.

import type {
  AutonomyLevel,
  ChangeFlag,
  DataClass,
  OversightMode,
  ProjectRole,
  ProviderType,
  RiskTier,
  Severity,
} from './codes.js';
import type { EscalationRoute, ResponseLevel, SafeAction } from './escalation.js';
import type { MemoryMode } from './memory.js';

/**
 * How a gate is checked for one risk tier. `POLICY` = automatic policy check with no human
 * decision; allowed at G4 only (codes table §4 "Policy check", design/QUESTIONS.md #6).
 */
/** X11 (ADR-M29 §2.10): `run.context_condensing.mode`. */
export const CONTEXT_CONDENSING_MODES = ['off', 'summarize'] as const;
export type ContextCondensingMode = (typeof CONTEXT_CONDENSING_MODES)[number];

export type GateCheckMode = OversightMode | 'POLICY';

export interface OversightCell {
  readonly mode: GateCheckMode;
  /** HITL: roles that may approve. HOTL / AUDIT: roles notified or sampling. POLICY: empty. */
  readonly roles: readonly ProjectRole[];
  /** Approvals needed from different people, one per listed role when more than one (HITL). */
  readonly approvals: number;
  /** The mode used once a limit is breached; must be HITL (codes table §4, G5 High). */
  readonly on_breach?: OversightMode;
}

export type TierMatrix = Readonly<Record<RiskTier, OversightCell>>;

export interface OversightMatrix {
  readonly G1: TierMatrix;
  readonly G2: TierMatrix;
  readonly G3: TierMatrix;
  readonly G4: TierMatrix;
  readonly G5: TierMatrix;
  readonly G6: TierMatrix;
  readonly G7: TierMatrix;
  readonly G8: { readonly production: TierMatrix; readonly non_production: TierMatrix };
}

/** Wall-clock units run all the time; working units follow the working calendar. */
export type DurationUnit = 'minutes' | 'hours' | 'days' | 'working_hours' | 'working_days';

export interface Duration {
  readonly value: number;
  readonly unit: DurationUnit;
}

/** A resolution deadline: a duration, the end of the working day, or no clock ("next planned work"). */
export type Deadline =
  Duration | { readonly kind: 'end_of_working_day' } | { readonly kind: 'next_planned_work' };

/** Who owns an escalation of one route (handbook Ch.6 §6.4 "Who receives it"). */
export interface EscalationRouting {
  readonly owner_role: ProjectRole;
  /** Null: no backup step; a missed acknowledgement goes straight to governance. */
  readonly backup_role: ProjectRole | null;
}

export interface SlaEntry {
  readonly acknowledge: Duration;
  readonly resolve: Deadline;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface WorkingCalendar {
  /** IANA time zone, for example `Asia/Ho_Chi_Minh`. */
  readonly time_zone: string;
  readonly working_days: readonly Weekday[];
  /** Local times `HH:MM`, start before end. */
  readonly working_hours: { readonly start: string; readonly end: string };
  /** Local dates `YYYY-MM-DD` that are not working days (for example Tết). */
  readonly holidays: readonly string[];
}

/**
 * Security findings at G6 (codes table §4 row G6, design/QUESTIONS.md #19). Findings at or above
 * `min_severity` make G6 use `mode`; findings below it are recorded as evidence only. A critical
 * finding is always at or above the threshold (rule M6 in `@sdlc/config`).
 */
export interface SecurityFindingsPolicy {
  readonly mode: OversightMode;
  readonly min_severity: Severity;
}

export interface ProjectConfig {
  readonly schema_version: 1;
  readonly oversight: {
    readonly matrix: OversightMatrix;
    readonly forced_hitl_g3: { readonly change_flags: readonly ChangeFlag[] };
    readonly dual_approval_g7: {
      readonly change_flags: readonly ChangeFlag[];
      readonly roles: readonly ProjectRole[];
    };
    readonly g6_security_findings: SecurityFindingsPolicy;
    readonly hitl_gate_deadline: Duration;
    readonly hotl_block_window: Duration;
    readonly approval_expiry: Duration;
    /** Escalation raised when a gate passes `hitl_gate_deadline` (FR-12, FR-18; QUESTIONS #90). */
    readonly gate_overdue: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
  };
  readonly autonomy: { readonly max_by_risk: Readonly<Record<RiskTier, AutonomyLevel>> };
  readonly escalation: {
    readonly sla: Readonly<Record<Severity, SlaEntry>>;
    readonly calendar: WorkingCalendar;
    /** Owner and backup role per route (QUESTIONS #74). The last step is always governance. */
    readonly routing: Readonly<Record<EscalationRoute, EscalationRouting>>;
    /** Roles told when an escalation is raised, per severity (handbook Ch.6 §6.4 SLA "Notify"). */
    readonly notify_on_raise: Readonly<Record<Severity, readonly ProjectRole[]>>;
    /** Remind the step's holder when this share of the acknowledge window has passed (#75). */
    readonly reminder_percent: number;
    /** Actions that continue while the intent is frozen (handbook Ch.6 §6.5, QUESTIONS #76). */
    readonly safe_actions: readonly SafeAction[];
  };
  readonly run: {
    readonly g6_ci_retries: number;
    readonly loop_detection: {
      readonly identical_tool_calls_max: number;
      readonly no_progress_window_minutes: number;
    };
    /** Run Contract validity, from issue to sandbox start (QUESTIONS.md #33, ADR-M22). */
    readonly contract_validity_minutes: number;
    /** Tolerated clock difference for the "not yet valid" check only; expiry has none (ADR-M22). */
    readonly contract_clock_skew_seconds: number;
    /** Iteration cap of a run when the task sets none (FR-32, template T13; QUESTIONS.md #13). */
    readonly default_max_iterations: number;
    /** Time cap of a run in minutes when the task sets none (FR-32, template T13; QUESTIONS.md #13). */
    readonly default_max_duration_minutes: number;
    /**
     * The registered agent (its `agent_key`) that runs this project's intents (task C06,
     * QUESTIONS #108). Null: no agent; G4 fails with `agent_not_runnable` until one is set.
     */
    readonly agent_key: string | null;
    /**
     * Run Contracts issued for one G4 decision when each expires before a runner takes it (task
     * C06 session 2, ADR-M33 §2.6). Then the platform stops trying and escalates.
     */
    readonly contract_attempts_max: number;
    /**
     * The escalation raised when a run fails or is lost (ADR-M33 §2.7, D-03 §6 "Stopped →
     * Escalated"). Mandatory rule M20: the response level freezes the intent (`pause` or higher).
     */
    readonly failed_run_escalation: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
    /**
     * The escalation of a G5 breach (task C07, ADR-M34 §2.8): instruction files changed (route
     * `security`), the cost cap, the iteration or time cap, or a stalled run (route `intent`).
     * Mandatory rule M22: the response level freezes the intent (`pause` or higher; QUESTIONS #21).
     */
    readonly g5_breach_escalation: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
    /**
     * The escalation a kill raises at once (task C11, ADR-M42, QUESTIONS #181): route `technical`.
     * Mandatory rule M26: the response level freezes the intent (`pause` or higher).
     */
    readonly kill_escalation: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
    /**
     * H05 (ADR-M95, QUESTIONS #456): the largest change a person must review, generated files left
     * out. Over either limit, or with no measurement, G5 is HITL at every tier.
     */
    readonly review_limits: {
      readonly max_changed_files: number;
      readonly max_changed_lines: number;
    };
    /**
     * X11 (ADR-M29 §2.10, QUESTIONS #551–#554): how an agent's context is condensed in a long run.
     * `summarize`: the OpenHands condenser replaces old events with a summary made by the run's own
     * model. Only for a model with a known context size (rule M35); otherwise the run has none.
     */
    readonly context_condensing: {
      readonly mode: ContextCondensingMode;
      /** Events in the model's view before a condensation (the condenser's `max_size`). */
      readonly max_events: number;
      /** Events kept at the start of the view (the task message). */
      readonly keep_first: number;
      /** Context size in tokens per model (`allowed_models` entries). */
      readonly model_context_tokens: Readonly<Record<string, number>>;
    };
  };
  readonly budget: {
    readonly warn_percent: number;
    readonly stop_percent: number;
    readonly default_intent_usd: number;
    readonly default_run_usd: number;
  };
  readonly model_routing: {
    readonly allowed_provider_types: Readonly<Record<DataClass, readonly ProviderType[]>>;
  };
  /**
   * Days evidence files are kept after the intent ends (D-05 §10.1, D-02 FR-44). Between 180 and
   * 3650 (mandatory rule M31, task E05, ADR-M51, QUESTIONS #236).
   */
  readonly retention: { readonly evidence_retention_days: number };
  readonly github: { readonly poll_interval_seconds: number };
  /** What G6 reads from CI (task C08 PR 2, QUESTIONS #159, ADR-M38 §2.7). */
  readonly verification: {
    /** Check names G6 waits for; empty: every check on the pushed commit. */
    readonly required_checks: readonly string[];
    /** Pending this long after the push → paused at G6, `technical` escalation. */
    readonly ci_timeout_minutes: number;
    /** O06 (ADR-M106): no check at all on the pushed commit → paused after this; ≤ the timeout. */
    readonly ci_missing_minutes: number;
  };
  /**
   * Who may create and read intents through the API (task B03, ADR-M26, QUESTIONS.md #66).
   * Creators may always read. The viewer role never creates (mandatory rule M16).
   */
  readonly access: {
    readonly intent_create_roles: readonly ProjectRole[];
    readonly intent_read_roles: readonly ProjectRole[];
    /**
     * Who may create and update the project AI record (task B12, ADR-M32; D-02 §3, handbook Ch.2
     * §2.3 and §2.5, template T7). The viewer role never writes it (mandatory rule M19).
     */
    readonly ai_record_write_roles: readonly ProjectRole[];
    /** Who may read the project AI record. Writers may always read. */
    readonly ai_record_read_roles: readonly ProjectRole[];
    /**
     * Who may link an intent's spec (task B08, ADR-M39, QUESTIONS #162; D-02 FR-02). The viewer
     * role never links a spec (mandatory rule M23).
     */
    readonly spec_link_roles: readonly ProjectRole[];
    /**
     * Who may submit an intent's plan file (task B09, ADR-M40, QUESTIONS #168; D-08 B09). The
     * submitter is a producer of the plan and never approves G3 (FR-11). The viewer role never
     * submits a plan (mandatory rule M24).
     */
    readonly plan_submit_roles: readonly ProjectRole[];
    /**
     * Who may stop a run with the kill switch (task C11, ADR-M42, QUESTIONS #180; D-02 FR-34).
     * Person A, Person B and governance always may; the viewer never (mandatory rule M25).
     */
    readonly kill_roles: readonly ProjectRole[];
    /**
     * Who may read the cost report of the project or of one of its intents (task E04, ADR-M45,
     * QUESTIONS #196; D-02 FR-53). Tenant admins always may. The viewer never (mandatory rule M28).
     */
    readonly cost_read_roles: readonly ProjectRole[];
    /**
     * Who may read the gate waiting-time metrics of the project (task E06, ADR-M47, QUESTIONS
     * #206; D-02 FR-12). Tenant admins always may. The viewer never (mandatory rule M29).
     */
    readonly metrics_read_roles: readonly ProjectRole[];
    /**
     * Who may build an intent's Evidence Pack, and who may list, show and export it (task E02,
     * ADR-M48, QUESTIONS #218; D-02 FR-40, FR-42). Tenant admins always may. The viewer never
     * (mandatory rule M30): a pack is client-facing evidence and names the approvers.
     */
    readonly evidence_build_roles: readonly ProjectRole[];
    readonly evidence_read_roles: readonly ProjectRole[];
    /**
     * Who may put an intent's evidence on hold, and release the hold (task E05, ADR-M51,
     * QUESTIONS #235): held evidence is never purged. Tenant admins always may. The viewer never
     * (mandatory rule M32).
     */
    readonly evidence_hold_roles: readonly ProjectRole[];
    /**
     * Who may create, change, archive and run evaluation plans (task L05, ADR-M82, QUESTIONS
     * #470). Tenant admins always may. The viewer never (mandatory rule M33).
     */
    readonly eval_roles: readonly ProjectRole[];
    /**
     * Pairs of roles one person may not hold together on the project (task B13, ADR-M37,
     * QUESTIONS #154): a grant that would give someone both roles of a pair is refused. Person A
     * and Person B always stay apart (mandatory rule M21).
     */
    readonly conflicting_roles: readonly (readonly ProjectRole[])[];
  };
  /** Agent register (task C10, ADR-M31). */
  readonly agents: {
    /**
     * Maximum age of an agent's last recertification before the owner is warned (handbook Ch.20
     * §20.8: every 3 months; mandatory rule M18: never more than 3).
     */
    readonly recertification_months: number;
    /**
     * Evaluations as evidence for approvals and recertifications (task L09, ADR-M86 §2.4).
     * `off`: no check; `warn`: accepted with a warning; `required`: refused without a qualifying
     * evaluation.
     */
    readonly evaluation: {
      readonly mode: AgentEvaluationMode;
      /** Distinct tasks with a scored run of the candidate (at least 1). */
      readonly min_tasks: number;
      /** The candidate's resolve rate, between 0 and 1. */
      readonly min_resolve_rate: number;
      /** Days an evaluation stays valid for an approval. */
      readonly approval_max_age_days: number;
      /** Days an evaluation stays valid for a recertification (rule M34: 90 or less). */
      readonly recertification_max_age_days: number;
    };
  };
  /** The index of a project's documents for the tool `read_documents` (X04 PR 3a, ADR-M89 §2.3). */
  readonly knowledge: {
    /** At most this many Markdown files per index. */
    readonly max_files: number;
    /** A larger file fails the index. */
    readonly max_file_bytes: number;
    /** At most this many bytes of Markdown per index. */
    readonly max_total_bytes: number;
    /** At most this many chunks per index. */
    readonly max_chunks: number;
    /** A chunk holds at most this many characters. */
    readonly chunk_chars: number;
    /** Chunks per embedding request. */
    readonly embed_batch: number;
  };
  /** The code index for the tool permission `read_code` (X06, ADR-M108 §2.6). */
  readonly code_index: {
    /** At most this many source files per index; more fails the run. */
    readonly max_files: number;
    /** A larger file is left out of the index and counted. */
    readonly max_file_bytes: number;
    /** At most this many bytes of source per index; more fails the run. */
    readonly max_total_bytes: number;
    /** At most this many symbol rows (definitions and references) per index; more fails the run. */
    readonly max_symbols: number;
    /** A file whose parse takes longer is left out of the index and counted. */
    readonly parse_timeout_ms: number;
  };
  /**
   * Agent memory across runs (task X13, ADR-M74 §2.2, QUESTIONS #574): approved Markdown notes in
   * `.sdlc/memory/` of the repository. `off` by default; rule M36.
   */
  readonly memory: {
    /** `read`: runs read approved memory; `read_propose`: runs also propose changes. */
    readonly mode: MemoryMode;
    /** At most this many memory files are read (1–50). */
    readonly max_files: number;
    /** A file is cut after this many characters (500–8000). */
    readonly max_file_chars: number;
    /** All files together are cut after this many characters (1000–24000). */
    readonly max_total_chars: number;
  };
  /** X08b (ADR-M109 §2.3): lessons are recorded from G8 until this many days after the close. */
  readonly learning: {
    /** 1–90, default 14. */
    readonly lesson_window_days: number;
  };
  /** Register tools (task X04, ADR-M69 §2.2–§2.7, ADR-M87). */
  readonly tools: {
    /** Maximum age of a tool's last recertification before a warning (rule M18: at most 3). */
    readonly recertification_months: number;
    /** The run gateway's cap of calls per tool and run (ADR-M69 §2.7). */
    readonly max_calls_per_run: number;
    /** Limits of each tool container of a run (ADR-M69 §2.4). */
    readonly container_limits: {
      readonly memory_mb: number;
      /** Thousandths of a CPU: 1000 is one CPU. */
      readonly cpu_millis: number;
      readonly pids: number;
    };
    /** The run's MCP gateway (agentgateway, ADR-M87): its image by digest, or null. */
    readonly gateway: { readonly image: string | null };
    /**
     * The cap of a tool's own model key in one run (X04 PR 3b, ADR-M69 §2.4, QUESTIONS #541): the
     * tool embeds its queries with it. Its spend counts for the run.
     */
    readonly model_budget_usd: number;
  };
  /**
   * H02 (ADR-M96 §2.2): dependency checks for libraries added or changed by an agent.
   */
  readonly dependencies: {
    readonly allowed_licenses: readonly string[];
    readonly blocked_packages: readonly string[];
  };
  /**
   * Sandbox images of the project, pinned by digest (QUESTIONS #59, ADR-M25). `image` is the
   * OpenHands image; `images` gives one image per adapter (X03, QUESTIONS #522, #528).
   */
  readonly sandbox: {
    readonly image: string;
    readonly images?: { readonly openhands?: string; readonly opencode?: string };
  };
  /** Evaluation reports (task L06, ADR-M83 §2.3, QUESTIONS #481) and tasks (L07, ADR-M85). */
  readonly evaluation: {
    /** How a task card is drafted from a merged intent (task L07, ADR-M85 §2.4). */
    readonly tasks: {
      /** A file the pull request added or changed that matches one of these is a hidden test. */
      readonly test_globs: readonly string[];
      /** Proposed commands; `{file}` in `fail_to_pass` gives one command per hidden test. */
      readonly commands: {
        readonly fail_to_pass: readonly string[];
        readonly pass_to_pass: readonly string[];
        readonly ci: readonly string[];
      };
    };
    /** Thresholds of the recommendation rules; shares and alpha are numbers between 0 and 1. */
    readonly recommendations: {
      readonly alpha: number;
      readonly min_paired_tasks: number;
      readonly low_ci_first_try_rate: number;
      readonly unstable_gap: number;
      readonly stopped_at_cap_share: number;
    };
  };
}

/** How strictly the agent register checks evaluations (task L09, ADR-M86 §2.4). */
export type AgentEvaluationMode = 'off' | 'warn' | 'required';

declare const validatedConfig: unique symbol;

/**
 * A configuration that passed the schema and the mandatory rules M1–M18. Only `@sdlc/config`
 * produces it (`loadProjectConfig`, `defaultProjectConfig`). Adapters accept this type, so they
 * never see an unchecked configuration and never repeat the checks (ADR-M16 §2.5, ADR-M18 §2.2).
 */
export type ValidatedProjectConfig = ProjectConfig & { readonly [validatedConfig]: true };
