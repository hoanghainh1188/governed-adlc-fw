// Which files a code index reads, and how a relative import finds its file (task X06,
// design/ADR-M108 §2.3, §2.6). Pure functions over repository paths; no I/O.
import type { CodeLanguage } from '@sdlc/contracts';

/** Folders whose files are never indexed: installed or built code, caches. */
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.git',
  'target',
  '__pycache__',
]);

/** Whether a path lies in a folder the index skips, or is a minified bundle. */
export function isSkippedPath(path: string): boolean {
  if (path.endsWith('.min.js')) return true;
  // A path with a control character (NUL included) cannot be stored: never indexed.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return true;
  const folders = path.split('/').slice(0, -1);
  return folders.some((folder) => SKIPPED_FOLDERS.has(folder));
}

const SCRIPT_LANGUAGES: readonly CodeLanguage[] = ['typescript', 'tsx', 'javascript', 'vue'];
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'];

/** `a/b/../c/./d` → `a/c/d`; undefined when it leaves the repository. */
function normalize(parts: readonly string[]): string | undefined {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirname(path: string): string[] {
  return path.split('/').slice(0, -1);
}

/** The candidate files of a relative script import, in the order they are tried. */
function scriptCandidates(base: string): string[] {
  // `.` at the repository root: only its index file.
  if (base === '') return SCRIPT_EXTENSIONS.map((ext) => `index${ext}`);
  const candidates = [base];
  // `./x.js` in TypeScript source names `./x.ts` (ES modules with `.js` specifiers).
  const js = /\.(m|c)?jsx?$/.exec(base);
  const stem = js ? base.slice(0, -js[0].length) : base;
  for (const ext of SCRIPT_EXTENSIONS) candidates.push(`${stem}${ext}`);
  for (const ext of SCRIPT_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  return candidates;
}

/** A relative Python import (`.`, `.models`, `..pkg.mod`) → candidate files. */
function pythonCandidates(from: string, module: string): string[] {
  const dots = /^\.+/.exec(module)?.[0].length ?? 0;
  if (dots === 0) return [];
  const rest = module.slice(dots).split('.').filter(Boolean);
  const up = Array.from({ length: dots - 1 }, () => '..');
  const base = normalize([...dirname(from), ...up, ...rest]);
  if (base === undefined) return [];
  // `from . import x`: the package itself, never a sibling module named like its folder.
  const init = base === '' ? '__init__.py' : `${base}/__init__.py`;
  return rest.length === 0 ? [init] : [`${base}.py`, init];
}

/**
 * The file of the same index a relative import names, or null (a package, an absolute module,
 * Java and Go imports, or no such file).
 */
export function resolveImport(
  from: string,
  language: CodeLanguage,
  module: string,
  files: ReadonlySet<string>,
): string | null {
  let candidates: string[] = [];
  if (SCRIPT_LANGUAGES.includes(language)) {
    const relative =
      module === '.' || module === '..' || module.startsWith('./') || module.startsWith('../');
    if (!relative) return null;
    const base = normalize([...dirname(from), ...module.split('/')]);
    if (base === undefined) return null;
    candidates = scriptCandidates(base);
  } else if (language === 'python') {
    candidates = pythonCandidates(from, module);
  }
  return candidates.find((candidate) => candidate !== from && files.has(candidate)) ?? null;
}
