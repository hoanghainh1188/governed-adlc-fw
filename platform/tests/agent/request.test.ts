// D-08 C05 AC1, AC2, AC3 (iteration cap): what the runner sends to the Agent Server to start a run
// (ADR-M10 §2.2, ADR-M29). Pure builders, so the exact body is checked.
import { buildConversationRequest, taskMessage } from '@sdlc/adapter-agent-openhands';
import { CI_FAILED_INSTRUCTION, toolsOf } from '@sdlc/agent-kit';
import { AgentError, type AgentTask } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { CONTRACT, TASK, VIRTUAL_KEY } from './helpers';

const input = {
  contract: CONTRACT,
  model: 'gpt-oss-20b',
  llmBaseUrl: 'http://litellm:4000',
  virtualKey: VIRTUAL_KEY,
  workingDir: '/workspace',
  task: TASK,
};

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AgentError ? error.code : 'other';
  }
  return undefined;
}

interface Body {
  readonly agent: {
    readonly llm: unknown;
    readonly tools: unknown;
    readonly agent_context: unknown;
  };
  readonly max_iterations: unknown;
  readonly autotitle: unknown;
  readonly stuck_detection: unknown;
  readonly workspace: unknown;
  readonly initial_message: { readonly run: unknown };
  readonly observability_metadata: unknown;
}

describe('buildConversationRequest', () => {
  const body = buildConversationRequest(input) as unknown as Body;

  it('calls the model through LiteLLM with the run key, in the body only (FR-50)', () => {
    expect(body.agent.llm).toEqual({
      model: 'litellm_proxy/gpt-oss-20b',
      base_url: 'http://litellm:4000',
      api_key: VIRTUAL_KEY,
      usage_id: 'agent',
    });
  });

  it('grants the contract tools only', () => {
    expect(body.agent.tools).toEqual([
      { name: 'file_editor', params: {} },
      { name: 'terminal', params: {} },
    ]);
  });

  it('loads AGENTS.md from the workspace, and no user, public or memory skills (AC2)', () => {
    expect(body.agent.agent_context).toEqual({
      load_project_skills: true,
      load_user_skills: false,
      load_public_skills: false,
      load_memory: false,
    });
  });

  it('sets the iteration cap from the contract; no title call; stuck detector on (AC3)', () => {
    expect(body.max_iterations).toBe(CONTRACT.max_iterations);
    expect(body.autotitle).toBe(false);
    expect(body.stuck_detection).toBe(true);
    expect(body.workspace).toEqual({ kind: 'LocalWorkspace', working_dir: '/workspace' });
    expect(body.initial_message.run).toBe(true);
  });

  it('sends IDs only as trace metadata, never the key', () => {
    expect(body.observability_metadata).toEqual({
      run_id: CONTRACT.run_id,
      intent_id: CONTRACT.intent_id,
      tenant_id: CONTRACT.tenant_id,
      agent_id: CONTRACT.agent_id,
    });
    const withoutLlm: Body = { ...body, agent: { ...body.agent, llm: undefined } };
    expect(JSON.stringify(withoutLlm)).not.toContain(VIRTUAL_KEY);
  });

  it('refuses a model outside allowed_models (QUESTIONS #79)', () => {
    expect(code(() => buildConversationRequest({ ...input, model: 'claude-opus' }))).toBe(
      'model_not_allowed',
    );
  });

  it.each(['browser_tool_set', 'delegate', 'task', 'workflow'])(
    'refuses the tool %s, which the MVP never grants',
    (tool) => {
      const contract = { ...CONTRACT, allowed_tools: [tool] };
      expect(code(() => toolsOf(contract))).toBe('tool_not_allowed');
    },
  );

  it.each<[string, Partial<AgentTask['spec']>]>([
    ['an absolute path', { path: '/etc/passwd' }],
    ['a parent segment', { path: 'docs/../../x.md' }],
    ['a short commit', { commitSha: 'abc' }],
    ['a bad hash', { contentSha256: 'x'.repeat(64) }],
  ])('refuses a spec with %s', (_, spec) => {
    const task = { ...TASK, spec: { ...TASK.spec, ...spec } };
    expect(code(() => buildConversationRequest({ ...input, task }))).toBe('invalid_input');
  });

  it('refuses a plan whose files differ from the contract', () => {
    const task = { ...TASK, plan: { ...TASK.plan, plannedFiles: ['**'] } };
    expect(code(() => buildConversationRequest({ ...input, task }))).toBe('invalid_input');
  });
});

describe('buildTaskMessage (AC2)', () => {
  const message = taskMessage(CONTRACT, TASK, '/workspace');

  it('C08 PR 2 (QUESTIONS #158): a retry after CI failed gets one fixed instruction, no logs', () => {
    expect(message).not.toContain(CI_FAILED_INSTRUCTION);
    const retry = taskMessage(CONTRACT, { ...TASK, ciFailed: true }, '/workspace');
    expect(retry).toContain(CI_FAILED_INSTRUCTION);
    expect(retry.length - message.length).toBe(CI_FAILED_INSTRUCTION.length + 2);
  });

  it('names the spec file, its commit and hash', () => {
    expect(message).toContain('file: docs/specs/T01-japanese-labels.md');
    expect(message).toContain(`commit: ${'d'.repeat(40)}`);
    expect(message).toContain(`SHA-256: ${'e'.repeat(64)}`);
  });

  it('has the plan summary and every planned file', () => {
    expect(message).toContain('Add Japanese labels to the product list screen.');
    expect(message).toContain('- apps/web/src/products/**');
    expect(message).toContain('- docs/CHANGELOG.md');
  });

  it('points at AGENTS.md and states the rules of the run', () => {
    expect(message).toContain('AGENTS.md');
    expect(message).toContain(`branch ${CONTRACT.branch}`);
    expect(message).toMatch(/Do not push/);
    expect(message).toMatch(/finish tool/);
  });
});

// O06 (ADR-M106 §2.4): a contract with a project folder makes OpenHands work in that folder, and
// the task message names it; git and the reads report keep the repository root.
describe('buildConversationRequest with a project folder', () => {
  const folder = {
    ...input,
    contract: { ...CONTRACT, schema_version: 4, repo_path: 'packages/web' } as typeof CONTRACT,
  };
  const body = buildConversationRequest(folder) as unknown as Body;

  it('works in <workspace>/<repo_path>', () => {
    expect(body.workspace).toEqual({
      kind: 'LocalWorkspace',
      working_dir: '/workspace/packages/web',
    });
  });

  it('tells the agent to change files only in the folder', () => {
    const text = taskMessage(folder.contract, TASK, '/workspace');
    expect(text).toContain('Your project is the folder packages/web');
  });

  it('without a folder, nothing changes', () => {
    const plain = buildConversationRequest(input) as unknown as Body;
    expect(plain.workspace).toEqual({ kind: 'LocalWorkspace', working_dir: '/workspace' });
    expect(taskMessage(CONTRACT, TASK, '/workspace')).not.toContain('Your project is the folder');
  });
});
