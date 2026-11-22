# Chapter 9. Adoption roadmap

> Readers: **leadership** (approval), PM/BrSE, team leads · Reading time: about 15 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.1

---

## 9.1. Purpose

- Show **how the company moves step by step** from today's use of AI tools to governed AI agents on client projects.
- Make each step **safe to stop**: we only move on when the evidence says it works.
- Prepare people, not only tools.

## 9.2. Scope

The whole company: all projects, all roles, the handbook and the platform.

---

## 9.3. Principles

1. **Start small, measure first.** Baseline before change (Chapter 8 §8.10).
2. **Autonomy follows evidence.** Moving up needs data; moving down can happen at any time (Chapter 4 §4.10).
3. **Rules apply from day one.** The handbook's rules (Chapters 2–6) apply to the AI tools we already use today, even before the platform exists.
4. **People first.** Most of the change is in how people work: writing clear intent, checking AI output, deciding.
5. **No dates before people are assigned.** Durations below are typical references, not commitments (Chapter 1 §1.12).

---

## 9.4. Where we are today

| Area | Today |
|---|---|
| AI tools | Claude and GitHub Copilot, paid by the company (Chapter 2) |
| Rules | Handbook Parts I and II approved |
| Platform | Released and trial-ready (see [README.md](../../README.md) and [CHANGELOG.md](../../CHANGELOG.md)) |
| Measurement | No baseline yet |

So we are at **Step 0 → Step 1** below.

---

## 9.5. Five steps


| Step | What it means | Maturity stage | Platform | Typical duration |
|---|---|---|---|---|
| **0. Readiness** | Assess readiness (9.6); approve Part I; start the baseline; set up the project AI record | — | Paused | 2–4 weeks |
| **1. Controlled assistance** | Agents only create branches and PRs; no merge or deploy; sandbox; CI mandatory; basic audit. On client projects: supervised IDE assistants only, with client consent (Chapter 2, Rule 9) | Stage A | Build M-A → M-D, trial M-E on the sample repo | 1–4 weeks (pilot) |
| **2. Governed autonomy** | Risk classification; policy gates; tool control; short-lived credentials; context snapshots; agent registry | Stage A | M-F: adjust, then trial on a real internal tool | 5–12 weeks (expansion) |
| **3. Production-qualified autonomy** | Independent verification; artifact provenance; canary; rollback; human approval by risk; outcome monitoring. First **client projects**, with written client consent | Stage B | Platform used on 2–3 projects | 13–24 weeks (optimisation) |
| **4. Selective automation** | Low risk: automatic completion (L3 for named task types). Medium: supervised. High: human-led. Critical: agent advises only | Stage B → C | Default way of working | 7+ months (scale) |


### Gate between steps

Move to the next step only when **all** are true:

- The scale-gate conditions in Chapter 8 §8.10 hold.
- No Critical AI incident in the last 8 weeks; all High incidents closed.
- The maturity-stage conditions (codes table §6.1) hold for the next stage, where relevant.
- The readiness assessment (9.6) gives **Go** or **Conditional Go** for the teams involved.
- Leadership approves at the monthly review.

---

## 9.6. Readiness assessment

A short self-assessment before a team or project starts using AI agents. Template T17.

| Dimension | Weight | Questions (examples) |
|---|---|---|
| D1 People and skills | 20% | Are Person A and Person B named? Are they trained (9.8)? |
| D2 Governance | 20% | Project AI record filled in? Client consent recorded? Gates and oversight agreed? |
| D3 Technical infrastructure | 15% | CI pipeline, branch protection, secret and dependency scanning in place? |
| D4 Process discipline | 15% | Do specs have acceptance criteria? Are PRs reviewed today? |
| D5 Security posture | 15% | MFA, access review, incident contacts (Chapter 3 checklist)? |
| D6 Knowledge assets | 10% | Are requirements, designs and conventions written down where an agent can read them? |
| D7 Change readiness | 5% | Does the team want to try? Are concerns known? |

**Scoring**: each dimension 1–5 (1 = not ready, 3 = minimum ready, 5 = exemplary). Weighted average gives the overall score.

| Result | Condition | Decision |
|---|---|---|
| Tier 1 | Overall ≥ 3.5 and no dimension below 3.0 | **Go** |
| Tier 2 | Overall ≥ 3.0 and at most one dimension below 3.0 | **Conditional Go**; fix the gap within 4 weeks |
| Tier 3 | Overall below 3.0, or two or more dimensions below 3.0 | **No-Go**; fix and reassess |

One person runs it with the team in **about half a day**. Leadership reviews the result.

---

## 9.7. Choosing pilots

| Criterion | Why |
|---|---|
| Clear scope and acceptance criteria | AI helps most on well-defined work (Chapter 1 §1.3) |
| Low or Medium risk | Pilot autonomy ceiling is L2 |
| Real users, but **no client data** for the first real pilot | Learn safely |
| A named Person A and Person B | 2+N from the start |
| Baseline data available or collectable | Needed to compare |
| One change at a time | Do not change model, process and team together |

Our pilot order (from the platform design): sample repo `pilot-order-inventory` → a real internal tool → the platform repo itself.

### Questions before letting an agent affect production


| Area | Questions |
|---|---|
| Intent | Measurable outcome? Non-goals clear? Who is accountable for the business side? |
| Context | Which sources does the agent see? Are they versioned and authoritative? Can the context be reproduced? |
| Authority | Which identity does the agent use? Do its permissions match the task? Do its credentials expire? |
| Execution | Does the sandbox limit the blast radius? Are tool calls checked by policy? Is there a hard stop? |
| Verification | Is the evidence independent? Do tests check business behaviour? Is the security scan tied to the right artifact? |
| Human | Who approves? Is the approval bound to the reviewed version? Does the reviewer have enough context and time? |
| Operations | Is there a rollback? A kill switch? Who is on call? Are outcomes monitored? |

---

## 9.8. Building skills

Working with agents means **less typing and more specifying, designing, verifying, orchestrating and judging risk**. If people are only trained in prompting, we get surface productivity and weaker engineering skills.

| Audience | Training |
|---|---|
| Everyone | Chapter 2 rules; data classes; reporting incidents; spotting prompt injection |
| Person A | Writing intent and acceptance criteria; task plans; operating agents (budgets, timeouts, alerts); reading provenance; debugging an agent run |
| Person B | Challenging AI output; judging test quality and evidence; threat modelling; saying no; rollback and incident response |
| PM / BrSE | Client AI terms and consent; disclosure to clients; bilingual specs for agents |
| Leadership | Reading the metrics; approving exceptions and autonomy changes |

Each training is short (1–2 hours) and practical, using the sample repo. Target: everyone on a pilot project trained **before** the pilot starts.

---

## 9.9. Communicating the change

| Group | Message |
|---|---|
| Staff | Your role changes: more design, verification and judgement; less routine typing. Nobody is measured on lines of code |
| Team leads | You lead the change on your projects; you decide where AI fits and where it does not |
| Leadership | Gains come from measured, well-specified work; we report real numbers, not promises |
| Clients (via PM/BrSE) | We use AI under written rules, with human approval and full disclosure |


---

## 9.10. When things go backwards


1. **Alert** — an early warning (Chapter 8 §8.7) or an incident.
2. **Targeted reassessment** — re-run the readiness dimensions that are affected.
3. **Remediation** — fix the gap (training, specs, gates, tools).
4. **Monitor for 4 weeks.**
5. **Lower autonomy or step back** if it does not improve (Chapter 4 §4.10).

Stepping back is normal and expected; it is not a failure of the team.

---

## 9.11. Roles and approval points

| What | Who |
|---|---|
| Moving to the next step | Leadership, at the monthly review |
| Readiness assessment | PM or team lead runs it; leadership reviews |
| Pilot selection | Leadership, proposed by PM / tech lead |
| Training plan | Handbook owner |
| Stepping back | Person B or leadership, at any time |

---

## 9.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Moving too fast because of pressure or excitement | Gate between steps; evidence required |
| Staff resistance or fear | Clear messages (9.9); training; involve team leads |
| Skills erode because AI does the routine work | Training focused on verification and design; Person B reviews in depth |
| Platform delay blocks everything | Rules apply to today's tools from Step 1; platform adds enforcement later |
| Pilot results do not generalise | Break results down by task type (Chapter 8); expand by task type, not all at once |

---

## 9.13. References

**Related documents**
- Handbook: codes table §6.1; Chapters 1, 4, 8; template T17; `design/D-02` (platform milestones), `design/D-09` (sample repo).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.1 | 2026-09-24 | Harry | Step 1 aligned with Ch.2 Rule 9 |
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Citation clean-up |
