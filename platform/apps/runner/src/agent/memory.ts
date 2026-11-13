// The memory notes the agent gets (task X13 PR 2, design/ADR-M74 §2.6, §2.8). G4 put in the Run
// Contract (schema 5) whether the memory set at `base_sha` is a version a person approved and
// nobody revoked, with its hash. The runner reads the set from its own clone, checks the hash,
// cleans and caps the text (`memory` of the project configuration at the run's start), and the
// adapter puts it in its own nonce block. Any failure: the run goes on **without** memory; it
// never fails for memory. The text goes to the agent only: `memory_read` holds codes and counts.
import type { MemoryTextBlock, ProjectConfig, RunContract } from '@sdlc/contracts';
import type { TenantScope } from '@sdlc/core';

import type { MemoryFilesReader } from '../workspace/memory-files.js';
import { capText, cleanText } from './text.js';

const FILE_CUT_NOTE = '\n[The platform cut this note here.]';
const TEXT_CUT_NOTE = '\n[The platform cut the notes here.]';

type MemoryReason =
  | 'read'
  | 'off'
  | Exclude<NonNullable<RunContract['memory']>['reason'], 'approved'>
  | 'hash_mismatch'
  | 'unreadable';

/** The files as `Memory file: <name>` lines and their cleaned text, capped per file and in all. */
export function renderMemory(
  files: readonly { readonly name: string; readonly text: string }[],
  limits: ProjectConfig['memory'],
): { readonly text: string; readonly truncated: boolean } {
  let truncated = false;
  const blocks = files.map((file) => {
    const capped = capText(cleanText(file.text), limits.max_file_chars, FILE_CUT_NOTE);
    truncated ||= capped.truncated;
    return `Memory file: ${file.name}\n${capped.text}`;
  });
  const capped = capText(blocks.join('\n\n'), limits.max_total_chars, TEXT_CUT_NOTE);
  return { text: capped.text, truncated: truncated || capped.truncated };
}

async function record(
  scope: TenantScope,
  contract: RunContract,
  reason: MemoryReason,
  block?: MemoryTextBlock,
): Promise<void> {
  const version = contract.memory?.version ?? null;
  const setSha256 = contract.memory?.set_sha256 ?? null;
  await scope.runEvents.append(contract.run_id, 'memory_read', {
    reason,
    // The version and hash only when the notes reached the prompt.
    ...(reason === 'read' && version !== null && setSha256 !== null
      ? { version, set_sha256: setSha256 }
      : {}),
    files: block?.files ?? 0,
    chars: block?.text.length ?? 0,
    truncated: block?.truncated === true ? 'yes' : 'no',
  });
}

/**
 * The memory block of a run, or undefined. A contract without `memory` (schema 2–4) records
 * nothing. Records `memory_read` once, with the reason.
 */
export async function loadMemory(
  scope: TenantScope,
  contract: RunContract,
  limits: ProjectConfig['memory'],
  reader: MemoryFilesReader | undefined,
): Promise<MemoryTextBlock | undefined> {
  const memory = contract.memory;
  if (memory === undefined) return undefined;
  // Turned off since G4: off at once, whatever the contract says.
  if (limits.mode === 'off') return record(scope, contract, 'off').then(() => undefined);
  if (memory.reason !== 'approved') {
    return record(scope, contract, memory.reason).then(() => undefined);
  }
  const read = reader ? await reader(contract.base_sha, limits.max_files) : undefined;
  if (read?.kind !== 'ok') return record(scope, contract, 'unreadable').then(() => undefined);
  if (read.setSha256 !== memory.set_sha256) {
    return record(scope, contract, 'hash_mismatch').then(() => undefined);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let files;
  try {
    files = read.files.map((file) => ({ name: file.name, text: decoder.decode(file.bytes) }));
  } catch {
    return record(scope, contract, 'unreadable').then(() => undefined);
  }
  const rendered = renderMemory(files, limits);
  const block: MemoryTextBlock = {
    text: rendered.text,
    files: files.length,
    truncated: rendered.truncated || read.setFiles > files.length,
  };
  if (block.files === 0) return record(scope, contract, 'unreadable').then(() => undefined);
  await record(scope, contract, 'read', block);
  return block;
}
