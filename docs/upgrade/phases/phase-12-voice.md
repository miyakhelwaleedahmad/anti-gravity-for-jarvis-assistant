# Phase 12 — Voice integration

## Goal
The new capabilities work by voice through the same pipeline as text; approval
by voice follows the same rules; JARVIS's own speech can never approve.

## Current system context
- Voice: wake word / STT → `orchestrator.process(text, 'voice')` (same as CLI).
- Voice approval: `approvalGate` speaks, `nodeBridge.waitForTextConfirmation`
  accepts confirm, yes, approve, approved, proceed, do it.
- Echo filter compares heard text with `nodeBridge.lastTtsText`.

## Required changes
1. Spoken approval request (short) and answer window from P3.
2. Reject answers that match JARVIS's own recent speech.
3. Spoken summaries for observation results (≤ 3 sentences; details printed).
4. Deterministic voice routes for the new observation questions.

## Implementation steps
1. Spoken form: "Approval needed: {action} {target}. Risk {level}, {reversible
   or not}. Say approve or cancel." Level 4: "This needs typed approval in the
   console." — voice answers ignored.
2. `waitForTextConfirmation`: accepted words per P3; reject text whose words
   are a subset of the last spoken text (echo); window measured from the end
   of JARVIS's speech (`ttsEndedMs`).
3. Summaries: helper per observation tool turning JSON into one to three
   sentences ("Three servers are running: …").
4. Routes: "what's running", "what is open in my browser", "is my backend
   running", "what can you do" — no LLM request.

## Files to inspect
`jarvis.ts` (voice handlers), `bridge/nodeBridge.ts`, `security/approvalGate.ts`,
`core/voiceEchoFilter.ts`, `core/orchestrator.ts`.

## Files that may be modified
`bridge/nodeBridge.ts`, `security/approvalGate.ts`, `core/orchestrator.ts`,
`core/voiceSummaries.ts` (new), tests, docs. `jarvis.ts` only if a handler must
change (protected file; reason recorded).

## Dependencies
P3, P6–P11.

## Tests
`tests/voiceApprovalTest.ts`: simulated STT stream approves within the window;
an echo of JARVIS's request does not approve; level 4 cannot be approved by
voice; voice and CLI give the same decisions for the same calls; observation
routes answer by voice with ≤ 3 sentences and no LLM request.

## Acceptance criteria (here)
All tests. Microphone and speaker checks are in the P14 Windows pack.

## Security requirements
Default deny; echo rejection; no level-4 voice approval.

## Failure conditions
Any voice path approving without the displayed request; any difference between
voice and text decisions.

## Completion requirements
Gate; checklist; PHASE_STATUS; commit `phase-12-voice`; CI green.

## As built (alignment note)
- Voice answers go through `approvalGate.offerVoiceAnswer` (P3), not
  `nodeBridge.waitForTextConfirmation`; `jarvis.ts` needed no change.
- Content-based echo rules: the request heard back is ignored (P3), and
  anything heard while JARVIS speaks or 0.3 s after (P12). A single heard
  "approve" that is also a word of the request is accepted once JARVIS has
  finished: STT results carry no capture time, so JARVIS ends the request on
  "cancel" so that the likeliest echo can only deny.
- Details: [VOICE.md](../VOICE.md).
