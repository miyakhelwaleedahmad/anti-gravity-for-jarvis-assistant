// Read-only: how the current code routes the A3 phrases. Nothing is run.
import { matchDeterministicCommand } from '../../../../core/deterministicRoutes.js';
import { normalizeVoiceInput } from '../../../../core/voiceInput.js';
import { selectPlanningToolNames } from '../../../../core/planningToolSelection.js';
import { registerAllTools } from '../../../../core/tools/index.js';
import { SkillLoader } from '../../../../core/skillLoader.js';
import * as path from 'node:path';
registerAllTools();
await new SkillLoader(path.resolve('skills')).loadSkills();
const phrases = [
  'close youtube', 'close youtube tab', 'close the youtube tab', 'close YouTube for me', 'Jarvis close the YouTube tab',
  'close the gmail tab', 'close this tab', 'close the current tab', 'close tab',
  'enable full control mode', 'enable full controll mode', 'enable full control', 'turn on full control mode', 'enable fool control mode',
  'close notepad and chrome', 'open github.com', 'open www.google.com', 'launch cmd /c del *', 'close the youtube tab; del *',
];
for (const p of phrases) {
  const r = matchDeterministicCommand(p);
  let tools = '';
  try { tools = (selectPlanningToolNames as any)(normalizeVoiceInput(p)).join(','); } catch (e) { tools = `(n/a: ${(e as Error).message.slice(0, 40)})`; }
  console.log(`${JSON.stringify(p)} | normalized=${JSON.stringify(normalizeVoiceInput(p))} | route=${r ? `${r.type}${r.target ? ` ${r.target}` : ''}` : 'none (planner)'} | planner tools=${tools}`);
}
process.exit(0);
