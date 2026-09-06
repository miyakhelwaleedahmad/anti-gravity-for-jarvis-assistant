import { execute } from '../skills/automation/skill.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function runCase(target: string) {
  const result = await execute({ target, dryRun: true, source: 'text' });
  return JSON.parse(result);
}

console.log('\n=== open_app Security Dry-Run Tests ===\n');

const allowedCases: Array<[string, string]> = [
  ['youtube', 'https://www.youtube.com'],
  ['https://www.youtube.com', 'https://www.youtube.com'],
  ['google', 'https://www.google.com'],
  ['chrome', 'chrome.exe'],
  ['notepad', 'notepad.exe'],
  ['calculator', 'calc.exe'],
];

for (const [target, expected] of allowedCases) {
  const parsed = await runCase(target);
  ok(`${target} resolves to ${expected}`, parsed.success === true && parsed.resolvedTarget === expected);
}

const rejectedCases = [
  'https://evil.example',
  'www.youtube.com',
  'C:\\Windows\\System32\\cmd.exe',
  '\\\\server\\share\\tool.exe',
  'notepad.exe',
  'script.ps1',
  'youtube & calc',
  'google | whoami',
  'cmd',
];

for (const target of rejectedCases) {
  const parsed = await runCase(target);
  ok(`${target} is rejected`, parsed.success === false);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
