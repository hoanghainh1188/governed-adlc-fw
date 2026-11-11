// Every check of `pnpm doctor`, in a fixed order (D-08 V07 AC1). Pure: `host.ts` (in src/) gathers
// the facts, these functions decide; `render.ts` prints.
import type { CheckResult, OperatorFacts } from '../types.js';
import { accessChecks } from './access.js';
import { githubChecks } from './github.js';
import { hostChecks } from './host.js';
import { ok, problem, skipped, text } from './result.js';
import { runnerAuthzChecks, runnerChecks } from './runner.js';
import { stackChecks } from './stack.js';

function imagesModeCheck(f: OperatorFacts): CheckResult {
  if (f.imagesMode === undefined) return skipped('images.mode', 'doctor.skipped.stopped');
  if (f.imagesMode === 'failed') {
    return problem(
      'images.mode',
      'failed',
      text('doctor.images.failed'),
      text('doctor.fix.readme', { section: 'Verify the published images' }),
    );
  }
  return ok('images.mode', text('doctor.images.mode', { mode: f.imagesMode }));
}

export function evaluate(facts: OperatorFacts): CheckResult[] {
  return [
    ...hostChecks(facts),
    ...stackChecks(facts),
    ...githubChecks(facts),
    imagesModeCheck(facts),
    ...accessChecks(facts),
    ...runnerChecks(facts),
    ...runnerAuthzChecks(facts),
  ];
}
