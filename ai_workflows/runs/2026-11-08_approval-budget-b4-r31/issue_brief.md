# Issue Brief — approval wait inside a tool's budget (B4 R3-1)

Found in A2's review (R3-1) and recorded under B4. Seen on the owner's PC on 2026-11-07 at `7ea2d3a`, during the B2 check: "close the browser" asked for approval at 20:55:21; JARVIS said the question until 20:55:39; the owner typed "approve" then, inside the advertised window; the tool had already used its 15 s budget (`control_browser finished after its 15000 ms budget`), and JARVIS refused: "JARVIS's Chrome was not closed: the request had already ended when the answer came."

The owner asked for a read-only diagnosis (Gate 0) on 2026-11-08 and approved the plan (Gate 1) the same day.

Base commit: `7ea2d3a`.
