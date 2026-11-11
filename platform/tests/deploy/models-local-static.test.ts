// D-08 L01 AC1, AC2 (static part, no Docker, no GPU): the self-hosted model service (vLLM) in the
// optional Compose profile `models-local`, and its LiteLLM entry (design/ADR-M71, QUESTIONS
// #546–#549). The live part (AC4, a stub in place of vLLM): integration/litellm/litellm-live.test.ts.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { parseEnvFile, readDeployFile } from './compose';

interface Service {
  image?: string;
  profiles?: string[];
  restart?: string;
  networks?: string[] | Record<string, unknown>;
  user?: string;
  environment?: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  ports?: string[];
  volumes?: string[];
  tmpfs?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  shm_size?: string;
  deploy?: {
    resources?: {
      reservations?: { devices?: { driver?: string; count?: string; capabilities?: string[] }[] };
    };
  };
  healthcheck?: { test?: string[]; start_period?: string };
}
interface Compose {
  services: Record<string, Service>;
  networks: Record<string, { name?: string; internal?: boolean }>;
  volumes: Record<string, unknown>;
}

const compose = parse(readDeployFile('docker-compose.yml'), { merge: true }) as Compose;
const vllm = compose.services.vllm!;
const pull = compose.services['vllm-pull']!;
const envExample = parseEnvFile(readDeployFile('.env.example'));
const template = readDeployFile('litellm/config.ctmpl');
const root = parse(readDeployFile('../../package.json')) as { scripts: Record<string, string> };

/** The template's vllm entry, from its `if` to its closing `end`s. */
const entry = /\{\{- if in \$providers "vllm" \}\}[\s\S]*?\{\{- end \}\}\n\{\{- end \}\}/.exec(
  template,
)?.[0];

const IMAGE = /^vllm\/vllm-openai:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/;

describe('AC1: the profile models-local (ADR-M71 §2.1)', () => {
  it('is optional: only vllm is in it, and no other profile starts vllm or vllm-pull', () => {
    const inProfile = (p: string) =>
      Object.entries(compose.services)
        .filter(([, s]) => (s.profiles ?? []).includes(p))
        .map(([n]) => n);
    expect(inProfile('models-local')).toEqual(['vllm']);
    expect(inProfile('models-local-pull')).toEqual(['vllm-pull']);
    expect(vllm.profiles).toEqual(['models-local']);
    expect(pull.profiles).toEqual(['models-local-pull']);
    // The server's start, the dev start and the trial never name the profile (R041).
    for (const [name, script] of Object.entries(root.scripts)) {
      if (name === 'compose:models-local' || name === 'compose:down') continue;
      expect(script, name).not.toMatch(/models-local(?!-pull|:)/);
    }
    expect(root.scripts['compose:models-local']).toBe(
      'platform/deploy/scripts/up.sh core models models-local',
    );
    expect(root.scripts['compose:down']).toContain('--profile models-local ');
    expect(root.scripts['models-local:pull']).toMatch(
      /--profile models-local-pull run --rm vllm-pull$/,
    );
  });

  it('pins vLLM (Apache-2.0) by tag and digest, the same image for the pull (R038)', () => {
    expect(vllm.image).toMatch(IMAGE);
    expect(pull.image).toBe(vllm.image);
  });

  it('runs only on the internal network models, with LiteLLM (and, in L01 PR 2, the link), no port', () => {
    expect(compose.networks.models).toEqual({
      name: '${COMPOSE_PROJECT_NAME:-sdlc}-models',
      internal: true,
    });
    expect(vllm.networks).toEqual(['models']);
    expect(vllm.ports).toBeUndefined();
    const members = Object.entries(compose.services)
      .filter(([, s]) => {
        const n = s.networks ?? [];
        return Array.isArray(n) ? n.includes('models') : 'models' in n;
      })
      .map(([n]) => n)
      .sort();
    // vllm-link (profile models-remote, ADR-M71 §4.2) takes vllm's place when vLLM runs on a
    // separate GPU host; up.sh never starts both (models-remote-static.test.ts).
    expect(members).toEqual(['litellm', 'vllm', 'vllm-link']);
  });

  it('reserves the GPU; the GPU count is also the tensor parallel size', () => {
    expect(vllm.deploy?.resources?.reservations?.devices).toEqual([
      { driver: 'nvidia', count: '${SDLC_VLLM_GPU_COUNT:-1}', capabilities: ['gpu'] },
    ]);
    expect(vllm.command).toContain('--tensor-parallel-size=${SDLC_VLLM_GPU_COUNT:-1}');
  });

  it('has a health check on /health with a long start period, and restarts', () => {
    expect(vllm.restart).toBe('unless-stopped');
    expect(vllm.healthcheck?.test?.join(' ')).toContain("'http://127.0.0.1:8000/health'");
    expect(vllm.healthcheck?.start_period).toBe('900s');
  });

  it('limits concurrent requests with one value for vLLM and LiteLLM (QUESTIONS #549)', () => {
    expect(vllm.command).toContain('--max-num-seqs=${SDLC_VLLM_MAX_NUM_SEQS:-4}');
    expect(compose.services['litellm-agent']!.environment!.SDLC_VLLM_MAX_NUM_SEQS).toBe(
      '${SDLC_VLLM_MAX_NUM_SEQS:-4}',
    );
    expect(entry).toContain(
      'max_parallel_requests: {{ or (env "SDLC_VLLM_MAX_NUM_SEQS") "4" | parseInt }}',
    );
    expect(envExample.get('SDLC_VLLM_MAX_NUM_SEQS')).toBe('4');
  });

  it('never downloads at run time: weights read-only, offline, no usage statistics (#547)', () => {
    expect(vllm.volumes).toEqual(['vllm-models:/models:ro']);
    expect(vllm.environment).toMatchObject({
      HF_HOME: '/models',
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      VLLM_NO_USAGE_STATS: '1',
      DO_NOT_TRACK: '1',
    });
    expect(compose.volumes).toHaveProperty('vllm-models');
  });

  it('runs as the image user vllm with no capability, and never trusts remote code', () => {
    expect(vllm.user).toBe('2000:0');
    expect(vllm.tmpfs).toEqual(['/cache:uid=2000,gid=0,mode=0700']);
    expect(vllm.cap_drop).toEqual(['ALL']);
    expect(vllm.security_opt).toEqual(['no-new-privileges:true']);
    expect(vllm.entrypoint).toBeUndefined();
    expect(vllm.command?.join(' ')).not.toMatch(/trust-remote-code|enable-log-requests|api-key/);
  });

  it('serves the model of the settings, with tool calls, under its served name', () => {
    expect(vllm.command?.slice(0, 3)).toEqual([
      '${SDLC_VLLM_MODEL:-Qwen/Qwen3-Coder-30B-A3B-Instruct}',
      '--revision=${SDLC_VLLM_MODEL_REVISION:-main}',
      '--served-model-name=${SDLC_VLLM_SERVED_NAME:-qwen3-coder-30b-a3b-instruct}',
    ]);
    expect(vllm.command).toContain('--enable-auto-tool-choice');
    expect(vllm.command).toContain('--tool-call-parser=${SDLC_VLLM_TOOL_PARSER:-qwen3_coder}');
  });

  it('.env.example gives every setting the same default as the compose file', () => {
    const code = readDeployFile('docker-compose.yml');
    const defaults = [...code.matchAll(/\$\{(SDLC_VLLM_[A-Z_]+):-([^}]*)\}/g)];
    expect(defaults.length).toBeGreaterThan(0);
    for (const [, name, value] of defaults) {
      // L01 PR 2: the placeholder of the unset link folder (profile models-remote) is no default.
      if (name === 'SDLC_VLLM_LINK_TLS_DIR') expect(envExample.get(name), name).toBe('');
      else expect(envExample.get(name!), name).toBe(value);
    }
  });

  it('the pull job writes the volume from the internet once, weights and tokenizer only', () => {
    expect(pull.restart).toBe('no');
    expect(pull.networks).toEqual(['sdlc']);
    expect(pull.volumes).toEqual(['vllm-models:/models']);
    expect(pull.cap_drop).toEqual(['ALL']);
    const script = pull.entrypoint?.join('\n') ?? '';
    expect(script).toContain('snapshot_download(');
    expect(script).toContain("revision=os.environ['SDLC_VLLM_MODEL_REVISION']");
    expect(script).not.toMatch(/\*\.py|token=/);
    expect(pull.environment).not.toHaveProperty('HF_TOKEN');
  });
});

describe('AC2: the LiteLLM entry (ADR-M71 §2.3, QUESTIONS #548)', () => {
  it('exists, self-hosted, from the provider entry vllm, through toJSON', () => {
    expect(entry).toBeDefined();
    expect(entry).toContain('{{- with secret "kv/data/litellm/providers/vllm" }}');
    expect(entry).toContain('- model_name: {{ .Data.data.model | toJSON }}');
    expect(entry).toContain('model: {{ printf "hosted_vllm/%s" .Data.data.model | toJSON }}');
    expect(entry).toContain('api_base: {{ .Data.data.api_base | toJSON }}');
    expect(entry).toContain('provider_type: self_hosted');
    // No key: only LiteLLM reaches vllm on the internal network.
    expect(entry).not.toContain('api_key');
  });

  it('declares an internal cost per token above 0, so budgets keep working (D-07 §3)', () => {
    for (const field of ['input_cost_per_token', 'output_cost_per_token']) {
      const value = Number(new RegExp(`${field}: (\\S+)`).exec(entry ?? '')?.[1]);
      expect(value, field).toBeGreaterThan(0);
    }
  });
});
