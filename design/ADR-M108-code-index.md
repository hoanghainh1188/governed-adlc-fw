# ADR-M108. A code index for agents: symbols and related files at the run's base commit

| Item | Value |
|---|---|
| Status | **Proposed** (task X06 PR 1, PR 2). The plan and the answers to QUESTIONS #696–#700 were approved by Harry on 2026-11-12 |
| Date | 2026-11-12 |
| Decided by | Harry (X06 plan, 2026-11-12) |
| Related | D-08 X06 AC1, AC2; D-01 §5.8b (code context); D-02 NFR-03, NFR-05, FR-33, FR-44; D-05 §6.1, §10.1; ADR-M69 (tool register), ADR-M87 (MCP gateway), ADR-M89 (the index of a project's documents), ADR-M51 (retention), ADR-M97 (client data deletion), ADR-M80 (threat model); design/QUESTIONS.md #361, #696–#700 |

## 1. Context

X04 gave a run a register tool that searches the project's Markdown documents (ADR-M89). D-01 §5.8b says that agents also need a **code context**: where a symbol is defined, where it is used, and which files belong together. D-08 X06 asks for a read-only tool that finds symbols and related files at the run's `base_sha` (AC1), with the tool register, the index lifecycle and the retention of X04 (AC2).

Today an agent finds these things by reading files in the sandbox with `grep`. That works on small repositories. On large ones it costs many tool calls and tokens, and it misses definitions that are not spelled the same way as the search.

## 2. Decision

### 2.1. Tree-sitter, not SCIP (QUESTIONS #696)

- The index is built with **Tree-sitter** queries: a syntax tree per file, then the definitions, the references and the imports. It needs no build of the project.
- **SCIP** (precise cross-references) needs one indexer per language that **compiles** the project. That means installing the project's dependencies and running its build: only possible inside a sandbox, with the package proxy and the network rules. It is not chosen for now. A later task may add it as a second index format.
- The parser is `@vscode/tree-sitter-wasm` (MIT, Microsoft): the Tree-sitter runtime and the grammars as **WebAssembly**, with no native code and no install script. A WebAssembly parser cannot read or write memory outside its own heap, so a file built to crash the parser cannot take over the worker (ADR-M80 §5, gap G-12).
- The parser runs behind the interface `CodeSymbolExtractor` of `@sdlc/contracts`; the adapter `@sdlc/adapter-code-treesitter` implements it (R033). Core never imports it.

### 2.2. No embeddings in the first version (QUESTIONS #697)

- The index holds names, kinds, lines and imports. A search is by symbol name (exact, then by prefix), not by meaning. So the index **calls no model**: it costs nothing, and it works for every data class the tool allows, including `client_restricted`.
- A search by meaning (embeddings with pgvector, as for documents) may come later, as its own permission and with the data class rules of D-07 §4.

### 2.3. Languages (QUESTIONS #698)

| Files | Grammar |
|---|---|
| `.ts`, `.mts`, `.cts` | TypeScript |
| `.tsx` | TSX |
| `.js`, `.mjs`, `.cjs`, `.jsx` | JavaScript (with JSX) |
| `.vue` | The `<script>` block, as TypeScript when `lang="ts"`, else JavaScript; its lines keep their place in the file |
| `.py` | Python |
| `.java` | Java |
| `.go` | Go |

- **Definitions**: classes, interfaces, type aliases, enums, functions, methods, and module-level variables that hold a function or a class. **References**: calls, `new`, and type references (TypeScript, Java, Go).
- **Imports**: the module name of each import. A relative import of TypeScript, JavaScript or Vue is resolved to a file of the same index (`./x` → `x.ts`, `x.tsx`, `x.js`, `x.vue`, `x/index.ts`, …; `./x.js` also → `x.ts`), and so is a relative Python import. Other imports keep their module name only.
- Other files are not indexed. A new language is a new row here and a new query set with its fixtures.

### 2.4. The store: a schema of its own per project (QUESTIONS #699)

- The index lives in `knowledge-db` (ADR-M89 §2.1), never in the platform's PostgreSQL: a tool's service network reaches it.
- **One schema per project**, `kcode_p<project ID without dashes>`, and one read role `kcode_p<…>_read` (no login) that may read that schema only. So a `read_documents` login cannot read code, and a `read_code` login cannot read documents. The issuer `kdocs_issuer` holds the code read role with the admin option only, as for documents.
- Tables (client content: paths and names; they can be deleted):
  - `index_versions` (`id`, `tenant_id`, `base_sha`, `format`, `created_at`);
  - `files` (`index_id`, `file_id`, `path`, `language`, `content_sha256`);
  - `symbols` (`index_id`, `file_id`, `name`, `kind`, `role` `def` or `ref`, `line`);
  - `imports` (`index_id`, `file_id`, `module`, `target_file_id` or null).
- Rows are not shared between versions (code changes file by file, and an index has no model calls to save). Deleting a version deletes all its rows.
- The store is behind the interface `CodeIndexStore` of `@sdlc/contracts`; `@sdlc/adapter-knowledge-pgvector` implements it as `PgCodeIndexStore`. Both stores share the lifecycle interface `IndexStoreLifecycle` that retention uses.

### 2.5. The platform's record: `knowledge_indexes.kind` (migration 0051)

- `knowledge_indexes` gets the column `kind` (`docs` or `code`, default `docs`, fixed after insert). At most one ready row per tenant, project, base commit, model **and kind**.
- For a code index: `model` is the index format, `tree-sitter-1` (a new format is a new value, so an old index is never read with new rules); `documents` counts the files, `chunks` the symbol rows, `bytes` the bytes parsed.
- `knowledge_index_uses` is unchanged: one row per run and index version, for both kinds.

### 2.6. Building the index

- **When**: in the worker's run preparation, after G4, for each grant with the permission `read_code` (PR 2), like a `read_documents` grant. A ready index of the same base commit, format and kind is reused.
- **What**: the files of §2.3 at the run's `base_sha`, read through the Git host adapter, outside the sandbox. A commit the host lists only in part fails (`tree_truncated`). Paths under `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, `target/`, `__pycache__/` and `*.min.js` are not indexed.
- **Limits** (project configuration `code_index.*`): files, bytes per file, total bytes, symbol rows, parse time per file.
  - More files, more total bytes or more symbols than the limits: the run is cancelled (`tool_unavailable`, the code `too_many_files`, `too_many_bytes` or `too_many_symbols`). A run never gets an index of only part of the code.
  - **A single file** over the bytes limit, or whose parse takes longer than the time limit, is **left out** and counted, and the index goes on. Such files are nearly always generated (bundles, fixtures, lock files). The count is in the worker's log line and in the build result, never a path.
  - All the bytes read, the files left out included, are at most four times `max_total_bytes`; more fails the run (`too_many_bytes`). The host lists no file sizes, so a repository of huge generated files cannot make the build read without end.
  - A path with a control character is not indexed (it cannot be stored). Names and module names lose their control characters and are cut at 256 characters.
  - A syntax error does not stop a file: Tree-sitter returns a tree with error nodes, and the index keeps what it could read.
- The worker yields between files, so a large index does not block the worker's other activities.
- A ready index is reused without checking that its version is still in the store, as for documents (ADR-M89 §2.3): the retention pass marks a row before it deletes the version.

### 2.7. Retention and client data deletion (AC2)

- The retention pass of ADR-M89 §2.4 covers both kinds with the same rules and the same audit action `knowledge.purged` (its payload gets `kind`). It deletes a code version from the code store and a document version from the document store.
- A worker without the store of an index's kind never marks that index: it logs `retention.knowledge_store_absent` and counts a failure. The client data deletion then waits (`client_purge.waiting`) instead of finishing with code left in `knowledge-db`.
- The sweep runs on both stores. An archived project past its grace with no ready version loses both schemas and both read roles.
- The client data deletion (ADR-M97, H03b) deletes both kinds the same way.

### 2.8. The tool (PR 2; QUESTIONS #700)

- A new permission `read_code` in the catalogue of `@sdlc/contracts`, with three tools and their call rules: `find_symbol` (`name` ≤ 200, optional `kind`, `limit` 1–50), `find_references` (`name` ≤ 200, `limit` 1–100), `related_files` (`path` ≤ 1000, `limit` 1–100). The tool checks every argument again; a path is relative, with no `.`, `..`, empty part, backslash or control character; a `kind` is a kind of definition. A tool has `read_code` or `read_documents`, never both (the register and migration 0052).
- `find_symbol` returns exact names first, then names that start with the text (a prefix search, `%` and `_` taken as plain characters); `find_references` takes the exact name; `related_files` returns the files of the same index the file imports and the files that import it.
- A new image `tool-code-index` (`platform/apps/tool-code-index`), built, scanned and pinned like `tool-project-docs` (R089): `pnpm tool-image:build code-index`, both release workflow matrices, the lock job (`SDLC_IMAGE_TOOL_CODE_INDEX`), the release gate, `verify-images.sh` (seven images), `images.sh` and the CI scan. Its runtime files are `config.json` (the index ID, the code schema, the database) and `credentials.json` (the login only: no model key).
- The run's login is **one OpenBao role per run and tool**, `kdocs-<run_id>-code`, whose creation statement grants only the project's code read role. The name matches the connection's `allowed_roles` `kdocs-*` and the worker policy, so no OpenBao change and no upgrade step is needed, and the revocation by the prefix `kdocs-<run_id>` revokes both logins of a run.
- The tool writes its answer log lines as the documents tool does; the runner records them as `knowledge_read` (file IDs and content hashes only, never a path, a name or a query).
- Handbook Ch.13 and Ch.20, the deploy README and runbook T11 describe the tool in PR 2.

## 3. Alternatives not chosen

- **SCIP**: precise, but needs the project's build in a sandbox (§2.1).
- **Native Tree-sitter bindings** (`tree-sitter` on npm): faster, but native code that parses client files in the worker, and an install script (§2.1).
- **Code embeddings first**: model cost and data class limits, and a name search answers the questions of AC1 (§2.2).
- **The code tables in the document schema**: one read role would then open both (§2.4).
- **A new table `code_indexes`**: the same lifecycle twice; one table with `kind` keeps one retention path (§2.5).

## 4. Consequences

- `knowledge-db` holds a second schema per project that uses the code tool; A10 measures its size.
- The worker image carries the WebAssembly grammars (about 5 MB).
- The first index of a large repository takes part of the 5-minute run preparation; the limits keep it inside, and later runs of the same commit reuse it.
- A symbol search by name finds names, not meanings: an agent that searches for an idea still uses `read_documents` or `grep`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-11-12 | Claude Code (task X06 PR 1) | First version, with the answers to QUESTIONS #696–#700 (Harry, 2026-11-12, X06 plan) |
| 0.2 | 2026-11-13 | Claude Code (task X06 PR 2) | §2.8: the call rules, the search order, one index permission per tool (migration 0052), the image and its runtime files |
