// Read-only probe (N-PC10): which time/date wordings the fast route answers today,
// and what clock line the planner context carries. Changes nothing.
import { matchDeterministicCommand } from '../../../../core/deterministicRoutes.js';
const asks = [
  'what time is it', 'time', 'what is the time',
  'what  time is this', 'what time is this', "what's the time", 'whats the time', 'tell me the time',
  'can you tell me time', 'can you tell me the time', 'tell me what time is', 'jarvis what time is it',
  'what time is it now', 'current time', 'time now', 'what is the time now',
  "what's the date", 'what is the date today', 'what day is it', 'what is today',
  // must NOT become the time route
  'what time is my meeting', 'set a timer for 5 minutes', 'what time does the shop close',
  'how long until 5 pm', 'remind me at 5 pm', 'time to close youtube',
];
for (const a of asks) {
  const r = matchDeterministicCommand(a);
  console.log(`${JSON.stringify(a).padEnd(34)} -> ${r ? r.type : 'null (planner)'}`);
}
const { unifiedContextBuilder } = await import('../../../../memory/unifiedContextBuilder.js').catch(() => ({} as any));
console.log('\nunifiedContextBuilder export:', typeof unifiedContextBuilder);
console.log('local time now:', new Date().toString());
