// The project file of `adlc admin project apply --file project.yaml` (task V17, QUESTIONS #617):
// a project, its team, the agent to register and the project configuration that differs from the
// defaults. Every object is strict: an unknown key is refused, so a token, a key or a password
// cannot be added to the file by mistake. The file lives outside the application repository.
// Role names, the configuration and the agent's codes are checked by the CLI and the API.
import { z } from 'zod';

/** Largest project file read (the configuration part alone is at most 32 KiB on the API). */
export const PROJECT_FILE_MAX_BYTES = 64 * 1024;

/** The only format of the file today; a later format gets a new number. */
export const PROJECT_FILE_FORMAT = 1;

const label = z.string().trim().min(1).max(200);
const code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const email = z
  .string()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+$/);
/** GitHub's rule for a login: letters, digits and single hyphens, at most 39 characters. */
const githubLogin = z
  .string()
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/);
const repo = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export const projectFileSchema = z.strictObject({
  format: z.literal(PROJECT_FILE_FORMAT),
  project: z.strictObject({
    slug: code,
    name: label,
    repository: repo,
    // O06 (ADR-M106 §2.4): the project's folder in a monorepo; absent = the whole repository.
    folder: z.string().max(200).optional(),
    default_branch: z.string().min(1).max(100).optional(),
  }),
  team: z
    .array(
      z.strictObject({
        email,
        name: label,
        github_login: githubLogin,
        roles: z.array(code).min(1).max(10),
      }),
    )
    .min(1)
    .max(200),
  agent: z
    .strictObject({
      key: code,
      version: code,
      /** The e-mail address of a person in `team`. */
      owner: email,
      model: z.string().min(1).max(128).optional(),
      /** The instructions reference, for example `AGENTS.md@main-1a2b3c`. */
      instructions: z.string().min(1).max(300),
      /** The instructions file to hash, relative to the project file. */
      instructions_file: z.string().min(1).max(1024),
      tools: z.array(code).max(32).optional(),
      max_autonomy: code,
      environments: z.array(code).min(1).max(3),
      adapter: code.optional(),
    })
    .optional(),
  /** The project configuration that differs from the defaults (handbook Ch.19 §19.8d). */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFilePerson = ProjectFile['team'][number];
export type ProjectFileAgent = NonNullable<ProjectFile['agent']>;
