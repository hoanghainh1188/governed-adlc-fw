// Static demo identities and project configuration (D-08 V23, issue #561). Pure.

export const DEMO_TENANT = 'demo';
export const DEMO_TENANT_NAME = 'Demo Organization';
export const DEMO_PROJECT_SLUG = 'demo';
export const DEMO_PROJECT_NAME = 'Demo Sample App';
export const DEMO_REPO = 'demo/sample-app';

export interface DemoPerson {
  readonly slug: string;
  readonly name: string;
  readonly email: string;
  readonly role: 'person_a' | 'person_b';
}

export const DEMO_PERSON_A: DemoPerson = {
  slug: 'demo-person-a',
  name: 'Demo Person A (Producer)',
  email: 'demo-person-a@demo.local',
  role: 'person_a',
};

export const DEMO_PERSON_B: DemoPerson = {
  slug: 'demo-person-b',
  name: 'Demo Person B (Reviewer)',
  email: 'demo-person-b@demo.local',
  role: 'person_b',
};

/**
 * Project configuration for the local demo. Enables U10 uploaded plans for low and medium risk
 * intents so the walkthrough needs no GitHub repository or commit, and allows both demo users to
 * build and inspect Evidence Packs.
 */
export function demoProjectConfig(): string {
  return [
    '# Local 5-minute demo configuration (D-08 V23), written by pnpm demo:up.',
    'oversight:',
    '  uploaded_plan_risks: [low, medium]',
    'access:',
    '  evidence_build_roles: [person_a, person_b]',
    '  evidence_read_roles: [person_a, person_b]',
    '',
  ].join('\n');
}
