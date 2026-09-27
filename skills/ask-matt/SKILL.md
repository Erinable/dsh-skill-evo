---
name: ask-matt
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
---

# Ask Matt

You don't remember every skill, so ask.

A **flow** is a path through the skills. Most paths run along one **main flow**, and two **on-ramps** merge onto it. Everything else is standalone, or a vocabulary layer that runs underneath.

## The main flow: idea → ship

The route most work travels. You have an idea and want it built.

1. **`/grilling`** sharpens the idea by interview. Start here. It branches on its own: **working in a working directory** → it also runs `/domain-modeling`, retaining what it learns in `CONTEXT.md` and ADRs; **no working directory** → pure conversation, nothing written down. Take the first branch whenever a repo is there to write into — the paper trail is what a later run can read.
2. **Branch: can you settle every question in conversation?** If a question needs a runnable answer (state, business logic, a UI you have to see), detour through a prototype, bridged by **`/handoff`** in both directions (a prototype lives in its own directory, which is exactly what `/handoff` is for; see Phase boundaries):
   - **`/handoff`** out, then open a fresh session against that file,
   - **`/prototype`** to answer the question with throwaway code,
   - **`/handoff`** back what you learned, and reference it from the original idea thread.
3. **Branch: is this a multi-session build?**
   - **Yes** → **`/to-spec`** (turn the thread into a spec), then **`/to-tickets`** to split it into tracer-bullet tickets, each declaring its **blocking edges**. On a local tracker that's one file per ticket under `.scratch/<feature>/issues/`, worked blockers-first by hand; on a real tracker the edges become native blocking links, so any ticket whose blockers are done can be grabbed: kick off **`/implement`** per ticket, starting each one from a clean slate (`/clear` in a session; under Multica each ticket is its own issue and its own run, so the slate is clean whether you want it or not). Each ticket is self-contained, so the last one's context is disposable.
   - **No** → **`/implement`** right here, in the same context window — or, under Multica, on this same issue in this same run.

   Either way, **`/implement`** builds each issue by driving **`/tdd`** internally (one red-green slice at a time), then closes out by running **`/code-review`**, a two-axis review (Standards + Spec) of the diff, before committing. Reach for **`/tdd`** on its own when you just want to build a concrete behaviour test-first without a full spec, and **`/code-review`** on its own whenever you want to review a branch or PR against a fixed point.

### What has to land on the issue

Under Multica the unit is **one issue, one run**: the run reaches a terminal state the moment the turn exits, and the next phase starts in a fresh context that can read the issue but not your transcript. So the question is never "how do I avoid breaking context" — the break is compulsory. It is **what did I write down that survives it**.

Anything the next phase needs, put on the issue (body or comment) or in the repo. Anything else is gone when the turn ends, whether or not you reasoned about it well. At minimum:

- **Decisions settled in grilling** — the answer *and* the option it beat. A decision recorded without its alternative gets re-litigated by the next run, because nothing tells it the question was closed on purpose. In a repo, ADRs carry these (see `/domain-modeling`); with no repo, the issue comment is the only record.
- **The spec text itself**, not a summary of it. `/to-spec` produces the artifact `/to-tickets` and `/implement` read; a paraphrase forces both to re-derive it and they will derive it differently.
- **Each ticket's blocking edges**, as native links. The frontier is computed from those edges, so an edge you only held in your head means a ticket gets grabbed before its blocker is done.
- **A prototype's conclusion and its branch name.** The answer is the point, but the branch (`prototype/<name>`) is the primary source behind it — a conclusion with no branch pointer is an assertion nobody can check.
- **Review findings**, each tied to a file and line. `/code-review` only reviews; the fix happens in another run, which can act only on what the comment names.

The **[smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone)** still binds *within* one run: ~150k tokens, past which the model stops reasoning sharply. What changed is the remedy. There is no `/compact` to reach for at a boundary, so a phase that will not fit is a phase that needs splitting into sub-issues, or a piece of work to hand to a subagent and collect inside this same turn. Approaching the zone with the record still only in context is the failure mode — write it down first, then let the turn end.

## On-ramps

A starting situation that generates work, then merges onto the main flow.

- **Bugs and requests piling up** → **`/triage`**. It moves issues through triage roles and produces agent-ready issues, which **`/implement`** later picks up.

  Triage is only for issues **you didn't create**: bug reports, incoming feature requests, anything that arrives raw. Tickets that `/to-tickets` produced are already agent-ready, so **don't triage them**.

- **Something's broken** → **`/diagnosing-bugs`**. For the hard ones: the bug that resists a first glance, the intermittent flake, the regression that crept in between two known-good states. It refuses to theorise until it has a **tight feedback loop** (one command that already goes red on *this* bug), then fixes with a regression test. Its post-mortem hands off to **`/improve-codebase-architecture`** when the real finding is that there's no good seam to lock the bug down.

- **A huge, foggy effort: a greenfield project or a huge feature build, too big for one session** → **`/wayfinder`**, the most cognitively demanding flow here. When the way from here to the destination isn't visible yet, it charts a **shared map** of **decision tickets** on the issue tracker and resolves them one at a time, producing **decisions, not deliverables**, until the fog is pushed back and the way is clear. Where **`/grilling`** sharpens an idea you can hold in one session, wayfinder is for the idea you can't, and it's slower and denser, so save it for exactly that, never a well-scoped feature.

  When the map clears, **it hands off, it doesn't build**: merge onto the main flow at **`/to-spec`**, which collapses the map's linked decisions into a buildable plan, then `/to-tickets` and `/implement` as usual. Looping the map straight into `/implement` skips that collapse and throws the linked detail away, so go straight to `/implement` only when the effort turned out genuinely small.

## Codebase health

Not feature work, just upkeep.

- **`/improve-codebase-architecture`** runs whenever you have a spare moment to keep the codebase good for agents to operate in. It surfaces **deepening opportunities**; picking one _generates an idea_ you can take into the main flow at `/grilling`. It's the survey that finds the candidates; **`/codebase-design`** (below) is the bench you design the chosen one on.

## Vocabulary underneath

Two model-invoked references that run *beneath* the other skills, each the single source of truth for its vocabulary. Reach for them directly when the **words**, not the process, are the problem; or let the skills above pull them in.

- **`/domain-modeling`**: sharpen the project's *domain* language: challenge a fuzzy term, resolve an overloaded word ("account" doing three jobs), record a hard-to-reverse decision as an ADR. It's the active discipline `/grilling` drives, on its with-a-repo branch, to keep `CONTEXT.md` a clean glossary.
- **`/codebase-design`** is the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's *shape*: a lot of behaviour behind a small interface at a clean seam. `/tdd` and `/improve-codebase-architecture` both speak it.

## Phase boundaries

A **phase** is a chunk of work inside a session: the grilling, the implementation, the QA. At the **boundary** between two of them you have five options, and picking between them is the fuzziest decision in this whole map:

- **Continue**: stay put. Costs nothing, loses nothing. **Available under Multica** — within one run this is just carrying on, and it stays the option to rule out first.
- **`/clear`**: empty the window, when nothing here matters to what's next. **No Multica equivalent.** There is no window to empty: the run ends whole. What replaces it is finishing the turn once the record is on the issue — the next run already starts from nothing.
- **`/handoff`** writes a portable markdown file. Narrow: only for a **new harness**, a **new directory**, a **colleague**, or forking a side task **mid-phase**. What it buys is portability. **Available, reshaped**: follow `docs/agents/runtime.md`'s `## Delivering a file` section for delivery.
- **Subagent**: send a tightly-scoped task to its own window and get a report back. **Available under Multica**, and the main lever left. Dispatch in parallel, collect every report **before the turn exits**; one still running when the run ends is orphaned and its work lost.
- **`/compact`** compresses this context and seeds a fresh session with it. **No Multica equivalent.** Nothing carries a compressed summary into the next run — the issue does that job, and only for what you wrote there.

So of the five, two survive intact (Continue, Subagent), one survives with a different delivery (`/handoff`), and two have no operation at all (`/clear`, `/compact`). The tree in [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) still reads correctly for an interactive session; under Multica, read it with those two branches struck out, which collapses the decision to: continue, split into subagents, or end the turn with the record written down.

Read [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) for the ordered tree: the five questions, the reasoning behind each branch, and why the primary-source cost makes **Continue** the one to rule out first. Make the decision **at** a boundary; mid-phase, continue or split the rest into subagents.

## Standalone

Off the main flow entirely.

- **`/grilling`** is the interview itself: rounds, the frontier, facts are the agent's job and decisions are yours. It's step 1 of the main flow, and `/triage`, `/wayfinder` and `/improve-codebase-architecture` all run it internally. It also stands alone off the main flow — sharpening a plan, a design, a piece of writing — where its no-repo branch applies and the shared understanding it reaches is the whole deliverable. Two wrapper skills (`grill-me`, `grill-with-docs`) used to name those branches as separate entry points; they no longer exist, and asking to be "grilled", with or without docs, loads this skill.
- **`/resolving-merge-conflicts`** works an in-progress merge or rebase conflict hunk by hunk, resolving by **intent** traced to each side's primary source rather than by picking lines, then finishes the operation. It never runs `--abort`. Standalone and off every flow: reach for it when you are already mid-conflict.
- **`/prototype`** is a small, throwaway program that answers one design question: does this state model feel right, or what should this UI look like. Throwaway is a constraint on how the code is written, not a promise to destroy it: the answer folds into the real code, and the prototype itself is kept as a **primary source** on a `prototype/<name>` branch out of main, pointed at from the implementation issue. It's the detour in step 2 of the main flow, but reach for it any time a design question is hard to settle on paper.
- **`/research`**: delegate reading legwork to **subagents dispatched in parallel and collected before the turn ends**: they investigate a question against **primary sources**, and you leave a cited Markdown file in the repo. Fan out, then converge — never end the turn with one still reading. The file it produces is something to take *into* the main flow at `/grilling`, since research feeds the thinking rather than replacing it.
- **`/to-questionnaire`** comes in when the thing blocking you isn't in your head or the codebase but in **someone else's**, and it writes them a questionnaire to fill in. It's the inverse of `/grilling`: instead of interviewing you about the subject, it interviews you about the **send** (who it's going to, what you need back) and aims the questions at the gap. What comes back is material for `/grilling` or `/to-spec`.
- **`/wizard`** is for the steps only a **human** can take: provisioning infrastructure, setting up credentials or CI secrets, clicking through an unfamiliar third-party dashboard, running a one-off migration or cutover. It generates an interactive bash script that opens each URL, captures each value, and writes it into `.env` and GitHub secrets, so the procedure stops being something you re-explain to an agent every time. Model-invoked, so the agent reaches for it the moment it hits a wall only you can pass. If the agent could just do it itself, it should; this is for where a human is genuinely in the loop.
- **`/wait-what`** is the corrective for a message that didn't land. Use it mid-conversation, inside any other skill, and the agent re-pitches what it just said with the context you were missing, in plain English, using the `CONTEXT.md` vocabulary. It works after the fact; `/grilling` on its with-a-repo branch is the upfront cure, because a shared language agreed early is what stops the jargon arriving at all.
- **`/teach`**: learn a concept over multiple sessions, using the current directory as a stateful workspace.
- **`/writing-for-agents`** is the reference for writing documents agents consume: skills, AGENTS.md, pointed-at docs.

## Precondition

**`/setup-matt-pocock-skills`**: run before your first engineering flow to configure the issue tracker, triage labels, and doc layout the other skills assume. Custom issue trackers also work.
