# Releasing

How the platform is versioned and released (D-08 tasks V12 and V15, QUESTIONS #364, #390, #591–#595, #651–#653, `design/ADR-M94-release-on-the-tag.md`, `design/ADR-M104-simpler-release.md`). A release, a tag, an image push and an npm publish are public actions: **only the owner (Harry) starts them**, by merging the version pull request; the tag then comes from `release-tag.yml`, and npm follows without an approval (ADR-M104 1.1). Claude prepares the pull requests and never pushes a tag, creates a release or runs a workflow with `push: true`.

## 1. Versioning policy

| Rule | What it means |
|---|---|
| [Semantic Versioning](https://semver.org/) `X.Y.Z` | One version for the whole repository: the root `package.json`, `PLATFORM_VERSION` (`platform/packages/api-schemas/src/version.ts`, shared by the API, the CLI and the dashboard), the images on GHCR and the npm package `@hoanghainh/governed-adlc` (`agentic-sdlc-cli` up to v0.8.0) |
| Before v1.0 | A **minor** release (`0.2.0`) may break things: a migration, a changed setting, a credentials command to run again. Its "Upgrade notes" say exactly what to do. A **patch** release (`0.1.2`) never needs an upgrade step |
| A patch release `v0.x.y` | When something useful lands and nothing must be done to upgrade (for example v0.1.1: the CLI on npm and `adlc next`) |
| The next minor `v0.x.0` | As soon as a change needs an upgrade step (for example v0.2.0: two migrations and rebuilt images). The roadmap names what goes into which release; the owner decides when to release (QUESTIONS #420) |
| v1.0 | When the platform runs on a team server (milestone Server). From then on only a major release breaks things |
| Support | **The latest release only.** A fix, also a security fix, comes in a new release; older releases get no patches |
| Security advisories | Reported privately ([SECURITY.md](SECURITY.md)); published as a GitHub Security Advisory together with the release that fixes it |
| Tags never move | A tag `vX.Y.Z`, its GitHub Release, its image tags on GHCR and its npm version are never changed or reused. A broken release is fixed by a new one (npm: `npm deprecate`, never unpublish) |

### Upgrade notes

Every CHANGELOG release section from 0.1.1 on has a `### Upgrade notes` list (a test checks it; 0.1.0, the first release, had nothing to upgrade from). It answers, for a running stack:

- the database migrations (`pnpm db:migrate`), or "no migration";
- the credentials commands to run again (`pnpm openbao:bootstrap …-credentials`);
- new, changed or removed settings (`SDLC_*`, project configuration);
- images to pull or rebuild, and the `adlc` command to update (`npm install -g @hoanghainh/governed-adlc@X.Y.Z`).

"No migration, no changed setting, no credentials command to run again." is a valid list.

## 2. How a release is made

The images are built **on the tag**, by the release workflow itself (ADR-M94). The tagged commit holds no lock file: the digests of the images are the asset `images.lock` of the GitHub Release, which is immutable.

| Step | Who | What |
|---|---|---|
| 0. Upgrade notes | Each pull request | A pull request that needs an upgrade step writes its bullet under `[Unreleased]` → `### Upgrade notes` when it is made (ADR-M104 §2.3). The first bullet says what every running stack must do; `pnpm openbao:bootstrap …` commands there are run by the upgrade test |
| 1. Version pull request | Claude, merged by the owner | `pnpm release:prepare X.Y.Z [--tasks O04,O05] [--summary "<one sentence>"]`: it refuses without Upgrade notes under `[Unreleased]`; it sets `package.json` and `PLATFORM_VERSION`, turns `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`, moves the version in the README, TRIAL and USER-GUIDE, marks the tasks done in the backlog and runs the release gate. Then the `CLAUDE.md` state line by hand. Because the version changes, CI runs two more jobs on the pull request: `release-images` builds and scans all seven images on both architectures and pushes nothing (`release-images-scan.yml`), and `upgrade` deploys the last release and upgrades it to this branch with the README "Upgrade" steps and the new Upgrade notes (`pnpm test:upgrade`, QUESTIONS #585). Both must be green |
| 2. Merge | 🧑 owner | Merge the version pull request. That is the release decision |
| 2b. The tag | `release-tag.yml` | On the merge commit: when it changes the version and the version has no tag, it runs the release gate, creates the tag `vX.Y.Z` at that commit through the API, and dispatches `release.yml` on the tag (a tag made with `GITHUB_TOKEN` starts no workflow, a dispatch does; ADR-M104 §2.2). Without this workflow (for example a failed run), the owner tags by hand: `git tag vX.Y.Z <commit> && git push origin vX.Y.Z` |
| 3. The release | `release.yml` | `check`: the release gate and the commit is on `main`. `images`: `release-images.yml` with `push: true` builds and scans all seven images on both architectures, and only then pushes them by digest, scans each pushed digest again, tags, signs and attests them, and writes `images.lock`. `verify-images`: every image's cosign signature and build provenance attestation (signer: `release-images.yml` at `refs/tags/vX.Y.Z`). `release`: the GitHub Release from the CHANGELOG section, as a draft with the asset `images.lock`, then published, then checked to be immutable. `npm`: starts `npm-publish.yml` on the tag |
| 4. npm | `npm-publish.yml` | Refuses a ref that is not a tag `vX.Y.Z` with a published Release; runs the release gate and the image check on the Release's own `images.lock` (job `verify-images`); only then does the job `publish` start, in the environment `npm` (no approval since ADR-M104 1.1). It builds and checks the package and publishes with provenance |
| 5. Check | 🧑 owner | The GitHub Release exists, is marked immutable and has the asset `images.lock`; `npm view @hoanghainh/governed-adlc version` shows `X.Y.Z`; on a clean checkout of the tag `pnpm images mode` prints `published` (it downloads `images.lock` once) |

The release gate is `platform/tools/release/release-check.mjs`. `release-check.mjs tag vX.Y.Z` refuses the tag when:

- the tag is not `vX.Y.Z`, or differs from `package.json` or `PLATFORM_VERSION`;
- the CHANGELOG has no `## [X.Y.Z] - YYYY-MM-DD` section, or its Upgrade notes are missing or empty.

`release-check.mjs lock <file> X.Y.Z` refuses a lock file that is for another version, or does not pin all seven images by digest on `ghcr.io/hoanghainh1188/governed-adlc-fw`. Both workflows run it on the release's `images.lock` (`release.yml` on the artifact of `release-images.yml`, `npm-publish.yml` on the Release's asset).

Both workflows also verify every image with `platform/tools/release/verify-images.sh <images> vX.Y.Z`: a cosign signature and a build provenance attestation whose certificate names exactly `release-images.yml` at `refs/tags/vX.Y.Z`. npm never publishes a release whose images fail this check.

Try the gate before you tag: `node platform/tools/release/release-check.mjs tag vX.Y.Z` on the commit you will tag.

The first release made this way checks two things the documentation does not state clearly (ADR-M94 §2.3): the environment `npm` accepts a run dispatched on the tag, and npm trusted publishing accepts it. Record the result here, in §3.

## 3. When something fails

| Problem | What to do |
|---|---|
| CI's job `release-images` fails on the version pull request (a scan) | Fix it in the same or another pull request before the tag. Nothing was pushed |
| CI's job `upgrade` fails on the version pull request | Fix the Upgrade notes or the cause in the same pull request; do not merge it until the job is green |
| `release-tag.yml` fails before the tag (the gate, a version below the newest tag, the tag ruleset) | Nothing was tagged. Fix the cause (for the ruleset: "Restrict creations" must be off, §4) and re-run the failed job, or tag by hand (§2, step 2b) |
| `release-tag.yml` tagged the version, but `release.yml` did not start | Re-run the failed job: it sees the tag without a release run and starts `release.yml`. Or Actions → **release** → Run workflow, **on the tag** `vX.Y.Z` |
| `release.yml` fails in `check` or in `images` **before any push** (the gate, a scan, a build) | Nothing was released. The owner, as the tag ruleset's bypass actor (§4), deletes the tag (`git push origin :refs/tags/vX.Y.Z`) **only while it has no GitHub Release, no npm version and no image of that version on GHCR**, fixes the cause in a pull request, and tags again |
| `release.yml` fails in `images` **after a push** (for example the scan of a pushed digest, or `publish`) | Release the next patch version. A version already on GHCR is refused (tags never move) |
| `release.yml` fails after `images` succeeded (a network error in `verify-images`, `release` or `npm`) | Re-run the failed jobs: the images are not built again. A draft Release left by a failed run is made again; a published Release is never changed |
| `release` fails with "is not immutable" | The Release is published but not immutable, and npm was not started. Turn on immutable releases (§4); a Release published before that stays changeable, so compare its asset `images.lock` with the artifact `images-lock-X.Y.Z` of the run. Then start npm-publish by hand on the tag (next row) |
| `npm-publish` was not started, or must run again | Actions → **npm-publish** → Run workflow, **on the tag** `vX.Y.Z` (not on `main`): the same checks apply |
| `npm-publish` fails | Fix the cause, then re-run the workflow. A version is never published twice |
| `npm-publish` fails with `ENEEDAUTH` | The trusted publisher on npmjs.com is wrong or **expired**: delete it and add it again (GETTING-STARTED, "Publishing the CLI on npm"), then re-run the failed jobs. If npm refuses a dispatched run (ADR-M94 §2.3): publish this version by hand from the checked tarball (the artifact `governed-adlc-npm`), as for 0.1.1, and add a question to `design/QUESTIONS.md` |
| npm shows the new version as "validating" | Normal for a few minutes after the publish; then it appears (approve it on npmjs.com if it waits as a staged version) |
| A workflow fails while it installs cosign (a network error from GitHub) | `platform/tools/release/install-cosign.sh` already retried for about three minutes: re-run the failed jobs later. A new cosign version changes `COSIGN_VERSION` in the three release workflows and the SHA-256 pins in the script together (a test checks both) |
| A release checkout says it could not download `images.lock` | The machine cannot reach `github.com`: download `images.lock` from the release page elsewhere, copy it to the machine, and set `SDLC_IMAGES_LOCK=<file>` (deploy README) |
| A released version is broken | Release the fix as the next patch version; `npm deprecate @hoanghainh/governed-adlc@X.Y.Z "<reason>"` |

## 4. Repository settings (owner, once)

- **Immutable releases** on (repository Settings → General, section "Releases"), before the first release made on the tag. Then a published Release, its tag and its assets never change (ADR-M94 §2.4). `release.yml` cannot read this setting (it needs admin access), so it checks each published Release instead.
- The environment `npm`: tags `v*` only, **no required reviewer** (ADR-M104 1.1: the merge of the version pull request is the release decision). Remove the reviewer once: Settings → Environments → `npm` → untick "Required reviewers" → Save protection rules. Keep the environment and its name: npm's trusted publisher names it (GETTING-STARTED, "Publishing the CLI on npm").
- A **tag ruleset** for `v*`: nobody may **update** or **delete** a tag, and no force push (the rules "Restrict updates", "Restrict deletions", "Block force pushes"). **Creating** a tag is not restricted (ADR-M104 §2.2): `release-tag.yml` creates the tag of a merged version pull request with `GITHUB_TOKEN`, and a personal repository cannot list GitHub Actions as a bypass actor. Only people with write access and the two workflow jobs with `contents: write` (a test lists them) can create tags; today the owner is the only person with write access. **Before you give anyone else write access, turn "Restrict creations" on again** (and tag by hand, §2 step 2b), or move to a GitHub App of your own as the bypass actor. The owner stays the ruleset's only bypass actor, used for one case only: deleting a refused tag before any GitHub Release, npm publish or image push of it (§3).
- The seven GHCR packages are public. A new image's package starts private: after its first push the owner sets it to public once (v0.6.0: `tool-project-docs`; the release after v0.13.0: `tool-code-index`). The first release after the rename to `governed-adlc-fw` (ADR-M99) pushes all its images under the new path `ghcr.io/hoanghainh1188/governed-adlc-fw/`: set each one to public once.
- The CLI's npm package is `@hoanghainh/governed-adlc` from v0.9.0 (ADR-M100); up to v0.8.0 it was `agentic-sdlc-cli`. **v0.9.0 only:** the new package's first version is published by hand from the checked tarball, then the trusted publisher is added with "Allow npm publish" ticked, then `agentic-sdlc-cli` is deprecated (GETTING-STARTED, "Publishing the CLI on npm", in this order).
- Never rename `npm-publish.yml` or the environment `npm`: npm's trusted publisher names both (ADR-M72 §2.3).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-10 | Claude (task V12), approved by Harry | First version: the versioning policy, the release steps, `release.yml`, the release gate, `pnpm release:lock` |
| 1.1 | 2026-10-12 | Claude, approved by Harry | §3: what the v0.2.0 release taught: cosign installed by `install-cosign.sh` with retries, `ENEEDAUTH` (an expired npm trusted publisher), npm's "validating" state (#308, #309) |
| 1.2 | 2026-10-12 | Claude (docs review for v0.2.0), approved by Harry | §1: the versioning rules in general terms (a patch when nothing must be done, the next minor when an upgrade step is needed); the line "v0.2.0 when the milestone UX is done" removed |
| 1.3 | 2026-10-24 | Claude, for the owner's approval | Six images: `tool-project-docs` (X04 PR 3b, ADR-M89) is in the release gate and in `verify-images.sh`, not only in `release-images.yml`; §4: a new package is set to public after its first push |
| 1.4 | 2026-10-24 | Claude (task O02), approved by Harry | §2 step 1b: the upgrade test from the last release on the version branch before the images (QUESTIONS #585) |
| 2.0 | 2026-10-26 | Claude (task V15), for the owner's approval | The release on the tag (ADR-M94, QUESTIONS #591–#595): three steps for the owner; `release.yml` builds the images and attaches `images.lock` to an immutable Release; npm is dispatched on the tag; no lock file pull request and no `pnpm release:lock` |
| 2.1 | 2026-10-29 | Claude (repository rename, ADR-M99) | §4: the new GHCR packages after the rename start private; the npm trusted publisher names the new repository |
| 3.0 | 2026-10-31 | Claude, approved by Harry | The simpler release (ADR-M104, QUESTIONS #651–#654): the owner merges, nothing else (no `npm` approval since ADR-M104 1.1); each pull request writes its Upgrade notes; `pnpm release:prepare`; the upgrade test runs on the version pull request by itself; `release-tag.yml` tags the merge commit and dispatches `release.yml`; §4: the tag ruleset blocks updates and deletions, not creation |
| 3.1 | 2026-11-13 | Claude Code (task X06 PR 2) | Seven images: `tool-code-index` (the `read_code` tool, ADR-M108) in both workflow matrices, the lock job, the release gate, `verify-images.sh` and `images.sh`; set its GHCR package to public after its first push |
