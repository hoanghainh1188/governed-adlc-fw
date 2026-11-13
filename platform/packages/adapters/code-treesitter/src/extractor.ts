// The Tree-sitter extractor of the code index (task X06, design/ADR-M108 §2.1, §2.3). The runtime
// and the grammars are WebAssembly from `@vscode/tree-sitter-wasm` (MIT): no native code, and a
// file built to break the parser cannot reach memory outside the parser's own heap (ADR-M80 G-12).
// Client code in; names, kinds, lines and module names out. It never runs the code and never logs
// a path, a name or a text.
import {
  CODE_SYMBOL_KINDS,
  type CodeLanguage,
  type CodeSymbol,
  type CodeSymbolExtractor,
  type CodeSymbolKind,
  type ExtractedCode,
} from '@sdlc/contracts';
import { Language, Parser, Query, type QueryCapture } from '@vscode/tree-sitter-wasm';

import { GRAMMARS, type GrammarName } from './queries.js';

/** A name or module longer than this is cut: generated code can hold very long identifiers. */
export const MAX_NAME_CHARS = 256;

const EXTENSIONS: Readonly<Record<string, CodeLanguage>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.vue': 'vue',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
};

const KINDS = new Set<string>(CODE_SYMBOL_KINDS);

interface LoadedGrammar {
  readonly language: Language;
  readonly query: Query;
}

/** The directory of the grammar files: next to the runtime in the package. */
function wasmPath(file: string): string {
  return require.resolve(`@vscode/tree-sitter-wasm/wasm/${file}`);
}

/**
 * The script blocks of a Vue single-file component, with every other character replaced by a space
 * (new lines kept), so the lines of the symbols stay the lines of the file. TypeScript when any
 * block says `lang="ts"` (or `tsx`).
 */
export function vueScript(content: string): { grammar: GrammarName; source: string } {
  const blank = content.replace(/[^\n]/g, ' ').split('');
  let typescript = false;
  // The attributes may hold `>` inside quotes (`generic="T extends Array<string>"`).
  const scripts = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of content.matchAll(scripts)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\blang\s*=\s*["']?tsx?["']?/i.test(attributes)) typescript = true;
    const start = (match.index ?? 0) + '<script'.length + attributes.length + 1;
    for (let i = 0; i < body.length; i += 1) blank[start + i] = body[i]!;
  }
  return { grammar: typescript ? 'typescript' : 'javascript', source: blank.join('') };
}

/** NUL and other control characters: never stored (PostgreSQL refuses NUL in text). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A captured text as stored: no control characters, at most `MAX_NAME_CHARS`. */
function storedText(text: string): string {
  return text.replace(CONTROL, '').slice(0, MAX_NAME_CHARS);
}

function moduleName(text: string): string {
  return storedText(text.replace(/^["'`]|["'`]$/g, ''));
}

/** One capture per node: the earliest pattern wins (a definition before a type reference). */
function firstPerNode(captures: readonly QueryCapture[]): QueryCapture[] {
  const best = new Map<string, QueryCapture>();
  for (const capture of captures) {
    if (capture.name.startsWith('_')) continue;
    const key = `${capture.node.startIndex}:${capture.node.endIndex}`;
    const seen = best.get(key);
    if (!seen || capture.patternIndex < seen.patternIndex) best.set(key, capture);
  }
  return [...best.values()].sort((a, b) => a.node.startIndex - b.node.startIndex);
}

function toResult(captures: readonly QueryCapture[]): ExtractedCode {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];
  for (const capture of firstPerNode(captures)) {
    if (capture.name === 'import') {
      const module = moduleName(capture.node.text);
      if (module.length > 0) imports.push(module);
      continue;
    }
    const [role, kind] = capture.name.split('.');
    if ((role !== 'def' && role !== 'ref') || !kind || !KINDS.has(kind)) continue;
    const name = storedText(capture.node.text);
    if (name.length === 0) continue;
    symbols.push({
      name,
      kind: kind as CodeSymbolKind,
      role,
      line: capture.node.startPosition.row + 1,
    });
  }
  return { symbols, imports: [...new Set(imports)] };
}

export class TreeSitterExtractor implements CodeSymbolExtractor {
  #ready: Promise<void> | undefined;
  readonly #grammars = new Map<GrammarName, Promise<LoadedGrammar>>();

  languageOf(path: string): CodeLanguage | undefined {
    const dot = path.lastIndexOf('.');
    if (dot <= path.lastIndexOf('/')) return undefined;
    return EXTENSIONS[path.slice(dot).toLowerCase()];
  }

  async extract(
    language: CodeLanguage,
    content: string,
    timeoutMs: number,
  ): Promise<ExtractedCode | { readonly skipped: 'parse_timeout' }> {
    const { grammar, source } =
      language === 'vue' ? vueScript(content) : { grammar: language, source: content };
    const loaded = await this.#grammar(grammar);
    const parser = new Parser();
    try {
      parser.setLanguage(loaded.language);
      const deadline = Date.now() + timeoutMs;
      // The callback's `true` stops the parse; the declared type says `void`.
      const progressCallback = (() => Date.now() > deadline) as unknown as () => void;
      const tree = parser.parse(source, null, { progressCallback });
      if (!tree) return { skipped: 'parse_timeout' };
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const captures = loaded.query.captures(tree.rootNode, {
          timeoutMicros: remaining * 1000,
        });
        if (Date.now() > deadline) return { skipped: 'parse_timeout' };
        return toResult(captures);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }

  async #grammar(name: GrammarName): Promise<LoadedGrammar> {
    // A failed start or load is not kept: the next file tries again.
    this.#ready ??= Parser.init().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    await this.#ready;
    let loaded = this.#grammars.get(name);
    if (!loaded) {
      loaded = (async () => {
        const language = await Language.load(wasmPath(GRAMMARS[name].wasm));
        return { language, query: new Query(language, GRAMMARS[name].query) };
      })().catch((error: unknown) => {
        this.#grammars.delete(name);
        throw error;
      });
      this.#grammars.set(name, loaded);
    }
    return loaded;
  }
}
