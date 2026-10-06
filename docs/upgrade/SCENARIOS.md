# Scenarios

Built in P13 ([prompt](phases/phase-13-integration.md)). The six end-to-end
requests of the specification, as JARVIS handles them now, and as
`tests/scenarioIntegrationTest.ts` checks them: through the real orchestrator,
with a real headless Chromium, real servers that JARVIS starts, a real git
repository and a scripted model (`tests/scenarios/harness.ts`).

## The six requests

| Request | Read from | What JARVIS may do | LLM requests (test) |
|---|---|---|---|
| "What is currently open in my browser?" | `browser_state` | nothing | 0 |
| "Is my backend running?" | `dev_status` | nothing | 0 |
| "Why isn't my application working?" | `diagnose_app` | start again a server it started (level 1); stop one that runs but does not answer first (level 2) | 0 |
| "Continue what I was doing." | recent requests; `browser_state` and `get_active_window` when unsure | after "yes": the earlier request, again | 0 (the earlier request: 2) |
| "Check why my website isn't working." | `diagnose_app` | start the server again (1), reload the tab that showed the error (1) | 0 |
| "Delete my Downloads folder." | — | nothing without the typed code | 1 per attempt |

The free tier allows about 20 requests a day per model, so the five questions
cost nothing; a request the planner must plan costs one or two.

## Diagnosis (`diagnose_app`, `core/diagnosis.ts`)

Level 0. It reads:

- the servers JARVIS started this session: running or not, and how one ended
  — by itself (exit code), from outside (a signal), or stopped by JARVIS —
  with its last error line from the output, redacted;
- their ports and the development ports (`JARVIS_DEV_PORTS`): open, and the
  HTTP status of `/`;
- the browser's tabs: Chrome's error page and its code
  (`ERR_CONNECTION_REFUSED`…), and the HTTP status of each page's last load,
  from the browser's own record (nothing is requested again).

| Found | Proposed repair |
|---|---|
| A server JARVIS started has stopped | start it again (`dev start_server`, level 1), then reload a tab that showed an error for it (`browser_navigate reload`, level 1) |
| It runs but does not answer on its port | stop it (`dev stop_server`, level 2) and start it again |
| It answers with HTTP 500 or more | none: "That needs a fix in the code; I changed nothing." |
| Its port is now held by a program JARVIS did not start | none: reported |
| A tab shows an error for a local port JARVIS never served | none: JARVIS asks which project to start, naming the ones it can |
| A tab cannot reach a site on the internet | none: "Check the address and the internet connection." |
| Nothing found | "I see no fault, sir: …. What looks wrong?" |

The orchestrator runs the repairs through the registry, so the risk engine
and the approval gate decide as for any call; an approval shows WHY "To get
your application working, JARVIS needs to repair this: …". Then it runs the
diagnosis again, and the reply says what that second look found: "The api
server on port 3001 stopped by itself, exit code 1, sir; its last line was:
Error, lost the connection to the database, DB PASSWORD a hidden value. I
started it again; it answers now."

Phrasings taken without the planner: "why isn't my app/application/website/
site/backend/server working", "check why my website isn't working", "my site
is down", "what's wrong with my app", "fix my app", "is my website working".
For other phrasings that say something is broken, the planner is offered
`diagnose_app`.

## Continue what I was doing

- The newest request, if it is less than 12 hours old and did not finish
  (anything but completed or cancelled), is named with the reason: "Your last
  request, Stop my web server, was not finished, sir: it was not approved.
  Shall I try it again? Say yes or no."
- "yes" (also "yes please", "yeah", "yep", "go ahead", "try again") as the
  very next request, within a minute, runs the earlier request as a new
  request: planned again, every step through the risk engine, every approval
  asked again. The "yes" approves nothing by itself. "no" leaves it; any
  other request drops the offer.
- Otherwise JARVIS asks: "Your last request, …, is done, sir. On screen is
  Shop - Home. What would you like to continue?"

## The dangerous request

"Delete my Downloads folder." as a `files` call is refused outright (a whole
approved folder is never deleted, moved or renamed). As a `control_file`
call it is level 4: the request shows a code, voice cannot approve it, a
spoken or typed "yes" is not the code, and no answer within 30 s cancels it.
In the test, HOME points at a temporary folder, and the tools are replaced by
recorders that act on nothing; none of them was reached.

## Secrets

Every request the scripted model received was captured after the model
router's redaction, which is what a real provider receives. A tab title with
a GitHub-shaped token, a server log line with `DB_PASSWORD=…` and a `.env`
file with an AWS-shaped key were planted; none reached a request or anything
JARVIS said.

## Not verified here

The owner's Windows PC, Chrome profile and projects (P14).
