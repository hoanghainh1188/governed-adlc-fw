# 0.2 Glossary

> Status: **Draft 0.2**, Claude (draft), awaiting approval · Readers: everyone
> ◆ marks an entry added or changed in draft 0.2 (docs review, 2026-10-09), for the handbook authors to approve. Japanese terms of the new entries are suggestions: the BrSE confirms them.
> Codes (P1–P6, G1–G8, L0–L4, HITL/HOTL/AUDIT, risk tiers, PRI, Stage A/B/C) are defined in the [codes table](05-codes.md). This page explains words.
> The Japanese column helps BrSEs talk with clients. Many teams in Japan simply use the English term in katakana; confirm the client's own wording.

---

## A–C

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Acceptance criteria** ◆ | Testable conditions that decide whether a requirement is met. On the platform, G2 counts them in the linked spec (for example under a heading `## 受入基準 / Acceptance criteria`) and passes only with at least one | 受入基準 |
| **ADR (Architecture Decision Record)** | A short record of a significant design decision, the options considered and why one was chosen (template T12) | アーキテクチャ決定記録 (ADR) |
| **Agent (AI agent)** | An AI assistant that can carry out several steps by itself: read, plan, change code, run tests. In this handbook: a tool + a model + instructions + permissions + context sources (Chapter 20) | AIエージェント |
| **Agent branch** ◆ | The branch `agent/INT-…` of one intent. The runner (never the agent) pushes the checked changes there after G5; the pull request comes from it | エージェントブランチ |
| **Agent register** | The list of all agents in use, with owner, version, permissions and status | エージェント台帳 |
| **Agent run** ◆ | One execution of an agent for one intent, from start to stop | エージェント実行 |
| **API token** ◆ | A personal key (`sdlc_pat_…`) to use the `sdlc` command and the dashboard. Valid 90 days by default; never put it in a chat, a ticket or a command line. Different from a model token | APIトークン |
| **AppRole** ◆ | OpenBao's login for a machine process (api, worker, runner…): a fixed role ID plus a secret ID that expires after 90 days. Delivered by the `pnpm openbao:bootstrap <process>-credentials` commands (runbook T11 §5c) | AppRole |
| **Approval** | A decision by a person with authority to let work continue, bound to an exact version | 承認 |
| **Artifact** | Anything produced during the work: a spec, a design, code, a test report, a release package | 成果物 |
| **Audit log** | An append-only record of who (or what) did what, when, and on which evidence. Kept at least 2 years | 監査ログ |
| **Autonomy level** | What an agent is allowed to do (L0–L4) | 自律レベル |
| **Backup owner** ◆ | The person who receives an escalation when its escalation owner does not acknowledge it in time; after the backup owner, governance (Chapter 6) | 代理担当者 |
| **Blast radius** | How much can be affected if something goes wrong | 影響範囲 |
| **Block window** ◆ | After the platform passes a HOTL gate by itself, the time in which a person with the gate's role can still reject it or ask for changes. 4 working hours by default, configurable. No agent run starts while a block window is open | 差し止め可能期間 |
| **Break-glass** | Emergency access outside normal rules: short, limited, approved by a second person, always reviewed (Chapter 6) | 緊急時特権アクセス |
| **BrSE (Bridge System Engineer)** | The engineer who connects the Japanese client and the Vietnamese team | ブリッジSE |
| **Budget (token budget)** ◆ | The maximum AI usage cost allowed for a client, an intent or a run | 予算（トークン予算） |
| **Change flag** ◆ | A label in the plan for a sensitive kind of change: `migration`, `breaking_contract`, `payment`, `personal_data`… Some make G3 a human decision at any risk; some make G7 need two approvals | 変更フラグ |
| **Client data** | Anything a client gives us or that we create for a client | 顧客データ |
| **Comment command** ◆ | A command on the first line of a new comment on the intent's issue or pull request, such as `/approve G3`, `/ack ESC-…` or `/kill`. Editing a comment never changes a decision | コメントコマンド |
| **Containment** | Stopping the damage from spreading: stop traffic, isolate, keep a safe state | 封じ込め |
| **Context** | The information an agent reads to do a task: code, documents, specs | コンテキスト |

## D–H

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Dashboard** ◆ | The platform's read-only web page: intents by gate, who each waits for and why, escalations, cost, gate waiting times, Evidence Packs. It never decides anything | ダッシュボード |
| **Data class** | The sensitivity label that decides where information may go: `public`, `internal`, `client_confidential`, `client_restricted`, `prohibited` (Chapter 2) | データ分類 |
| **Decision packet** | The information a reviewer needs to decide: intent, risk, scope, diff, evidence, cost, rollback plan, agent recommendation | 判断資料 |
| **Default branch** ◆ | The protected main branch of a repository (usually `main`). Specs and plans are read from it; no agent ever pushes to it | デフォルトブランチ |
| **Deferred approval** | An approval that does not stop independent work while it waits (Chapter 19) | 保留型承認 |
| **Escalation** | Handing a decision to a person with independent authority (Chapter 6) | エスカレーション |
| **Escalation code** ◆ | The code of an escalation, such as `ESC-2026-0012`. Each escalation has two clocks from the SLA table (Chapter 6 §6.4): the **acknowledge** clock (someone says "I have it") and the **resolve** clock (someone decides) | エスカレーション番号 |
| **Escalation owner** ◆ | The person who receives an escalation first, chosen by its type (intent, technical, security, policy). Never a producer of the change | エスカレーション担当者 |
| **Evidence** | Machine-readable proof that a check was done: test results, scan reports, approvals | エビデンス |
| **Evidence hold** ◆ | A hold on one intent's evidence (for a dispute, an incident or a client request). Held evidence is never purged | エビデンス保全 |
| **Evidence Pack** ◆ | All evidence for one intent, collected together and sealed at G8 (files kept 180 days by default) | エビデンス一式 |
| **Frozen** ◆ | The state of an intent while an escalation waits for an answer: gate moves, runs, pushes and merges wait; safe actions, such as stopping a run, do not | 凍結 |
| **Gate** ◆ | A decision point that allows, blocks, pauses or escalates work (G1–G8). Different from a step, which does work (Chapter 10). Short names in the guides and the dashboard: G1 Intent, scope, risk · G2 Specification · G3 Plan · G4 Execution boundary · G5 Scope and budget · G6 Verification · G7 Review and merge · G8 Release | ゲート（関門） |
| **Governance** ◆ | Leadership acting on a project (the project role `governance`): exceptions, raising autonomy, escalations nobody else answered, agent approvals at L3 and above | ガバナンス（経営層） |
| **Guardrail** | A rule enforced by the system that keeps an agent within safe limits | ガードレール |
| **Hallucination** | AI output that looks right but is invented or wrong | ハルシネーション |
| **HITL / HOTL / AUDIT** | How people are involved: approve before (HITL), watch and can stop (HOTL), check samples after (AUDIT) | 人間参加型 / 人間監視型 / 事後監査 |

## I–P

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **Incident** | An event that caused, or nearly caused, harm (Chapter 6 §6.7) | インシデント |
| **Intent** ◆ | The goal of one change: purpose, outcomes, constraints, what must not be sacrificed, authority, stop rules. Belongs to people (Chapter 11). On the platform, an intent is the unit that goes through G1–G8: one change to make | 意図（インテント） |
| **Intent code** ◆ | The code of an intent, `INT-YYYY-NNNN` (for example `INT-2026-0007`), unique within a tenant | インテント番号 |
| **Intent owner** ◆ | The person who created the intent and follows it: Person A. Approves G1, never G7 or G8 of that intent | インテント担当者 |
| **Intent Record** | The written intent for a task (template T1) | インテント記録 |
| **Invariant** | A business or technical rule that must always hold | 不変条件 |
| **Iteration cap / time cap** ◆ | The limits of one agent run: at most so many agent steps (30 by default) and so much time (60 minutes by default). The run stops when it reaches either | 反復上限 / 時間上限 |
| **Key share / unseal** ◆ | OpenBao's data is encrypted; after every restart it is sealed. Three people hold one key share each, and any two of them unseal it (runbook T11 §4) | キーシェア／アンシール |
| **Kill switch** ◆ | A way to stop a running agent immediately. On the platform: `adlc run kill` or `/kill`; the run stops and its credentials are revoked within 5 minutes | 緊急停止 |
| **Last known good version** | The most recent version confirmed to work, used as the rollback target (Chapter 18) | 最終正常版 |
| **Loop detection** ◆ | The platform stops a run that repeats the same tool call more than 3 times in a row, or makes no progress within a configured time | ループ検知 |
| **Model** | The AI engine behind a tool (for example a Claude model). Different from the agent that uses it | モデル |
| **Observation window** | Time after release during which we watch for problems before counting a change as production-qualified (2 weeks) | 観察期間 |
| **OTLP** | The OpenTelemetry format in which the platform and LiteLLM send their traces to the collector and Langfuse | OTLP |
| **Operator (platform operator)** ◆ | The person who installs and runs the platform on its server, and uses the `adlc ops` commands there. Not a project role | 運用担当者 |
| **Oversight mode** | How people are involved at a gate or action: HITL, HOTL or AUDIT | 監督方式 |
| **Person A / Person B** | The two people in control of a project in the 2+N model: owner/executor and independent reviewer/approver (Chapter 5) | 担当者A / 承認者B |
| **Plan file** ◆ | The plan of one intent as a YAML file, `.sdlc/plans/<intent code>.yaml` (template T13), on the default branch. It lists the tasks, the files each may change (`allowed_paths`), the tools and the change flags | 計画ファイル |
| **Platform** | Our self-hosted software that enforces the handbook's gates, budgets and records | プラットフォーム |
| **PQC (production-qualified change)** | A change that passed all gates, needed no major rework, and caused no problem during the observation window (Chapter 8) | 本番適格変更 |
| **Producer** ◆ | Anyone who produced a change: the intent's creator, the plan's submitter, the person who allowed a run, the authors of its commits, and the agent. A producer never approves that change at G7 or G8 (the commit authors count at G7 only; the platform's list: [Chapter 15 §15.10.1](../02-playbook/ch15-p5-release.md#producers)) | 作成者 |
| **Project admin** ◆ | A person with the project role `admin`: manages that project's roles and configuration (Chapter 19 §19.8d). Design document D-02 §3 calls this role "platform admin" | プロジェクト管理者 |
| **Project AI record** ◆ | The project's record of the client's consent to AI use: whether AI is allowed, which data classes, the production-logs flag, the disclosure format (template T7). Checked at G1 and G4 | プロジェクトAI利用記録 |
| **Prompt** | An instruction given to an AI model for one task or turn. Different from intent | プロンプト |
| **Prompt injection** | Hidden instructions inside content (tickets, documents, web pages) that try to make the AI do something else | プロンプトインジェクション |
| **Proposal (L1)** ◆ | At High risk (autonomy L1) the agent's changes are kept as a patch in the evidence store, never pushed; Person A decides what to do with it | 提案（L1） |
| **Provenance** | Where an artifact came from: which intent, tool, model, context and people | 来歴 |
| **Pull request (PR)** | A request to merge changes into a protected branch, reviewed at G7 | プルリクエスト |

## R–Z

| Term | Meaning in this handbook | Japanese (reference) |
|---|---|---|
| **2+N team** | Two people in control plus N AI agents (Chapter 5) | 2+N体制 |
| **Raft snapshot** ◆ | A backup file of OpenBao's own storage, taken daily and kept off the server; useless without two key shares (runbook T11 §6) | Raft スナップショット |
| **Reason code** ◆ | A code that says why a gate was rejected or changes were asked for, such as `spec_unclear` or `out_of_scope`. The platform keeps the code and a link to the comment, never the words | 理由コード |
| **Recertification** | The regular check (every 3 months) that an agent is still owned, useful, safe and correctly configured | 再認定 |
| **Release hash / seal** ◆ | At G8 the release approval is bound to the Evidence Pack's release hash (the pack without the G8 parts). When G8 passes, the platform seals one version of the pack: it never changes again | リリースハッシュ / 封印 |
| **Release record** | The record that goes with a release: exact artifact, evidence, approvals, rollback, client disclosure (template T14) | リリース記録 |
| **Remediation record** | The record of a proposed fix in operations: symptom, hypothesis, evidence, action, risk, rollback, verification (template T15) | 対処記録 |
| **Risk tier** | Low, Medium, High or Critical; decides autonomy and oversight | リスク区分 |
| **Rollback** | Returning to the last known good state (Chapter 18) | ロールバック |
| **Root token** | OpenBao's highest-privilege token: made from two key shares only for the initialisation and emergencies, and revoked right after use (runbook T11 §5) | ルートトークン |
| **Run Contract** ◆ | The platform's signed permission for one agent run: scope, tools, budget, expiry | 実行契約 |
| **Sandbox** | An isolated environment where an agent can work without affecting real systems | サンドボックス |
| **Secret ID** ◆ | The part of an AppRole login that expires (90 days); rotated with the credentials commands and never written to a log or a chat | シークレット ID |
| **Second approver** ◆ | A person with the project role `second_approver`: the second approval at G7 for flagged changes and at Critical risk, and at G8 at Critical risk | 第二承認者 |
| **Separation of duties** | The person or agent that produced something never approves it | 職務分掌 |
| **Sidecar** | A helper container that runs next to a service; `litellm-agent` is the sidecar that gives LiteLLM its keys from OpenBao | サイドカー |
| **Specification (spec)** | The testable description of what to build (Chapter 11) | 仕様書 |
| **Sprint 0** | A setup sprint before feature work, to prepare people, rules and agents (Chapter 10) | スプリント0 |
| **Step** | A piece of work in the workflow, such as "run tests". Different from a gate | 作業ステップ |
| **Task plan** | The breakdown of work for agents: files, tools, budget, done criteria, escalation rules (template T13) | タスク計画 |
| **Tenant** ◆ | A client or a unit with its own data on the platform. Every record belongs to one tenant, and nobody sees another tenant's data | テナント |
| **Tenant admin** ◆ | A person who manages a tenant on the platform: projects, users, GitHub accounts, roles, configuration, API tokens, the agent register. Never a gate approver for that reason alone | テナント管理者 |
| **Token** ◆ | The unit AI providers use to count text and charge for usage (a model token). Different from an API token | トークン |
| **Viewer** ◆ | The project role `viewer`: may read, never creates intents and never decides | 閲覧者 |
| **Waiting reason** ◆ | Why an intent does not move, as the platform recorded it (for example a failed G4 check, a block window, a frozen intent). Shown by `adlc intent show` ("Held: …") and the dashboard ("What holds it") | 待機理由 |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content: about 60 terms with Japanese reference terms |
| 0.4 | 2026-10-09 | Claude (draft), awaiting approval | Docs review E3: operator terms (AppRole, key share / unseal, OTLP, Raft snapshot, root token, secret ID, sidecar) |
| 0.3 | 2026-10-09 | Claude (draft), awaiting approval | Docs review fixes: Evidence Pack files are kept 180 days (was "6 months") |
| 0.2 | 2026-10-09 | Claude (draft), awaiting approval | Docs review PR B: 30 new entries for the platform's words (◆); Evidence Pack and Run Contract capitalised; intent is the unit of one change; gate short names; model token vs API token; docs review PR C: **Producer** links to the platform's list (commit authors at G7 only) |
