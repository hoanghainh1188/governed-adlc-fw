// `pnpm demo:walkthrough` (D-08 V23, issue #561): guided walkthrough against a running demo stack.
// Demonstrates:
//   1. demo-person-a creates a low-risk intent and advances G1 -> G2
//   2. demo-person-a submits an uploaded plan (U10, no GitHub commit required)
//   3. demo-person-a attempts to approve G3 -> REFUSED by Rule M21 (separation of duties)
//   4. demo-person-b approves G3 -> ACCEPTED
//   5. demo-person-b builds and inspects a real Evidence Pack stored in SeaweedFS
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEMO_PROJECT_SLUG } from './demo-config.js';
import type { Sdlc } from './up.js';

export interface WalkthroughDeps {
  readonly repoRoot: string;
  readonly personAConfigHome: string;
  readonly personBConfigHome: string;
  readonly apiUrl: string;
  readonly sdlc: Sdlc;
  readonly log: (line: string) => void;
}

export interface WalkthroughResult {
  readonly intent: string;
  readonly selfApprovalBlocked: boolean;
  readonly evidenceVersion: number;
}

export async function runWalkthrough(deps: WalkthroughDeps): Promise<WalkthroughResult> {
  const planFile = path.join(deps.repoRoot, 'platform/deploy/demo/sample-plan.yaml');
  const asA = (argv: readonly string[]) =>
    deps.sdlc([...argv, '--json'], { XDG_CONFIG_HOME: deps.personAConfigHome });
  const asB = (argv: readonly string[]) =>
    deps.sdlc([...argv, '--json'], { XDG_CONFIG_HOME: deps.personBConfigHome });

  const mustJson = (r: { status: number | null; stdout: string; stderr: string }, step: string) => {
    if (r.status !== 0) {
      throw new Error(`walkthrough step "${step}" failed (exit ${String(r.status)}): ${r.stderr}`);
    }
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };

  // Step 1: demo-person-a creates a low-risk intent.
  deps.log('[1/6] demo-person-a creates a low-risk intent...');
  const created = mustJson(
    await asA([
      'intent',
      'create',
      '--project',
      DEMO_PROJECT_SLUG,
      '--risk',
      'low',
      '--data-class',
      'internal',
      '--title',
      'Demo: Fix tax rounding in order total',
    ]),
    'intent create',
  );
  const intent =
    typeof created.code === 'string'
      ? created.code
      : typeof created.id === 'string'
        ? created.id
        : 'INT-1';
  deps.log(`      Created intent: ${intent}`);

  // Step 2: Advance G1 and G2.
  deps.log(`[2/6] demo-person-a approves G1 and G2 for ${intent}...`);
  mustJson(await asA(['gate', 'approve', 'G1', intent]), 'gate approve G1');
  mustJson(await asA(['gate', 'approve', 'G2', intent]), 'gate approve G2');

  // Step 3: demo-person-a submits the uploaded plan (U10, no GitHub commit needed).
  deps.log(`[3/6] demo-person-a submits uploaded plan (${path.basename(planFile)})...`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-demo-plan-'));
  try {
    const renderedPlan = fs
      .readFileSync(planFile, 'utf8')
      .replace(/^(\s*intent_id:\s*).*$/m, `$1${intent}`);
    const tempPlanFile = path.join(work, 'plan.yaml');
    fs.writeFileSync(tempPlanFile, renderedPlan);
    mustJson(await asA(['plan', 'submit', intent, '--file', tempPlanFile]), 'plan submit --file');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Step 4: Rule M21 check — demo-person-a tries to approve their own plan at G3 (must fail).
  deps.log(`[4/6] Separation of Duties (Rule M21): demo-person-a attempts to approve G3...`);
  const selfApprove = await asA(['gate', 'approve', 'G3', intent]);
  const selfApprovalBlocked = selfApprove.status !== 0;
  if (!selfApprovalBlocked) {
    throw new Error('Expected Rule M21 to refuse self-approval of G3 by demo-person-a');
  }
  deps.log('      REFUSED as expected (producer cannot approve their own plan at G3).');

  // Step 5: demo-person-b approves G3.
  deps.log(`[5/6] Switching to demo-person-b to approve G3 for ${intent}...`);
  mustJson(await asB(['gate', 'approve', 'G3', intent]), 'gate approve G3 (person B)');
  deps.log('      APPROVED by demo-person-b.');

  // Step 6: demo-person-b builds a real Evidence Pack in SeaweedFS.
  deps.log(`[6/6] demo-person-b builds Evidence Pack for ${intent}...`);
  const built = mustJson(await asB(['evidence', 'build', intent]), 'evidence build');
  const pack = (built.pack ?? built) as {
    version?: number;
    manifest?: { sha256?: string };
    markdown?: { sha256?: string };
  };
  const evidenceVersion = Number(pack.version ?? 1);
  deps.log(`      Evidence Pack v${evidenceVersion} built and stored in SeaweedFS.`);
  if (pack.manifest?.sha256) deps.log(`      manifest.json sha256: ${pack.manifest.sha256}`);
  if (pack.markdown?.sha256) deps.log(`      pack.md       sha256: ${pack.markdown.sha256}`);
  deps.log('');
  deps.log(`Inspect ${intent} in the Dashboard: ${deps.apiUrl}`);
  deps.log(
    `Export pack.md: XDG_CONFIG_HOME="${deps.personBConfigHome}" pnpm adlc evidence export ${intent} --output pack.md`,
  );

  return { intent, selfApprovalBlocked, evidenceVersion };
}
