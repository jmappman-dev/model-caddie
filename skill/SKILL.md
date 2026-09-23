---
name: model-caddie
description: >
  Picks the cheapest model that can handle a task, and the right kind of model
  for it (live web research, very large inputs, or an independent reviewer),
  using a deterministic rule set with no model call. Use when the user says
  "/model-caddie", "route this", "which model should handle this", before
  handing work to a subagent, or before any code, security, or spec review.
---

# model-caddie

Deterministic task routing. The classifier reads the task text, picks a lane
and tier, says which rule decided it, and flags when a review needs a second,
independent model. Logs every decision.

## Setup (once)

1. Clone the repo somewhere stable, for example `~/tools/model-caddie`.
2. Copy this `skill/` folder to `~/.claude/skills/model-caddie/`.
3. Replace `<CADDIE_DIR>` below with the clone's absolute path.
4. Optional: set the API key env vars for the lanes you want (see the repo's
   `.env.example`), then run `node <CADDIE_DIR>/bin/model-caddie.js --check-config`.

## Procedure

1. Run the classifier and log the decision:
   `node "<CADDIE_DIR>/bin/model-caddie.js" "<task text>" --log`
2. State the route in one line (lane, tier, model, rule) so the user can
   redirect, then dispatch.
3. Dispatch by lane:
   - **primary**: in Claude Code, spawn a subagent with the Agent tool's
     `model` override matching the tier (light = haiku, standard = sonnet,
     strong = opus, frontier = the top tier your plan offers). If the session
     already runs that model and the task is small, do it inline.
   - **research**: send the question to the configured research provider (for
     example a Perplexity MCP server or API). Verify any figure against its
     primary source before presenting it as fact.
   - **large-context**: send the bulk input to the configured large-context
     provider for extraction or summary. Keep the synthesis in the primary lane.
   - **reviewer**: run the configured reviewer (for example the Codex CLI).
   - **consensus**: run every leg listed in `legs`, then reconcile in the
     primary lane.
4. **If the decision has a `reviewPass`, it is required, not optional.**
   - The primary lane does the review and records its findings.
   - Run the named `reviewer` on the same material, independently.
   - Send findings the two disagree on to the `tieBreaker`; its read decides.
   - If `reviewer` is null, tell the user a second pass is still required and
     must be done by hand or with another model.
   - Fix only the findings that survive, and say that the independent pass ran.
5. If the route is clearly wrong for the task (keyword rules have limits),
   override it with judgment, re-run the CLI with clearer wording so the log
   stays honest, and tell the user about the disagreement.

## Guardrails

- The router picks a model; it never calls one, and never reads key values.
- A task the user declined a lane for ("don't use gemini") never goes to that
  lane, whatever later rule would have matched.
- A `sensitive-data signal` note is advisory: remove personal or client data
  before an outside lane sees it.
- The primary lane writes the final answer, whichever lane did the work.
