# Voice

Built in P12 ([prompt](phases/phase-12-voice.md)); approval by voice is in
[PERMISSION_MODEL.md](PERMISSION_MODEL.md) ("Answer rules").

Spoken requests go through the same pipeline as typed ones
(`orchestrator.process(text, 'voice')`): the same routes, the same tools, the
same risk engine and approval decisions. Only the way an approval is asked
differs.

## Short spoken answers (`core/voiceSummaries.ts`)

Questions about the PC are answered from real readings, with no LLM request,
in at most three sentences; the full result goes to the console. Page and
window titles are cut short and reduced to plain words.

| Asked | Read from | Example |
|---|---|---|
| "what is open in my browser", "which tabs are open" (also "what is open in chrome"; since P13 also "what is currently open in my browser", "what tabs do I have open") | `browser_state` (P8); the background reading if Chrome cannot be reached | "3 tabs are open, sir. On screen: Shop. The others: Next and Prices." |
| "what is open" | the background reading of windows and apps | "The active window is …, sir. 4 apps open: …. Chrome has 3 tabs open." |
| "what's running" | open apps and the dev ports | "2 apps open, sir: Chrome and Code. One local server is running, sir: port 3000 answers 200." |
| "is my backend running", "what servers are running" | `dev_status` (P6) | "One local server is running, sir: port 3000 answers 200." |
| "system status" | `system_overview` (P6) | one sentence |
| "what can you do" | the tool registry (P1) | two sentences |
| "why isn't my app working", "check why my website isn't working" (P13) | `diagnose_app`, then its repairs and a second look ([SCENARIOS.md](SCENARIOS.md)) | "The web server on port 3000 was stopped by me earlier, so the tab for it shows an error page, connection refused, sir. I started it again and reloaded the tab; it answers now, and the tab shows Web app." |
| "continue what I was doing" (P13) | the recent requests; what is on screen | "Your last request, …, was not finished, sir: it was not approved. Shall I try it again? Say yes or no." |

Log lines and earlier requests are redacted before they are said; a hidden
value is said as "a hidden value".

Before P12, "what is open" and "what is open in chrome" read the raw JSON
result aloud, "what's running" went to the LLM, and "yes" with nothing waiting
answered "Confirmed." (now: "Understood, sir. Nothing is waiting for your
approval.").
