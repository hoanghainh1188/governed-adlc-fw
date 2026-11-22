# Chapter 1. Executive summary

> Readers: **Leadership** · Reading time: about 10 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.1

---

## 1.1. In short

The company will let AI take part in every stage of software work so that we move faster. In return, everything the AI does must have **a named approver**, **a stored record**, and **a known cost**.

Here, an "AI agent" is an AI assistant that can carry out a whole chain of work by itself: read a requirement, write code, run tests, and submit the code for human review.

---

## 1.2. Why now

**The opportunity**
- [External] According to Google Cloud's DORA 2025 report, about **90%** of software professionals surveyed already use AI at work. If we do not, we fall behind.
- AI writes first drafts very quickly: requirements, designs, code and tests. Understanding the real problem, making decisions and checking the result are still human jobs.
- Japanese clients increasingly ask how we use AI and whether it is safe. A clear, disciplined process is a selling point.

**If everyone uses AI their own way**
- [External] The same DORA 2025 report found that about **30%** of respondents have little or no trust in AI-written code. It also found that AI makes strong teams stronger, but makes weak engineering practices worse.
- [External] Gartner (June 2025) predicts that **more than 40%** of agentic AI projects will be cancelled by the end of 2027, because of rising costs, unclear business value, or weak risk control.
- For our company, the three biggest risks are: **leaking client code or data**, **AI-caused defects reaching the client**, and **AI spending that nobody controls**.

---

## 1.3. What the evidence says about speed

The research does **not** show a simple "AI makes us X% faster". Results depend on the task and the people.

| Study | Setting | Result |
|---|---|---|
| [External] Peng et al. (GitHub / Microsoft, 2023), randomised experiment, 95 developers | One small, well-defined task: build an HTTP server in JavaScript | The group with GitHub Copilot finished **55.8% faster** |
| [External] METR (2025), randomised trial, 16 experienced developers, 246 real tasks | Experts working on large projects they already know well | With AI tools they took **19% longer**. They *believed* they were about 20% faster |
| [External] DORA 2025 (Google Cloud) | Survey of software professionals | About 90% use AI; about 30% have little or no trust in AI-written code; AI strengthens good teams and weakens poor practices |

What this means for us:
- **Gains are real on clear, well-specified tasks.** They can turn into losses on vague tasks or when checking the AI's work takes longer than doing it.
- **People overestimate their own gains.** We must **measure**, not ask how people feel.
- Watch out for the "throughput paradox": people produce more code and more PRs, but no more value reaches production, because review, testing and release become the bottleneck. So we measure **changes that reach production with acceptable quality**, not lines of code or PR counts.

---

## 1.4. Expected benefits

| Benefit | Where it comes from | How we will check it |
|---|---|---|
| Faster delivery of clear, low- and medium-risk work | Agents write code, tests and documents in parallel | Lead time and cycle time per task, before vs after |
| Better documents for Japanese clients | Agents draft specs, ADRs, test reports and bilingual summaries; people check them | Share of documents accepted without major rework |
| Fewer defects reaching the client | Mandatory independent verification (G6) and human merge (G7) | Defects found by the client per release |
| Proof for clients | Every task has a stored record (intent, plan, evidence, approvals, cost) | Evidence Pack complete for 100% of tasks |
| Known and controlled AI cost | Budget per client, task and run; automatic stop | Cost per completed task; no budget overruns |
| A sellable offer later | The same process and platform, offered to clients | Decided after the internal trial |

These are expectations, not promises. The trial (milestone M-E) measures them.

---

## 1.5. Costs

| Cost | What we know today | Still to decide |
|---|---|---|
| **People to build the platform** | Most of the effort. Scope: 40 tasks in the MVP backlog | Headcount and duration (decision 1 in section 1.10) |
| **Person B's review time** | Every project needs an independent reviewer; review load grows with AI output | Who acts as Person B on each project |
| **AI tools for staff** | The company already pays for 1–2 AI tools | Whether to keep, change or extend them (Chapter 2) |
| **Platform infrastructure** | Built from open-source components; runs on one internal server; no licence fees | Server spec, after measuring in milestone M-A |
| **AI usage (tokens)** | [External] Price levers are known: cached input costs about 0.1× the normal price, batch processing is about 50% cheaper (Anthropic price list) | Monthly budget, after 2–4 weeks of trial |
| **GPUs for AI on our own servers** | Only needed for clients who forbid sending data outside | Later, when usage data exists |
| **Training** | Staff must learn to write specs, check AI output and handle incidents, not only to write prompts | Training plan (Chapter 9) |

---

## 1.6. Reference targets

Typical targets rise with maturity (Stage A → B → C). We use them **as a reference only**. Our own targets are set after we measure our starting point.

| Metric | Stage A (pilot) | Stage B | Stage C |
|---|---|---|---|
| Quality-gate pass rate | ≥ 90% | ≥ 95% | ≥ 99% |
| Velocity compared with delivery without AI ("velocity multiplier") | 1.0 | 1.3 | 1.5 or more |
| Share of tasks with AI involvement | ≥ 50% | — | ≥ 75% |
| Change failure rate (warning level) | > 15% | > 15% | > 15% |
| Human approvals logged for every HITL action | 100% | 100% | 100% |


---

## 1.7. What we are building

The **Agentic SDLC Framework** has two parts that work together:

| Part | What it is | Example |
|---|---|---|
| **Handbook** | Rules for people: policies, process, roles, templates | Who may use AI, which data must never go to AI, who approves at each step |
| **Platform** | Internal software that **makes people follow** the handbook | The AI cannot merge its own code; if it goes over budget, it stops automatically |

![6 phases and 8 gates](../../diagrams/svg/d1-overview-6-phases.svg)

- Work moves through **6 phases**: requirements → design → coding → testing → release → operations. Each phase has **mandatory records** (for example the Intent Record at the start and the Release record at the end).
- Along the way there are **8 gates** (checkpoints, G1–G8). How strictly a person checks each gate **depends on the risk of the task**:
 - **Red** — always approved by a person before work continues (G1 intent, G7 merge, G8 production release).
 - **Orange** — depends on risk: a quick look for low-risk work, a full approval for high-risk work (G2, G3, G6).
 - **Blue** — checked automatically; a person steps in only when a limit is breached (G4, G5).
- Every decision is recorded and cannot be changed.

**How we control the AI — two separate questions** (details in Chapter 4):

| Question | Answer |
|---|---|
| **What may the AI do?** | An autonomy level from **L0** (only suggests) to **L4** (acts on important systems by itself). The riskier the task, the lower the level. The pilot stays at L0–L2 |
| **How do people watch it?** | **HITL**: a person must approve before the action happens. **HOTL**: the AI acts, a person watches and can stop it. **AUDIT**: a person checks samples afterwards |

**Team model: "2+N"** (details in Chapter 5): every project has at least **two people in control** — Person A owns and does the work, Person B checks and approves independently — plus **N AI agents**. Nobody, human or AI, approves their own work.

---

## 1.8. Five principles

1. **The AI drafts; people decide.** AI is good at pulling information together, but it cannot take responsibility for a decision.
2. **When something goes wrong, the approver is accountable, not the AI.** Every gate names its approver. The person who made something never approves it.
3. **Give the AI only as much freedom as we can check.** Freedom depends on the risk of the action, not on which AI it is. For very high-risk tasks, the AI may only advise.
4. **Client data stays where it is allowed to be.** If a client does not allow data to leave the company, only AI running on our own servers may be used.
5. **No record, not done.** Every task needs a complete record: requirement, plan, code, test results, approvers, cost.

The full list of core principles (14) is in [0.4 Core principles](../00-introduction/04-core-principles.md).

---

## 1.9. What has been decided

| Topic | Decision |
|---|---|
| Approach | We **build our own** platform, and reuse open-source software for the infrastructure |
| Order | Build the platform first, try it on a sample project, adjust, then try it on a real internal tool |
| Users | Open for everyone (MIT code, CC BY 4.0 documentation); internal use first, with any commercial revenue from services and AI-governed delivery ([POSITIONING.md §7](../../design/POSITIONING.md)) |
| Hosting | Everything self-hosted, on **one internal server** of moderate size |
| AI models | Works with both AI services over the internet (API) and AI running on our own servers. The first stage uses API only |
| Code hosting | GitHub first, GitLab later |
| Key security | Critical keys are split into 3 parts; any 2 people together can open them |
| Record retention | 6 months by default, adjustable per client contract |
| Software licences | Only components that allow commercial use. HashiCorp Vault, MinIO and Redis were rejected because of licence terms or because development has stopped |
| Language | The repo is written in English |
| AI control | Two dimensions: autonomy level L0–L4 + oversight mode HITL / HOTL / AUDIT |
| Team model | 2+N: Person A (owner) + Person B (independent approver) + AI agents |
| Gates | 8 gates kept; how strictly each is checked depends on risk |
| Escalation | Critical 15 minutes, High 1 hour, Medium 1 working day, Low 3 working days |

Platform technical details are in the `design/` folder. For the current platform release and capabilities, see the root [README.md](../../README.md) and [CHANGELOG.md](../../CHANGELOG.md).

---

## 1.10. Decisions still needed from leadership

| # | Decision | When | Suggestion |
|---|---|---|---|
| 1 | **Who builds the platform**: how many people, for how long | Before coding starts | At least one person in charge full-time. Avoid adding client projects to this person at peak times |
| 2 | **Handbook owner** (approves process changes) | As soon as possible | Someone who knows both the process and client expectations |
| 2b | **Who acts as Person B** on each project | Before the first pilot project | A senior person not doing the work on that project |
| 3 | **Three key holders** for the platform's secret store | Before platform milestone M-A | One leadership member, the tech lead, the infrastructure operator |
| 4 | **Monthly AI budget** | After 2–4 weeks of trial use | Decide from real usage data |
| 5 | **Buy GPUs** to run AI on our own servers? | When usage data is available | Not needed yet |
| 6 | **How to charge clients for AI** | Before selling | The platform records cost per client from day one |
| 7 | **Which internal tool** to use for the real trial | Before milestone M-F | Small, with real users, no client data |
| 8 | **Company-wide AI usage policy** | In parallel | See Chapter 2 |

---

## 1.11. Risks and controls

| Risk | Control |
|---|---|
| Leak of client code or data | Classify data when work is accepted. The AI works in an isolated environment. Secret keys are never given to the AI |
| AI-caused defects reaching the client | All 8 gates. Automated tests, human code review, human release approval |
| AI spending out of control | Budgets at 3 levels: per client, per task, per run. The run stops when the budget is used up |
| Process too heavy, people work around it | Checks scale with risk: low-risk work gets light checks. We measure how long people wait at each gate. We adjust after the trial |
| Building the platform takes too much effort | Build only the core; reuse existing software. Work in milestones, each with checkable results |
| Dependence on one AI vendor | All connections go through an intermediate layer. Switching vendor does not mean rewriting |

---

## 1.12. Roadmap

| Milestone | What leadership will see |
|---|---|
| Now | Handbook agreed (Part I first). Coding paused until then |
| M-A → M-D | First working platform: one task goes through all 8 gates with a complete record |
| M-E | Trial on the sample project. A **data report**: time, cost, quality |
| M-F | Adjustments, then a trial on a real internal tool. Leadership **decides whether to expand** |
| After that | Use on client projects (with client consent). Prepare to sell |

Do not commit to dates before the team is confirmed (decision 1 in section 1.10).

---

## 1.13. How we will know it works

| Metric | What it tells us | Source |
|---|---|---|
| Share of AI output accepted as is / edited / rejected | How good the AI's work is | Platform |
| Defects reaching the client | Quality of what we deliver | Defect tracker |
| Waiting time at each gate | Whether the process is too heavy | Platform |
| AI cost per completed task | Whether it is worth the money | Platform |
| Data leaks | **Must always be 0** | Incident log |

- **No targets yet.** We measure the current level during the trial (M-E); then leadership sets targets, using section 1.6 as a reference.

---

## References

**Related documents**
- `design/` folder, D-01 to D-09 (approved 2026-09-24).

**External**
- Peng, Kalliamvakou, Cihon, Demirer (2023), The Impact of AI on Developer Productivity: Evidence from GitHub Copilot: https://arxiv.org/abs/2302.06590
- METR (2025), Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- Anthropic, pricing and prompt caching (see design/D-07 for links)
- DORA, State of AI-assisted Software Development 2025: https://dora.dev/dora-report-2025/
- Google Cloud Blog, Announcing the 2025 DORA Report: https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
- Gartner, over 40% of agentic AI projects will be cancelled by end of 2027 (2025-06-25): https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027

Notes: the Gartner figure is a **forecast**. The Peng study is a vendor study on one small task and is not peer-reviewed. The METR study is small (16 developers) and reflects early-2025 tools.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.1 | 2026-09-24 | Harry | §1.8 links to the full list of core principles (0.4) |
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content (Vietnamese) |
| 0.2 | 2026-09-24 | Claude (draft) | Rewritten in natural Vietnamese |
| 0.3 | 2026-09-24 | Claude (draft) | Translated into English |
| 0.5 | 2026-09-24 | Claude (draft) | Added evidence on speed (1.3), expected benefits (1.4), costs (1.5), reference targets (1.6). Sections renumbered |
| 0.4 | 2026-09-24 | Claude (draft) | Updated to codes v0.4: L0–L4 + HITL/HOTL/AUDIT, 2+N, risk-based gates, references, coding pause. Awaiting Harry's approval |
