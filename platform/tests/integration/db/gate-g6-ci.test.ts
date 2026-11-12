// D-08 C08 PR 2 AC2 on a live PostgreSQL, without Temporal (design/ADR-M38 §2.7, QUESTIONS #156,
// #157, #158, #159; D-09 N2; D-02 FR-11, FR-12, FR-13, FR-17). The test plays the runner's push
// and fakes what the Git host says about the pull request, its checks and its security findings.
// - CI pending → G6 waits (`ci_pending`, a timer until the CI timeout); a timeout → paused with a
//   `technical` escalation, no retry used; `resume` → G6 reads CI again;
// - CI failed with retries left → a system `fail ci_failed` and back to G4 (`ci_retry`); the next
//   run is told CI failed (#158); no retry left → back to G3, HITL from then on (N2, FR-13);
// - CI passed: HOTL (Medium) → a system `pass` and G7, blockable within the window; a finding at
//   the threshold, or findings unknown (#157) → HITL, Person B approves; a critical finding → a
//   `security` escalation, `resume` → Person B approves;
// - the pull request closed, merged or showing another commit → paused, `technical` escalation;
// - a changed input while paused voids the escalation and G6 reads CI again (FR-17);
// - the poller's `check_completed` event wakes the intent of the pull request.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { loadAgentTask } from '../../../apps/runner/src/agent/task.js';
import {
  GitHostError,
  type CheckItem,
  type PullRequestInfo,
  type RunContract,
  type SecurityFindings,
} from '../../../packages/contracts/src/index.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import { handleGitEvent } from '../../../packages/core/src/commands/git-event-handler.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  closeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import type { G6Deps } from '../../../packages/core/src/workflow/g6-ci.js';
import { finishPublish, type PublishDeps } from '../../../packages/core/src/workflow/publish.js';
import { finishRun, startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import {
  atG4,
  BASE_1,
  HOUR,
  harness,
  MODEL,
  notices,
  Secret,
  T0,
  type Harness,
  waitingFor,
  waitingRow,
} from '../g4-harness.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const DAY = 24 * HOUR;
const MINUTE = 60_000;
const HEAD = 'e'.repeat(40);
const DIFF = 'd'.repeat(64);
const PATHS = 'a'.repeat(64);

interface CiWorld {
  prState: 'open' | 'closed';
  merged: boolean;
  head: string;
  checks: CheckItem[];
  findings: SecurityFindings;
}

const ok = (name = 'ci-ok'): CheckItem => ({
  source: 'check_run',
  id: name,
  name,
  completed: true,
  conclusion: 'success',
});
const failed = (name = 'ci-ok'): CheckItem => ({ ...ok(name), conclusion: 'failure' });
const running = (name = 'ci-ok'): CheckItem => ({
  ...ok(name),
  completed: false,
  conclusion: null,
});
const NONE: SecurityFindings = { known: true, counts: { critical: 0, high: 0, medium: 0, low: 0 } };

describeDb('C08 PR 2: G6 reads CI, on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;
  let ci: CiWorld;
  let publish: PublishDeps;
  let g6: G6Deps;
  let clock = T0;
  let prNumber = 70;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    clock = T0;
    t.setClock(T0);
    Object.assign(t.world, { base: BASE_1, models: [MODEL], gitDown: false, tenantBudget: null });
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
    ci = { prState: 'open', merged: false, head: HEAD, checks: [running()], findings: NONE };
    const pr = (number: number): PullRequestInfo => ({
      number,
      state: ci.prState,
      draft: false,
      merged: ci.merged,
      mergedAt: ci.merged ? T0.toISOString() : null,
      mergeCommitSha: null,
      headSha: ci.head,
      headRef: 'agent/INT-x',
      baseRef: 'main',
      author: { id: '1', login: 'sdlc[bot]', type: 'bot' },
      mergedBy: null,
      changedFiles: 1,
      url: `https://github.com/acme/shop/pull/${String(number)}`,
    });
    publish = {
      registry: t.f.registry,
      gitHost: {
        issueShortLivedToken: (repo, scope) =>
          Promise.resolve({
            token: new Secret('ghs_x'),
            expiresAt: T0.toISOString(),
            repo,
            permissions: scope.permissions,
          }),
        findOpenPullRequest: () => Promise.resolve(null),
        openPullRequest: () => {
          prNumber += 1;
          return Promise.resolve(pr(prNumber));
        },
      },
      wrapper: { wrap: () => Promise.resolve(new Secret('wrap')) },
    };
    g6 = {
      gitHost: {
        getPullRequest: (_ref, number) => Promise.resolve(pr(number)),
        getCheckStatus: (_ref, sha) =>
          Promise.resolve({ sha, state: 'pending', checks: [...ci.checks] }),
        getSecurityFindings: () => Promise.resolve(ci.findings),
      },
    };
  });

  const at = (ms: number) => {
    clock = new Date(T0.getTime() + ms);
    t.setClock(clock);
  };
  const reload = (intent: Intent) => t.reload(intent);
  const step = async (intent: Intent) => {
    for (let i = 0; i < 12; i += 1) {
      const result = await stepIntent(
        t.f.scope,
        { registry: t.f.registry, g4: t.g4, startRuns: true, publish: true, g6 },
        intent.id,
      );
      if (result.outcome !== 'moved') return result;
    }
    throw new Error('the step never settled');
  };
  const g6Decisions = async (intent: Intent) =>
    (await t.f.scope.gateDecisions.listForIntent(intent.id, 'G6')).map((d) => [
      d.decision,
      d.reason_code,
      d.oversight_mode,
    ]);
  const checks = async (intent: Intent) =>
    (await t.f.scope.audit.listForEntity(intent.id, ['gate.g6_check_failed'])).map(
      (e) => (e.payload as { check: string }).check,
    );

  /** One run of the intent to G6: G4 → run → G5 (HOTL pass) → push → the pull request. */
  async function runToCi(intent: Intent): Promise<string> {
    expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.run.runId;
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await t.f.scope.runEvents.append(runId, 'diff_stored', {
      sha256: DIFF,
      size_bytes: 120,
      changed_files: 1,
    });
    await t.f.scope.runEvents.append(runId, 'changes_checked', {
      changed_files: 1,
      out_of_scope: 0,
      instruction_files: 0,
      paths_sha256: PATHS,
    });
    await t.f.scope.runEvents.append(runId, 'secrets_scanned', {
      result: 'clean',
      findings: 0,
      rules: 'built_in',
    });
    // H05: the size a person reviews, within the review limits.
    await t.f.scope.runEvents.append(runId, 'diff_measured', {
      result: 'measured',
      review_files: 1,
      review_lines: 2,
      generated_files: 0,
      generated_lines: 0,
      binary_files: 0,
    });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    expect(await step(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    // G5 passes (HOTL); past its block window: the push and the pull request.
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'hotl_block_window' });
    at(clock.getTime() - T0.getTime() + 3 * DAY);
    expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'push' });
    await t.f.scope.transaction(async (tx) => {
      await tx.runEvents.append(runId, 'branch_pushed', {
        head_sha: HEAD,
        parent_sha: BASE_1,
        diff_sha256: DIFF,
        paths_sha256: PATHS,
      });
      await tx.runs.recordPushedHead(runId, HEAD, new Date());
    });
    // The runner records the push on the database clock; the test runs on the registry clock.
    await tamper(
      db.name,
      `UPDATE run_events SET created_at = $1 WHERE run_id = $2 AND event_type = 'branch_pushed'`,
      [clock, runId],
    );
    if ((await reload(intent)).pr_number === null) {
      expect(await finishPublish(t.f.scope, publish, intent.id, runId)).toMatchObject({ ok: true });
    }
    return runId;
  }

  async function decide(intent: Intent, decision: 'resume' | 'modify' | 'terminate') {
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
    const deps = { now: () => t.f.registry.now() };
    await acknowledgeEscalation(
      t.f.scope,
      { escalationId: escalation.id, actorId: t.f.users.b },
      deps,
    );
    await decideEscalation(
      t.f.scope,
      { escalationId: escalation.id, actorId: t.f.users.b, decision },
      deps,
    );
    return escalation;
  }

  it('pending: waits until the CI timeout; then paused, technical, no retry used; resume reads CI again', async () => {
    const intent = await atG4(t, 'medium');
    const runId = await runToCi(intent);
    const first = await step(intent);
    expect(first).toMatchObject({ outcome: 'waiting', reason: 'ci_pending' });
    expect(await waitingRow(t.f.scope, intent)).toMatchObject({ reason: 'ci_pending' });
    // U01 (#261): waiting for CI, not for a person: nothing certain to show.
    expect(await waitingFor(t, intent)).toBeNull();
    expect((first as { wakeInMs?: number }).wakeInMs).toBeLessThanOrEqual(60 * MINUTE);
    await step(intent); // the same reading: not recorded twice
    const events = (await t.f.scope.runEvents.list(runId)).filter(
      (e) => e.event_type === 'ci_checked',
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.payload)).not.toContain('ci-ok');

    at(clock.getTime() - T0.getTime() + 61 * MINUTE);
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G6' });
    const [escalation] = (await t.f.scope.escalations.listForIntent(intent.id)).slice(-1);
    expect(escalation).toMatchObject({
      route: 'technical',
      packet: { gate: 'G6', subject_kind: 'g6_input', reason_code: 'ci_failed' },
    });
    expect(await checks(intent)).toEqual(['ci_timeout']);
    expect(await g6Decisions(intent)).toEqual([]);

    await decide(intent, 'resume');
    const again = await step(intent);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
    expect(again).toMatchObject({ outcome: 'waiting', reason: 'ci_pending' });
    expect(await notices(t, intent)).toContain('g6_resumed');
  });

  it('no check at all (O06 AC3): waits ci_missing, then paused with the cause ci_missing; a check that appears goes on as pending', async () => {
    ci.checks = [];
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    const first = await step(intent);
    expect(first).toMatchObject({ outcome: 'waiting', reason: 'ci_missing' });
    expect(await waitingRow(t.f.scope, intent)).toMatchObject({ reason: 'ci_missing' });
    // The default ci_missing_minutes (15) is shorter than the CI timeout (60).
    expect((first as { wakeInMs?: number }).wakeInMs).toBeLessThanOrEqual(15 * MINUTE);

    at(clock.getTime() - T0.getTime() + 16 * MINUTE);
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G6' });
    const [escalation] = (await t.f.scope.escalations.listForIntent(intent.id)).slice(-1);
    expect(escalation).toMatchObject({
      route: 'technical',
      packet: { gate: 'G6', subject_kind: 'g6_input', reason_code: 'ci_failed' },
    });
    expect(await checks(intent)).toEqual(['ci_missing']);
    expect(await g6Decisions(intent)).toEqual([]);

    // CI was added: `resume` reads CI again and waits as for any running check.
    ci.checks = [running()];
    await decide(intent, 'resume');
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'ci_pending' });
  });

  it('a check that appears before the ci_missing limit: no stop at 16 minutes', async () => {
    ci.checks = [];
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    expect(await step(intent)).toMatchObject({ reason: 'ci_missing' });
    ci.checks = [running()];
    at(clock.getTime() - T0.getTime() + 16 * MINUTE);
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'ci_pending' });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
  });

  it('a changed input while paused (CI finished) voids the escalation; G6 reads CI again', async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    await step(intent);
    at(clock.getTime() - T0.getTime() + 61 * MINUTE);
    await step(intent);
    ci.checks = [ok()];
    // The paused step reads the database: record the new reading through a step at G6 first.
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
    await closeEscalation(
      t.f.scope,
      { escalationId: escalation.id, closedBy: { type: 'system' } },
      { now: () => t.f.registry.now() },
    );
    await step(intent);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G7' });
  });

  it('CI failed with retries left: fail ci_failed, back to G4; the next run is told CI failed (#158)', async () => {
    const intent = await atG4(t, 'medium');
    const runId = await runToCi(intent);
    ci.checks = [ok('lint'), failed('test')];
    expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await g6Decisions(intent)).toEqual([['fail', 'ci_failed', 'HOTL']]);
    expect(await checks(intent)).toEqual(['ci_failed']);
    expect(await notices(t, intent)).toContain('ci_retry');
    const contract = (await t.f.scope.runContracts.getByRunId(runId))!
      .contract_json as unknown as RunContract;
    const scope = t.f.scope as unknown as Parameters<typeof loadAgentTask>[0];
    expect((await loadAgentTask(scope, contract)).ciFailed).toBe(true);
  });

  it('N2: CI failed and no retry left → back to G3, HITL from then on (FR-13)', async () => {
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n  g6_ci_retries: 0\n`);
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    ci.checks = [failed()];
    expect(await step(intent)).toMatchObject({ outcome: 'waiting' });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
    expect(await checks(intent)).toEqual(['ci_no_retries']);
    expect(await notices(t, intent)).toContain('ci_returned');
    const g3 = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G3');
    expect(g3.map((d) => d.decision)).toContain('void');
  });

  it('CI passed, no finding (Medium, HOTL): a system pass and G7; Person B may still send it back', async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    ci.checks = [ok()];
    expect(await step(intent)).toMatchObject({ outcome: 'waiting' });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G7' });
    expect(await g6Decisions(intent)).toEqual([['pass', null, 'HOTL']]);
    await decideGate(t.f.registry, t.f.scope, {
      intent: await reload(intent),
      gate: 'G6',
      decision: 'request_changes',
      actorId: t.f.users.b,
      reasonCode: 'tests_insufficient',
      source: 'cli',
    });
    expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
  });

  it('a finding at the threshold (high) → HITL: Person B approves, then G7', async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    ci.checks = [ok()];
    ci.findings = { known: true, counts: { critical: 0, high: 1, medium: 0, low: 0 } };
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'g6_decision' });
    expect(await notices(t, intent)).toContain('g6_decision');
    await decideGate(t.f.registry, t.f.scope, {
      intent: await reload(intent),
      gate: 'G6',
      decision: 'approve',
      actorId: t.f.users.b,
      source: 'cli',
    });
    await step(intent);
    expect(await reload(intent)).toMatchObject({ current_gate: 'G7' });
    expect((await g6Decisions(intent)).at(-1)).toEqual(['approve', null, 'HITL']);
  });

  it('findings unknown (#157) → HITL even at Medium', async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    ci.checks = [ok()];
    ci.findings = { known: false, reason: 'not_enabled' };
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'g6_decision' });
    // U01 (#261): the API shows the HITL the workflow waits with.
    expect(await waitingFor(t, intent)).toMatchObject({
      gate: 'G6',
      mode: 'HITL',
      roles: ['person_b'],
    });
  });

  it('a critical finding → paused, a security escalation; resume → Person B approves', async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    ci.checks = [ok()];
    ci.findings = { known: true, counts: { critical: 1, high: 0, medium: 0, low: 0 } };
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
    expect(escalation).toMatchObject({
      route: 'security',
      packet: { reason_code: 'security_finding', subject_kind: 'g6_input' },
    });
    await decide(intent, 'resume');
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'g6_decision' });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
  });

  it.each([
    ['pr_closed', { prState: 'closed' as const }],
    ['pr_merged', { prState: 'closed' as const, merged: true }],
    ['branch_moved', { head: 'f'.repeat(40) }],
  ])('%s → paused with a technical escalation (#156)', async (check, change) => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    Object.assign(ci, { checks: [ok()] }, change);
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    expect(await checks(intent)).toEqual([check]);
    expect((await t.f.scope.escalations.listForIntent(intent.id)).at(-1)).toMatchObject({
      route: 'technical',
    });
  });

  it("a Git host outage: no CI decision (no timeout); a person's rejection is still handled", async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    await step(intent); // a first reading (pending) is recorded
    const read = g6.gitHost.getPullRequest;
    g6.gitHost.getPullRequest = () => Promise.reject(new GitHostError('server_error'));
    try {
      at(clock.getTime() - T0.getTime() + 2 * DAY); // past the CI timeout, but CI cannot be read
      expect(await step(intent)).toEqual({
        outcome: 'waiting',
        reason: 'git_host_unavailable',
        wakeInMs: 60_000,
      });
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);
      await decideGate(t.f.registry, t.f.scope, {
        intent: await reload(intent),
        gate: 'G6',
        decision: 'reject',
        actorId: t.f.users.b,
        reasonCode: 'tests_insufficient',
        source: 'cli',
      });
      expect(await step(intent)).toEqual({ outcome: 'finished', status: 'rejected' });
    } finally {
      g6.gitHost.getPullRequest = read;
    }
  });

  it('the poller: a finished check wakes the intent of the pull request at G6', async () => {
    const intent = await atG4(t, 'medium');
    await runToCi(intent);
    const linked = await reload(intent);
    const handled = await handleGitEvent(
      t.f.scope,
      { registry: t.f.registry, now: () => clock },
      { id: linked.project_id, provider: 'github' },
      {
        kind: 'check_completed',
        id: 'github:check:1',
        source: 'polling',
        repo: { owner: 'acme', name: 'shop' },
        occurredAt: T0.toISOString(),
        url: 'https://github.com/acme/shop/runs/1',
        sha: HEAD,
        prNumbers: [linked.pr_number!],
        checkSource: 'check_run',
        checkId: '1',
        name: 'ci-ok',
        conclusion: 'success',
      },
    );
    expect(handled).toEqual({ outcome: 'not_handled', intentId: intent.id });
  });
});
