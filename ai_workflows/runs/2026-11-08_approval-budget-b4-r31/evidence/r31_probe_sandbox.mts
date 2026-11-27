// R3-1 diagnosis probe (read-only): the real sandbox, a fake high-risk tool that "asks" (waits) and then acts.
process.env['JARVIS_TOOL_BUDGET_HIGH_MS'] = '1500';   // stands in for 15 s
process.env['JARVIS_TOOL_STOP_GRACE_MS'] = '500';     // stands in for 5 s
const { toolExecutionSandbox } = await import('./core/toolExecutionSandbox.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function trial(label: string, answerAfterMs: number, checksSignal: boolean) {
  const t0 = Date.now(); let actedAt: number | undefined;
  const tool: any = { name: 'fake_close', riskLevel: 'high', execute: async (_a: unknown, signal: AbortSignal) => {
    await sleep(answerAfterMs);                         // the owner's answer arrives
    if (checksSignal && signal.aborted) throw new Error('not closed: the request had already ended when the answer came.');
    actedAt = Date.now() - t0;                          // the action happens
    return 'Closed.';
  } };
  const out = await toolExecutionSandbox.run(tool, {});
  const reportedAt = Date.now() - t0;
  await sleep(answerAfterMs + 300);
  console.log(`${label}: reply after ${reportedAt} ms = "${out.slice(0, 90)}"; action ${actedAt === undefined ? 'NOT done' : `done at ${actedAt} ms`}`);
}
await trial('A  browser-style (checks signal), answer at 1.8 s (in the advertised window)', 1800, true);
await trial('B  other controllers (no check),  answer at 1.8 s', 1800, false);
await trial('C  other controllers (no check),  answer at 2.5 s (after JARVIS stopped waiting)', 2500, false);
process.exit(0);
