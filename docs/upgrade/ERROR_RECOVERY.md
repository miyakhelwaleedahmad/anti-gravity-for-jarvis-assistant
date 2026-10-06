# Error recovery

Built in P11 ([prompt](phases/phase-11-error-recovery.md)).

When a step fails and the failure is one JARVIS knows, it repairs the cause
and runs the step once more, instead of repeating it blind or giving up.

## How it works

1. **Look again.** The part of the PC the failed step touched is read again
   at once (world state, P7): browser tools → browser; dev, git and commands →
   development; app and window tools → apps; system tools → system.
2. **Diagnose** (`core/recoveryPlanner.ts`), from the step's error:

   | Failure | Repair | Level |
   |---|---|---|
   | Nothing answers on a local port where JARVIS ran a server (a page refused, `ECONNREFUSED`) | start that server again (`dev start_server`) | 1 |
   | The port is held by a server JARVIS started earlier | stop it (`dev stop_server`), then the step starts the new one | 2 |
   | No tab matches, and what was asked for is an address | open it in a new tab (`browser_tab new`) | 1 |
   | Nothing answers on a port and JARVIS never ran a server there | none: JARVIS asks which project to start | — |
   | The port is used by a program JARVIS did not start | none: JARVIS asks to close it or choose another port | — |
   | A file does not exist | none: JARVIS asks where it is; it never guesses | — |
   | anything else | the existing strategies (retry, other tool, replan) | — |

3. **Repair through the registry.** Each repair is an ordinary tool call:
   the risk engine decides, the approval gate asks when the level needs it —
   with WHY "To finish your request, JARVIS needs to repair this: <failure>"
   — and the tool checks its own effect (P5).
4. **Run the failed step again**, and check it as usual.
5. **Bounded and honest.** At most two repair rounds per request. JARVIS says
   what it repaired ("I started the dev server of web on port 3000 first,
   because nothing answers on port 3000, sir."), or why it stopped: the
   repair was not approved, the safety policy refused it, it failed, or the
   step still fails after two repairs.

A repair never bypasses the risk engine or the approval gate: there is no
other path to run a tool.

## When the user asks (P13)

"Why isn't my application working?" runs the same kind of repair without a
failed step: a diagnosis of the servers JARVIS started, the ports and the
browser tabs, its repairs through the registry, and a second diagnosis to
check them ([SCENARIOS.md](SCENARIOS.md)).

## The planner's own check

Before a plan runs, `core/plannerIntelligence.ts` predicts which steps are
likely to fail, from each tool's recent results. When two steps look likely
to fail, JARVIS plans again and says so: "Part of my plan is likely to fail,
sir: the browser_page_structure step (Historical failure rate: 100%). I'll
plan it again." Before P13 it said "My plan has high-risk steps", which read
like the safety levels for a step that had only failed before.
