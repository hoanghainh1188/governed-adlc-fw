#!/usr/bin/env node
// The release gate (tasks V12 and V15, RELEASING.md, QUESTIONS #390, ADR-M94). One script for every
// place that decides whether a commit may be released, so they can never disagree:
// - .github/workflows/release.yml and npm-publish.yml run `tag` on the tag, and `lock` on the
//   images.lock of the release (the artifact of release-images.yml, or the Release's asset);
// - the tests run every mode on fixtures, and `changelog` on the real CHANGELOG.
//
//   release-check.mjs tag vX.Y.Z [--root <dir>] [--notes-out <file>]
//   release-check.mjs changelog X.Y.Z [--root <dir>] [--notes-out <file>]
//   release-check.mjs lock <file> X.Y.Z [--images-out <file>]
//
// `tag` checks: the tag is `vX.Y.Z`; the root package.json and PLATFORM_VERSION hold X.Y.Z; the
// CHANGELOG has a section `## [X.Y.Z] - YYYY-MM-DD` with non-empty "Upgrade notes". The images are
// built on the tag, so the tagged commit holds no lock file (ADR-M94 §2.4). `lock` checks a lock
// file: X.Y.Z and the seven images pinned by digest on the one registry path; `--images-out` writes
// the seven references. Every problem is printed (one line each, a code first), then the exit code
// is 1. Prints nothing secret: it reads tracked files and the lock file only.
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'ghcr.io/hoanghainh1188/governed-adlc-fw';
// images.lock key → image name; equal to release-images.yml and scripts/images.sh.
const LOCK_IMAGES = {
  SDLC_IMAGE_API: 'sdlc-api',
  SDLC_IMAGE_WORKER: 'sdlc-worker',
  SDLC_IMAGE_RUNNER: 'sdlc-runner',
  SDLC_IMAGE_OTEL_COLLECTOR: 'sdlc-otel-collector',
  SDLC_IMAGE_SANDBOX_NODE24: 'sandbox-node24',
  // X04 PR 3b (ADR-M89): the first register tool.
  SDLC_IMAGE_TOOL_PROJECT_DOCS: 'tool-project-docs',
  // X06 PR 2 (ADR-M108): the `read_code` register tool.
  SDLC_IMAGE_TOOL_CODE_INDEX: 'tool-code-index',
};
// 0.1.0 is the first release: there was nothing to upgrade from (Harry, V12 plan).
const NOTES_EXEMPT = new Set(['0.1.0']);
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionFromTag(tag, errors) {
  const m = /^v(.*)$/.exec(tag ?? '');
  if (!m || !VERSION_RE.test(m[1])) {
    errors.push(`tag_invalid: the tag must be vX.Y.Z, got '${tag ?? ''}'`);
    return null;
  }
  return m[1];
}

function readFile(root, file, errors) {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    errors.push(`file_missing: ${file}`);
    return null;
  }
}

function checkVersions(root, version, errors) {
  const pkg = readFile(root, 'package.json', errors);
  if (pkg !== null) {
    const found = JSON.parse(pkg).version;
    if (found !== version)
      errors.push(`package_version: package.json has ${found}, the tag ${version}`);
  }
  const src = readFile(root, 'platform/packages/api-schemas/src/version.ts', errors);
  if (src !== null) {
    const found = /PLATFORM_VERSION = '([^']*)'/.exec(src)?.[1];
    if (found !== version) {
      errors.push(
        `platform_version: PLATFORM_VERSION is ${found ?? 'missing'}, the tag ${version}`,
      );
    }
  }
}

/** The body of `## [version] - YYYY-MM-DD` (without its heading), or null. */
function changelogSection(text, version, errors) {
  const lines = text.split('\n');
  const heading = `## [${version}] - `;
  const starts = lines.flatMap((l, i) => (l.startsWith(heading) ? [i] : []));
  if (starts.length !== 1) {
    errors.push(
      starts.length === 0
        ? `changelog_section_missing: no heading '## [${version}] - YYYY-MM-DD'`
        : `changelog_section_twice: '## [${version}]' appears ${starts.length} times`,
    );
    return null;
  }
  const start = starts[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lines[start].slice(heading.length).trim())) {
    errors.push(`changelog_date: the heading of ${version} needs a date YYYY-MM-DD`);
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  if (!NOTES_EXEMPT.has(version)) {
    const notes = body.findIndex((l) => l.trim() === '### Upgrade notes');
    let notesEnd = body.findIndex((l, i) => i > notes && l.startsWith('### '));
    if (notesEnd === -1) notesEnd = body.length;
    if (notes === -1) {
      errors.push(`upgrade_notes_missing: the section ${version} has no '### Upgrade notes'`);
    } else if (!body.slice(notes + 1, notesEnd).some((l) => /^\s*- \S/.test(l))) {
      errors.push(`upgrade_notes_empty: the 'Upgrade notes' of ${version} list nothing`);
    }
  }
  return body.join('\n').trim() + '\n';
}

/** The seven references of a lock file, or an empty list with the problems in `errors`. */
function checkLock(text, version, errors) {
  const entries = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) {
      errors.push(`lock_line: a line is not KEY=value`);
      continue;
    }
    if (entries.has(m[1])) errors.push(`lock_duplicate: ${m[1]}`);
    entries.set(m[1], m[2]);
  }
  const found = entries.get('SDLC_IMAGES_VERSION');
  if (found !== version) {
    errors.push(
      `lock_version: images.lock is for ${found ?? 'no version'}, the release ${version}`,
    );
  }
  const refs = [];
  for (const [key, image] of Object.entries(LOCK_IMAGES)) {
    const ref = entries.get(key);
    if (
      !ref ||
      !new RegExp(`^${PREFIX.replaceAll('.', '\\.')}/${image}@sha256:[0-9a-f]{64}$`).test(ref)
    ) {
      errors.push(`lock_image: ${key} must be ${PREFIX}/${image}@sha256:<64 hex>`);
    } else {
      refs.push(ref);
    }
  }
  for (const key of entries.keys()) {
    if (key !== 'SDLC_IMAGES_VERSION' && !(key in LOCK_IMAGES)) errors.push(`lock_unknown: ${key}`);
  }
  return errors.length === 0 ? refs : [];
}

function parseArgs(argv) {
  const opts = { positional: [], root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--notes-out' || arg === '--images-out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2).replace('-o', 'O')] = value;
      i += 1;
    } else {
      opts.positional.push(arg);
    }
  }
  return opts;
}

function main(argv) {
  const errors = [];
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    errors.push(`usage: ${err.message}`);
    return finish(errors);
  }
  const [mode, a, b] = opts.positional;
  if (mode === 'tag' && a !== undefined && b === undefined) {
    const version = versionFromTag(a, errors);
    if (version === null) return finish(errors);
    checkVersions(opts.root, version, errors);
    const changelog = readFile(opts.root, 'CHANGELOG.md', errors);
    const notes = changelog === null ? null : changelogSection(changelog, version, errors);
    if (opts.imagesOut) errors.push('usage: --images-out belongs to the mode lock');
    if (errors.length === 0) {
      if (opts.notesOut) fs.writeFileSync(opts.notesOut, notes);
      process.stdout.write(`release-check: v${version} ok\n`);
    }
    return finish(errors);
  }
  if (mode === 'changelog' && a !== undefined && b === undefined) {
    if (!VERSION_RE.test(a)) errors.push(`version_invalid: '${a}' is not X.Y.Z`);
    const changelog = errors.length ? null : readFile(opts.root, 'CHANGELOG.md', errors);
    const notes = changelog === null ? null : changelogSection(changelog, a, errors);
    if (errors.length === 0 && opts.notesOut) fs.writeFileSync(opts.notesOut, notes);
    return finish(errors);
  }
  if (mode === 'lock' && a !== undefined && b !== undefined) {
    if (!VERSION_RE.test(b)) errors.push(`version_invalid: '${b}' is not X.Y.Z`);
    let text = null;
    try {
      text = fs.readFileSync(a, 'utf8');
    } catch {
      errors.push(`file_missing: ${a}`);
    }
    const refs = text !== null && errors.length === 0 ? checkLock(text, b, errors) : [];
    if (errors.length === 0) {
      if (opts.imagesOut) fs.writeFileSync(opts.imagesOut, refs.join('\n') + '\n');
      process.stdout.write(`release-check: images.lock for ${b} ok\n`);
    }
    return finish(errors);
  }
  errors.push(
    'usage: release-check.mjs tag vX.Y.Z | changelog X.Y.Z [--root <dir>] [--notes-out <file>] | lock <file> X.Y.Z [--images-out <file>]',
  );
  return finish(errors);
}

function finish(errors) {
  for (const e of errors) process.stderr.write(`release-check: ${e}\n`);
  return errors.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
