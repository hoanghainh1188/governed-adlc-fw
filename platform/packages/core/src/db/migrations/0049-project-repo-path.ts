// Migration 0049: several projects on one repository (task O06 PR 2a; design/D-05 §6.1 version
// 1.67, ADR-M106 §2.4, ADR-M31 §2.5 version 0.6; QUESTIONS #677, #678). Rules for every migration:
// see the header of 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0048 are merged and never
// edited.
//
// - `projects.repo_path`: the project's folder in the repository; empty = the whole repository.
//   A relative path of plain segments, never `.` or `..` (CHECK). The trigger `projects_repo_path`
//   refuses (SQLSTATE SDA28) an active project whose folder equals, contains or is inside the
//   folder of another active project of the same tenant and repository; an empty folder contains
//   every folder. It takes a transaction advisory lock on the tenant and repository first, so two
//   concurrent writes cannot both pass. Rows that existed before stay as they are until changed.
// - `agents.root_instructions_ref`, `agents.root_instructions_sha256`: the second pinned file, the
//   repository root's instruction file (null: none; both or neither, CHECK). Part of the agent's
//   configuration: the trigger of migrations 0008 and 0037 now covers them too (a change only with
//   a new version, while `proposed` or `suspended`).
import { defineMigration } from './define.js';

const REPO_PATH_CHECK = `CHECK (char_length(repo_path) <= 200 AND (repo_path = '' OR (
       repo_path ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'
       AND repo_path !~ '(^|/)[.][.]?(/|$)')))`;

const REF_CHECK = `CHECK ((root_instructions_ref IS NULL) = (root_instructions_sha256 IS NULL)
       AND (root_instructions_sha256 IS NULL OR root_instructions_sha256 ~ '^[0-9a-f]{64}$'))`;

const PROJECTS_REPO_PATH = `CREATE FUNCTION projects_repo_path()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     DECLARE
       other text;
     BEGIN
       IF NEW.status <> 'active' THEN
         RETURN NEW;
       END IF;
       IF TG_OP = 'UPDATE' AND NEW.status = OLD.status
          AND NEW.repo_full_name = OLD.repo_full_name AND NEW.repo_path = OLD.repo_path THEN
         RETURN NEW;
       END IF;
       PERFORM pg_advisory_xact_lock(
         hashtextextended('projects.repo:' || NEW.tenant_id::text || ':' || NEW.repo_full_name, 0));
       SELECT p.repo_path INTO other FROM projects p
        WHERE p.tenant_id = NEW.tenant_id
          AND p.repo_full_name = NEW.repo_full_name
          AND p.status = 'active'
          AND p.id <> NEW.id
          AND (p.repo_path = '' OR NEW.repo_path = ''
               OR p.repo_path = NEW.repo_path
               OR starts_with(NEW.repo_path, p.repo_path || '/')
               OR starts_with(p.repo_path, NEW.repo_path || '/'))
        LIMIT 1;
       IF FOUND THEN
         RAISE EXCEPTION 'project %: its folder overlaps another project of the same repository', NEW.id
           USING ERRCODE = 'SDA28';
       END IF;
       RETURN NEW;
     END $$`;

// The configuration columns of migrations 0008 and 0037, and the two new ones.
const configColumns = (root: boolean): string[] => [
  'model_ref',
  'instructions_ref',
  'instructions_sha256',
  'allowed_tools',
  'max_autonomy',
  'approved_environments',
  'adapter',
  ...(root ? ['root_instructions_ref', 'root_instructions_sha256'] : []),
];

const agentsChanges = (root: boolean) => `CREATE OR REPLACE FUNCTION agents_changes()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status = 'retired' THEN
         RAISE EXCEPTION 'agent %: retired', OLD.id USING ERRCODE = 'SDA09';
       END IF;
       IF NEW.status <> OLD.status AND NOT (
            (OLD.status = 'proposed'    AND NEW.status IN ('active', 'retired'))
         OR (OLD.status = 'active'      AND NEW.status IN ('suspended', 'quarantined', 'retired'))
         OR (OLD.status = 'suspended'   AND NEW.status IN ('active', 'quarantined', 'retired'))
         OR (OLD.status = 'quarantined' AND NEW.status IN ('suspended', 'retired'))) THEN
         RAISE EXCEPTION 'agent %: status % cannot become %', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA09';
       END IF;
       IF NEW.version IS DISTINCT FROM OLD.version
          OR ${configColumns(root)
            .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
            .join('\n          OR ')}
       THEN
         IF OLD.status NOT IN ('proposed', 'suspended') OR NEW.status <> OLD.status
            OR NEW.version = OLD.version THEN
           RAISE EXCEPTION 'agent %: configuration changes need a new version while proposed or suspended',
             OLD.id USING ERRCODE = 'SDA09';
         END IF;
       END IF;
       IF NEW.last_recertified_at IS DISTINCT FROM OLD.last_recertified_at
          AND (NEW.last_recertified_at IS NULL OR NEW.last_recertified_at < OLD.last_recertified_at) THEN
         RAISE EXCEPTION 'agent %: the recertification date never goes back', OLD.id
           USING ERRCODE = 'SDA09';
       END IF;
       RETURN NEW;
     END $$`;

export const migration0049ProjectRepoPath = defineMigration({
  up: [
    `ALTER TABLE projects ADD COLUMN repo_path text NOT NULL DEFAULT ''
       CONSTRAINT projects_repo_path_check ${REPO_PATH_CHECK}`,
    PROJECTS_REPO_PATH,
    `CREATE TRIGGER projects_repo_path BEFORE INSERT OR UPDATE ON projects
       FOR EACH ROW EXECUTE FUNCTION projects_repo_path()`,
    `GRANT UPDATE (repo_path) ON projects TO platform_app`,

    `ALTER TABLE agents ADD COLUMN root_instructions_ref text,
       ADD COLUMN root_instructions_sha256 char(64),
       ADD CONSTRAINT agents_root_instructions_check ${REF_CHECK}`,
    agentsChanges(true),
    `GRANT UPDATE (root_instructions_ref, root_instructions_sha256) ON agents TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `REVOKE UPDATE (root_instructions_ref, root_instructions_sha256) ON agents FROM platform_app`,
    agentsChanges(false),
    `ALTER TABLE agents DROP CONSTRAINT agents_root_instructions_check,
       DROP COLUMN root_instructions_sha256, DROP COLUMN root_instructions_ref`,

    `REVOKE UPDATE (repo_path) ON projects FROM platform_app`,
    `DROP TRIGGER projects_repo_path ON projects`,
    `DROP FUNCTION projects_repo_path()`,
    `ALTER TABLE projects DROP COLUMN repo_path`,
  ],
});
