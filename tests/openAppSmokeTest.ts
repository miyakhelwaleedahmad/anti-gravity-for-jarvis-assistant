import { execute } from '../skills/automation/skill.js';

const EXPECTED_TARGETS: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  chrome: 'chrome.exe',
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
};

const EXPECTED_REJECTED = new Set(['cmd', 'command prompt']);

async function testOpenApp() {
  const target = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'youtube';
  const live = process.argv.includes('--live');
  const dryRun = !live;
  console.log(`Testing open_app for target: "${target}" (${dryRun ? 'dry-run' : 'live'})`);
  
  try {
    const result = await execute({ target, dryRun, source: 'text' });
    console.log(`Result: ${result}`);
    const parsed = JSON.parse(result);
    if (EXPECTED_REJECTED.has(target.toLowerCase())) {
      if (parsed.success) {
        throw new Error(`Expected "${target}" to be rejected by policy, but it succeeded`);
      }
      console.log(`PASS: open_app safely rejected "${target}" (${parsed.error})`);
      return;
    }

    if (!parsed.success) {
      throw new Error(parsed.error ?? 'open_app returned success=false');
    }

    const expected = EXPECTED_TARGETS[target.toLowerCase()];
    if (expected && parsed.resolvedTarget !== expected) {
      throw new Error(`Resolved target mismatch. Expected "${expected}", got "${parsed.resolvedTarget}"`);
    }

    if (dryRun && parsed.dryRun !== true) {
      throw new Error('Dry-run smoke test did not return dryRun=true');
    }

    console.log(`PASS: open_app resolved "${target}" to "${parsed.resolvedTarget}"`);
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
}

testOpenApp();
