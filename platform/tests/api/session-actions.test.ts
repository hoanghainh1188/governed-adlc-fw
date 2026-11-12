// D-08 W01 AC3 (R085b in design/RULES.md, ADR-M73, ADR-M82 §2.7): a session writes only to the
// routes marked `@SessionAction`: the sign-in routes, the passkey routes, the four evaluation plan
// actions of L05 (create, change, archive, Run now), the decisions, kill and escalation actions of
// U07, the intent create, spec link, plan submission and Evidence Pack build of U08, and the
// administration changes of U09 (always with a passkey step-up, ADR-M73 §2.4b). A new mark fails
// here until its task's ADR allows it and this list changes with it.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const API_SRC = path.join(repoRoot(), 'platform/apps/api/src');

const ALLOWED: Record<string, number> = {
  'auth/sign-in.controller.ts': 2,
  'passkeys/passkeys.controller.ts': 5,
  'evaluations/evaluations.controller.ts': 4,
  'intents/intents.controller.ts': 2,
  'runs/runs.controller.ts': 1,
  'escalations/escalations.controller.ts': 2,
  'specs/specs.controller.ts': 1,
  'plans/plans.controller.ts': 1,
  'evidence/evidence.controller.ts': 1,
  // U09 (QUESTIONS #681–#685): every administration change, never the token routes.
  'admin/projects.controller.ts': 6,
  'admin/users.controller.ts': 7,
  'admin/tenant-admins.controller.ts': 2,
  'admin/agents.controller.ts': 7,
  'ai-records/ai-records.controller.ts': 1,
  'evidence/holds.controller.ts': 2,
};

// U09: in these files every write route is marked, and every marked route takes the step-up
// (`stepUp.apply` or `stepUp.run`), except the routes listed here, which stay CLI-only.
const U09_FILES = [
  'admin/projects.controller.ts',
  'admin/users.controller.ts',
  'admin/tenant-admins.controller.ts',
  'admin/agents.controller.ts',
  'ai-records/ai-records.controller.ts',
  'evidence/holds.controller.ts',
];
const CLI_ONLY = ["@Post(':user/tokens')", "@Delete(':user/tokens/:token')"];
const WRITE = /^\s*@(Post|Put|Patch|Delete)\(/;

/** The decorators and body of each route method of a controller file, split at the decorators. */
function routes(source: string): { decorators: string[]; body: string }[] {
  const lines = source.split('\n');
  const out: { decorators: string[]; body: string }[] = [];
  let current: { decorators: string[]; body: string } | undefined;
  let inDecorators = false;
  for (const line of lines) {
    if (/^\s{2}@/.test(line)) {
      if (!inDecorators) {
        current = { decorators: [], body: '' };
        out.push(current);
        inDecorators = true;
      }
      current!.decorators.push(line.trim());
    } else {
      inDecorators = false;
      if (current) current.body += `${line}\n`;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('W01: routes a session may write to (R085b)', () => {
  it('marks only the allowed routes with @SessionAction', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(API_SRC)) {
      const count = (fs.readFileSync(file, 'utf8').match(/^\s*@SessionAction\(/gm) ?? []).length;
      if (count > 0) found[path.relative(API_SRC, file).split(path.sep).join('/')] = count;
    }
    expect(found).toEqual(ALLOWED);
  });

  it('U09: every administration change takes a session only with the step-up', () => {
    let checked = 0;
    for (const file of U09_FILES) {
      const source = fs.readFileSync(path.join(API_SRC, file), 'utf8');
      for (const route of routes(source)) {
        const write = route.decorators.find((d) => WRITE.test(d));
        if (!write) continue;
        const marked = route.decorators.some((d) => d.startsWith("@SessionAction('actions')"));
        if (CLI_ONLY.includes(write)) {
          expect(marked, `${file} ${write}`).toBe(false);
          continue;
        }
        expect(marked, `${file} ${write}`).toBe(true);
        expect(route.body, `${file} ${write}`).toMatch(/stepUp\.(apply|run)\(|this\.stop\(/);
        checked += 1;
      }
    }
    expect(checked).toBe(25);
  });
});
