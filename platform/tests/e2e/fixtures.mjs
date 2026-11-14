// Fictional answers of the stub API (U01 smoke test). The intents follow the sample repository's
// tasks (design/D-09 §7); nothing here is real data. Times are relative to now, so the screens
// show realistic waits. Every body must pass the dashboard's zod schemas.
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const hash = (c) => c.repeat(64);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PROJECTS = {
  pilot: { id: uuid(901), slug: 'pilot', repo_full_name: 'harryforge/pilot-order-inventory' },
  shop: { id: uuid(902), slug: 'shop', repo_full_name: 'harryforge/shop-demo' },
};

const ME = {
  user: { id: uuid(1), display_name: 'Demo Person B', email: 'person-b@example.invalid' },
  tenant_id: uuid(900),
  token_id: uuid(800),
  tenant_admin: true,
  roles: [
    { project: { id: PROJECTS.pilot.id, slug: 'pilot' }, role: 'person_b' },
    { project: { id: PROJECTS.shop.id, slug: 'shop' }, role: 'person_a' },
  ],
};

function intent(n, over) {
  return {
    id: uuid(n),
    code: `INT-2026-${String(n).padStart(4, '0')}`,
    project: PROJECTS.pilot,
    title: 'Untitled',
    description: '',
    risk_tier: 'medium',
    data_class: 'internal',
    max_autonomy: 'L2',
    budget_usd: '5.000000',
    status: 'in_gate',
    current_gate: 'G1',
    gate_entered_at: at(-HOUR),
    issue_number: 100 + n,
    pr_number: null,
    created_by: uuid(2),
    created_at: at(-72 * HOUR),
    updated_at: at(-HOUR),
    // U02: what the workflow's step recorded; `decision` is the normal wait for a person.
    waiting_reason: 'decision',
    waiting_cause: null,
    waiting_since: at(-HOUR),
    waiting_until: null,
    ...over,
  };
}

const INTENTS = () => [
  intent(1, {
    title: 'Validate the SKU format when creating a product',
    risk_tier: 'low',
    current_gate: 'G1',
    gate_entered_at: at(-3 * HOUR - 12 * MIN),
  }),
  intent(2, {
    title: 'Filter orders by status',
    risk_tier: 'low',
    current_gate: 'G2',
    gate_entered_at: at(-40 * MIN),
  }),
  intent(3, {
    title: 'Move to multiple warehouses (proposal only)',
    risk_tier: 'high',
    max_autonomy: 'L1',
    current_gate: 'G4',
    gate_entered_at: at(-5 * HOUR),
  }),
  intent(4, {
    waiting_reason: 'g4_check',
    waiting_cause: 'agent_not_active',
    waiting_since: at(-17 * MIN),
    title: 'Export the order list to CSV with a Shift_JIS option',
    current_gate: 'G4',
    gate_entered_at: at(-18 * MIN),
  }),
  intent(5, {
    waiting_reason: 'ci_pending',
    waiting_since: at(-50 * MIN),
    title: 'Low-stock warning based on a threshold',
    current_gate: 'G6',
    gate_entered_at: at(-52 * MIN),
    pr_number: 41,
  }),
  intent(6, {
    title: 'Consumption tax at 10% / 8% and rounding',
    current_gate: 'G7',
    gate_entered_at: at(-26 * HOUR - 5 * MIN),
    pr_number: 38,
  }),
  intent(7, {
    title: 'Add Japanese labels to the product list screen',
    risk_tier: 'low',
    current_gate: 'G8',
    gate_entered_at: at(-2 * HOUR),
    pr_number: 35,
  }),
  intent(8, {
    waiting_reason: 'g5_review',
    waiting_since: at(-4 * HOUR),
    title: 'Cancel an order and return stock',
    status: 'paused',
    current_gate: 'G5',
    gate_entered_at: at(-4 * HOUR),
  }),
  intent(9, {
    waiting_reason: 'input_missing',
    waiting_since: at(-30 * MIN),
    title: 'Pagination for the order API and list screen',
    status: 'draft',
    current_gate: null,
    gate_entered_at: null,
    issue_number: null,
    project: PROJECTS.shop,
  }),
  intent(10, {
    waiting_reason: null,
    waiting_since: null,
    title: 'Delete orders older than 5 years',
    risk_tier: 'critical',
    max_autonomy: 'L0',
    status: 'blocked',
    current_gate: 'G4',
    gate_entered_at: at(-50 * HOUR),
  }),
  intent(11, {
    waiting_reason: null,
    waiting_since: null,
    title: 'Show the order date in Japanese format',
    risk_tier: 'low',
    status: 'done',
    current_gate: null,
    gate_entered_at: null,
    pr_number: 30,
  }),
];

function decision(n, gate, over) {
  return {
    id: uuid(500 + n),
    gate,
    decision: 'approve',
    oversight_mode: 'HITL',
    approver_role: 'person_a',
    actor_type: 'human',
    decided_by: uuid(2),
    reason_code: null,
    reason_ref: null,
    input_sha256: hash('a'),
    scope: null,
    expires_at: at(6 * 24 * HOUR),
    config_hash: hash('c'),
    source: 'github_comment',
    voids_decision_id: null,
    created_at: at(-60 * HOUR + n * HOUR),
    ...over,
  };
}

const WAITING_FOR = {
  G1: { gate: 'G1', mode: 'HITL', roles: ['person_a'], approvals_needed: 1 },
  G2: { gate: 'G2', mode: 'HOTL', roles: ['person_a'], approvals_needed: 0 },
  G4: { gate: 'G4', mode: 'POLICY', roles: [], approvals_needed: 0 },
  G7: { gate: 'G7', mode: 'HITL', roles: ['person_b', 'second_approver'], approvals_needed: 2 },
  G8: { gate: 'G8', mode: 'HITL', roles: ['person_b'], approvals_needed: 1 },
};

function detail(base) {
  const six = base.code === 'INT-2026-0006';
  return {
    ...base,
    description: six
      ? 'Apply 10% or 8% per order line; sum per rate, then round down below 1 yen.\nSee docs/specs/T06.md.'
      : '',
    waiting_for:
      base.status !== 'in_gate'
        ? null
        : base.code === 'INT-2026-0003'
          ? { gate: 'G4', mode: 'HITL', roles: ['person_a'], approvals_needed: 1 }
          : (WAITING_FOR[base.current_gate] ?? null),
    spec: {
      version: 1,
      path: 'docs/specs/T06.md',
      commit_sha: 'b'.repeat(40),
      content_sha256: hash('d'),
      source_tool: 'manual',
      structure: 'manual_heading',
      acceptance_criteria: 3,
    },
    gate_input_sha256: hash('a'),
    plan: { version: 2, plan_sha256: hash('e'), change_flags: six ? ['core_business_rule'] : [] },
    decisions: six
      ? [
          decision(1, 'G1'),
          decision(2, 'G2'),
          decision(3, 'G3', { approver_role: 'person_b', decided_by: uuid(1) }),
          decision(4, 'G4', {
            decision: 'pass',
            oversight_mode: 'POLICY',
            approver_role: null,
            actor_type: 'system',
            decided_by: null,
            source: 'workflow',
            expires_at: null,
          }),
          decision(5, 'G5', {
            decision: 'pass',
            oversight_mode: 'HOTL',
            approver_role: null,
            actor_type: 'system',
            decided_by: null,
            source: 'workflow',
            expires_at: null,
          }),
          decision(6, 'G6', {
            decision: 'pass',
            oversight_mode: 'HOTL',
            approver_role: null,
            actor_type: 'system',
            decided_by: null,
            source: 'workflow',
            expires_at: null,
          }),
          decision(7, 'G7', {
            decision: 'request_changes',
            approver_role: 'person_b',
            reason_code: 'tests_insufficient',
            reason_ref:
              'https://github.com/harryforge/pilot-order-inventory/pull/38#pullrequestreview-1',
            source: 'github_review',
            expires_at: null,
          }),
        ]
      : [decision(1, 'G1')],
  };
}

const RUNS = (code) => ({
  intent: code,
  items:
    code === 'INT-2026-0006'
      ? [
          {
            id: uuid(601),
            attempt: 1,
            status: 'succeeded',
            stop_reason: null,
            agent_version: 'v5',
            iterations: 18,
            killed_by: null,
            created_at: at(-40 * HOUR),
            started_at: at(-40 * HOUR),
            finished_at: at(-39 * HOUR),
          },
          {
            id: uuid(602),
            attempt: 2,
            status: 'succeeded',
            stop_reason: null,
            agent_version: 'v5',
            iterations: 9,
            killed_by: null,
            created_at: at(-28 * HOUR),
            started_at: at(-28 * HOUR),
            finished_at: at(-27 * HOUR - 20 * MIN),
          },
        ]
      : code === 'INT-2026-0003'
        ? [
            // U07: a run in progress, so the page offers the kill switch.
            {
              id: uuid(603),
              attempt: 1,
              status: 'running',
              stop_reason: null,
              agent_version: 'v5',
              iterations: 4,
              killed_by: null,
              created_at: at(-30 * MIN),
              started_at: at(-25 * MIN),
              finished_at: null,
            },
          ]
        : code === 'INT-2026-0010'
          ? [
              // U08: a High-risk (L1) run left a proposal; the page shows the CLI command only.
              {
                id: uuid(604),
                attempt: 1,
                status: 'succeeded_proposal_only',
                stop_reason: null,
                agent_version: 'v5',
                iterations: 6,
                killed_by: null,
                created_at: at(-49 * HOUR),
                started_at: at(-49 * HOUR),
                finished_at: at(-48 * HOUR),
              },
            ]
          : [],
});

/** U08: the stub's writes answer with these. */
export const intentOf = (code) => INTENTS().find((i) => i.code === code);
export const packOf = (code) => PACK(code);

const PACK = (code) => ({
  intent: code,
  id: uuid(701),
  version: 1,
  content_sha256: hash('f'),
  release_sha256: hash('9'),
  manifest: { uri: `s3://evidence/packs/t/${code}/m.json`, sha256: hash('1'), size_bytes: 4210 },
  markdown: { uri: `s3://evidence/packs/t/${code}/pack.md`, sha256: hash('2'), size_bytes: 3180 },
  locale: 'en',
  disclosure_format: 'standard_note',
  item_count: 7,
  built_by: uuid(1),
  built_at: at(-25 * HOUR),
  sealed_at: null,
  retention_hold: false,
  purged_at: null,
});

function escalation(n, intentN, over) {
  const i = intent(intentN, {});
  return {
    id: uuid(300 + n),
    code: `ESC-2026-${String(n).padStart(4, '0')}`,
    intent: { id: i.id, code: i.code },
    run_id: null,
    trigger: 'time',
    route: 'technical',
    severity: 'medium',
    response_level: 'notify',
    status: 'open',
    freezes_intent: false,
    current_step: 'owner',
    owner_id: uuid(1),
    backup_owner_id: uuid(2),
    owner_role: 'person_b',
    backup_role: 'person_a',
    step_role: 'person_b',
    packet: { subject_kind: 'intent', subject_sha256: hash('3') },
    ack_due_at: at(3 * HOUR),
    step_due_at: at(3 * HOUR),
    resolve_due_at: at(24 * HOUR),
    acknowledged_by: null,
    acknowledged_at: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    closed_at: null,
    created_at: at(-2 * HOUR),
    ...over,
  };
}

const ESCALATIONS = () => [
  escalation(4, 6, {
    ack_due_at: at(-2 * HOUR - 10 * MIN),
    step_due_at: at(-70 * MIN),
    current_step: 'backup',
    step_role: 'person_a',
  }),
  escalation(5, 8, {
    trigger: 'out_of_scope',
    route: 'intent',
    severity: 'high',
    response_level: 'pause',
    status: 'acknowledged',
    freezes_intent: true,
    owner_role: 'person_a',
    step_role: 'person_a',
    acknowledged_by: uuid(2),
    acknowledged_at: at(-3 * HOUR),
    resolve_due_at: at(40 * MIN),
  }),
  escalation(6, 5, {
    trigger: 'risky_action',
    route: 'security',
    severity: 'high',
    response_level: 'pause',
    freezes_intent: true,
  }),
];

const amounts = (cost, wasted, calls) => ({
  calls,
  input_tokens: String(calls * 41_200),
  output_tokens: String(calls * 6_900),
  cached_input_tokens: String(calls * 12_000),
  cost_usd: cost,
  wasted_tokens: wasted === '0.000000' ? '0' : String(calls * 9_000),
  wasted_cost_usd: wasted,
});

const COST_ROWS = {
  intent: [
    ['INT-2026-0006', '3.412500', '0.910000', 61],
    ['INT-2026-0005', '1.874200', '0.000000', 33],
    ['INT-2026-0007', '0.620100', '0.000000', 12],
    ['INT-2026-0008', '1.102300', '1.102300', 20],
  ],
  model: [['gpt-oss-20b', '7.009100', '2.012300', 126]],
  status: [
    ['succeeded', '4.996800', '0.000000', 98],
    ['stopped_scope', '1.102300', '1.102300', 20],
    ['failed', '0.910000', '0.910000', 8],
  ],
  project: [
    ['pilot', '7.009100', '2.012300', 126],
    ['shop', '0.000000', '0.000000', 0],
  ],
};

function cost(url) {
  const by = url.searchParams.get('by') ?? 'project';
  const project = url.searchParams.get('project');
  const rows = (COST_ROWS[by] ?? []).map(([key, c, w, calls]) => ({
    key,
    ...amounts(c, w, calls),
  }));
  return {
    report: {
      scope: project ? { kind: 'project', project } : { kind: 'tenant' },
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      group_by: by,
      totals: amounts('7.009100', '2.012300', 126),
      rows,
      truncated: false,
      freshness: {
        latest_call_at: at(-6 * MIN),
        last_recorded_at: at(-4 * MIN),
        runs_in_progress: 1,
      },
    },
  };
}

const stats = (count, avg, p90, max) => ({
  count,
  avg_seconds: avg,
  max_seconds: max,
  p50_seconds: avg,
  p90_seconds: p90,
});
const none = stats(0, null, null, null);

function gates(url) {
  const project = url.searchParams.get('project');
  const row = (gate, first, after, auto, open, oldest) => ({
    project: 'pilot',
    gate,
    first_round: first,
    after_changes: after,
    auto_passed: auto,
    open: { count: open, oldest_seconds: oldest },
  });
  return {
    metrics: {
      scope: project ? { kind: 'project', project } : { kind: 'tenant' },
      from: at(-30 * 24 * HOUR),
      to: at(0),
      as_of: at(0),
      clock: 'wall_clock',
      filters: { gate: null, mode: null, risk: null },
      rows: [
        row('G1', stats(9, 2_400, 7_200, 10_800), none, 0, 1, 11_520),
        row('G2', stats(4, 5_400, 9_000, 9_900), none, 5, 1, 2_400),
        row('G3', stats(8, 14_400, 30_600, 41_000), stats(2, 3_600, 5_000, 5_000), 1, 0, null),
        row('G4', stats(2, 1_800, 3_000, 3_000), none, 7, 2, 18_000),
        row('G6', stats(1, 900, 900, 900), none, 6, 1, 3_120),
        row('G7', stats(6, 61_200, 93_600, 129_600), stats(3, 7_200, 10_800, 10_800), 0, 1, 94_000),
        row('G8', stats(3, 5_400, 7_200, 7_200), none, 0, 1, 7_200),
      ],
      truncated: false,
    },
  };
}

/** U07: an escalation of the fixtures by its code, for the stub's writes. */
export function escalationOf(code) {
  return ESCALATIONS().find((e) => e.code === code);
}

/** The answer for a GET path, or undefined (404). */
export function fixtures(url) {
  const p = url.pathname;
  const all = INTENTS();
  if (p === '/v1/me') return { body: ME };
  if (p === '/v1/intents') {
    const q = url.searchParams;
    const project = q.get('project');
    // X08a PR 2: a stand-in for the API's filters (the database test checks the real search):
    // whole words of the title, the code, the gate and the risk tier.
    const words = (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const match = (i) => {
      const title = i.title.toLowerCase().split(/[^a-z0-9_%/-]+/);
      return words.every((w) => title.includes(w) || i.code.toLowerCase() === w);
    };
    return {
      body: {
        items: all.filter(
          (i) =>
            (!project || i.project.slug === project) &&
            (!q.get('gate') || i.current_gate === q.get('gate')) &&
            (!q.get('risk_tier') || i.risk_tier === q.get('risk_tier')) &&
            match(i),
        ),
        next_cursor: null,
      },
    };
  }
  const m = /^\/v1\/intents\/(INT-2026-[0-9]{4})(\/.*)?$/.exec(p);
  if (m) {
    const base = all.find((i) => i.code === m[1]);
    if (!base) return undefined;
    const rest = m[2] ?? '';
    if (rest === '') return { body: detail(base) };
    if (rest === '/runs') return { body: RUNS(base.code) };
    if (rest === '/evidence-packs')
      return {
        body: { intent: base.code, packs: base.code === 'INT-2026-0006' ? [PACK(base.code)] : [] },
      };
    const file = /^\/evidence-packs\/1\/(manifest|markdown)$/.exec(rest);
    if (file && base.code === 'INT-2026-0006') {
      const md = file[1] === 'markdown';
      const content = md
        ? '# Evidence pack INT-2026-0006\n\nFictional test content.\n'
        : '{"intent":"INT-2026-0006"}';
      return {
        body: {
          file: {
            intent_id: base.id,
            version: 1,
            name: md ? 'pack.md' : 'manifest.json',
            media_type: md ? 'text/markdown' : 'application/json',
            sha256: hash('4'),
            size_bytes: content.length,
            content,
          },
        },
      };
    }
    return undefined;
  }
  if (p === '/v1/escalations') {
    const status = url.searchParams.get('status');
    const intentCode = url.searchParams.get('intent');
    return {
      body: {
        items: ESCALATIONS().filter(
          (e) => (!status || e.status === status) && (!intentCode || e.intent.code === intentCode),
        ),
      },
    };
  }
  if (p === '/v1/cost/report') return { body: cost(url) };
  if (p === '/v1/metrics/gates') return { body: gates(url) };
  if (p === '/v1/admin/audit/verify') {
    return {
      body: { tenant_id: uuid(900), ok: true, checked: 1284, last_seq: 1284, broken: null },
    };
  }
  return undefined;
}
