/**
 * core/agents/specialists.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The seven permanent specialists under JARVIS, and the worker roles they may
 * create. These are the only permanent agents; everything else is a temporary
 * worker that exists for one task (docs/agents/SEVEN_AGENT_DESIGN.md).
 *
 *   research_agent  Research & Intelligence
 *   coding_agent    Software Engineering & Code Execution (includes GitHub)
 *   browser_agent   Browser & Web Operations
 *   pc_agent        Desktop & System Operations
 *   memory_agent    Memory & Personalization
 *   data_agent      Data & Problem-Solving
 *   qa_agent        Verification, Security & Reliability
 *
 * A role's `tools` is the most that kind of agent may ever use; an agent gets
 * the intersection with its parent's scope (permissions.ts), and every call
 * still passes the risk engine and the approval gate. Risk ceilings: data 0;
 * research, browser, memory, verification 1; desktop 2; engineering 3 (write,
 * commit and push ask for approval). Session control and messaging tools are
 * never given to agents.
 */

import type { AgentManager } from './agentManager.js';
import type { AgentRoleDefinition } from './registry.js';
import {
  RESEARCH_ROLES, architectureResearchAgent, factCheckWorker, githubResearchAgent, projectDeepAnalysisWorker,
  repoCodeAnalysisWorker, repoDiscoveryWorker, researchSpecialist, webResearchAgent,
} from './behaviors/research.js';
import { toolLoopBehavior, type FallbackRule } from './behaviors/toolLoop.js';
import { keywords } from './behaviors/common.js';
import { DATA_WORKER_ROLE, dataSpecialist, dataWorker } from './behaviors/data.js';
import {
  MEMORY_CONSISTENCY_ROLE, MEMORY_RETRIEVAL_ROLE, memoryConsistencyWorker, memoryRetrievalWorker, memorySpecialist,
} from './behaviors/memory.js';
import { EVIDENCE_WORKER_ROLE, evidenceCheckWorker, verifyBehaviorRun } from './behaviors/verify.js';
import type { AgentBehavior } from './registry.js';

const V = '1.0.0';
const query = (task: string) => ({ query: keywords(task, 6).join(' ') || task });

const BROWSER_RULES: FallbackRule[] = [
  { pattern: /tab|browser|chrome|page|site/i, tool: 'browser_state', args: () => ({}) },
  { pattern: /read|text|content|says|article/i, tool: 'browser_read_page', args: () => ({}) },
];
const PC_RULES: FallbackRule[] = [
  { pattern: /window|app|open|running|program/i, tool: 'windows_overview', args: () => ({}) },
  { pattern: /system|cpu|memory|ram|disk|pc|computer/i, tool: 'system_overview', args: () => ({}) },
];
const CODING_RULES: FallbackRule[] = [
  { pattern: /git|branch|commit|change|diff/i, tool: 'git_overview', args: () => ({}) },
  { pattern: /project|build|server|script|code/i, tool: 'dev_status', args: () => ({}) },
];
const GITHUB_RULES: FallbackRule[] = [
  { pattern: /find|search|project|repositor/i, tool: 'github_search', args: (t) => ({ ...query(t), sort: 'stars', limit: 5 }) },
];
const QA_RULES: FallbackRule[] = [
  { pattern: /test|build|check|script|lint/i, tool: 'dev_status', args: () => ({}) },
  { pattern: /fail|error|crash|broken/i, tool: 'diagnose_app', args: () => ({}) },
];
const DIAGNOSTICS_RULES: FallbackRule[] = [
  { pattern: /.*/, tool: 'diagnose_app', args: () => ({}) },
  { pattern: /system|cpu|memory|ram|disk|slow/i, tool: 'system_overview', args: () => ({}) },
];
const DIAGNOSIS = /\b(diagnos\w*|not working|crash\w*|broken|fails?|failing|error|slow|hang\w*|frozen|why)\b/i;

function specialist(def: Omit<AgentRoleDefinition, 'permanent' | 'version' | 'canSpawn'> & { canSpawn?: boolean }): AgentRoleDefinition {
  return { ...def, permanent: true, version: V, canSpawn: def.canSpawn ?? def.allowedChildRoles.length > 0 };
}

function worker(def: Omit<AgentRoleDefinition, 'permanent' | 'version' | 'canSpawn'> & { canSpawn?: boolean }): AgentRoleDefinition {
  return { ...def, version: V, canSpawn: def.canSpawn ?? def.allowedChildRoles.length > 0 };
}

const loop = (purpose: string, fallbackRules: FallbackRule[], workerRole?: string): AgentBehavior =>
  toolLoopBehavior({ purpose, fallbackRules, ...(workerRole ? { workerRole } : {}) });

const ENGINEERING_PURPOSE = 'You are the Software Engineering & Code Execution Agent: you read, explain, test and (with approval) change code '
  + 'in the user\'s project, and handle git and GitHub. Report changed files and test results exactly.';

/**
 * Software Engineering: a request to find GitHub projects goes through the
 * GitHub research flow (it was the GitHub Agent's); everything else through the tool loop.
 */
const engineeringSpecialist: AgentBehavior = {
  run(ctx) {
    return /\b(find|search|best|compare|recommend|alternatives?|which)\b/i.test(ctx.task.description)
      && /\b(git ?hub|repositor(?:y|ies)|repos|librar(?:y|ies)|projects?|packages?|frameworks?)\b/i.test(ctx.task.description)
      ? githubResearchAgent.run(ctx)
      : loop(ENGINEERING_PURPOSE, [...CODING_RULES, ...GITHUB_RULES], 'code_analysis_worker').run(ctx);
  },
};

const DESKTOP_PURPOSE = 'You are the Desktop & System Operations Agent: you observe and operate the user\'s Windows PC and verify each outcome.';

/** Desktop: "why is X not working" goes to diagnostics workers, other parts to inspection workers. */
const desktopSpecialist: AgentBehavior = {
  run(ctx) {
    return DIAGNOSIS.test(ctx.task.description)
      ? loop(DESKTOP_PURPOSE, [...DIAGNOSTICS_RULES, ...PC_RULES], 'system_diagnostics_worker').run(ctx)
      : loop(DESKTOP_PURPOSE, PC_RULES, 'pc_inspect_worker').run(ctx);
  },
};

/** Verification: a result handed over in input.verify is checked by rules; anything else (tests, reviews) by the tool loop. */
const verificationSpecialist: AgentBehavior = {
  run(ctx) {
    return ctx.input['verify']
      ? verifyBehaviorRun(ctx)
      : loop('You are the Verification, Security & Reliability Agent: you check other agents\' results and the project\'s tests independently and report defects; you never change anything.', QA_RULES, 'test_runner_worker').run(ctx);
  },
};

export const SPECIALIST_ROLES: AgentRoleDefinition[] = [
  specialist({
    role: RESEARCH_ROLES.research, name: 'Research & Intelligence Agent',
    description: 'Researches questions on GitHub and the web, compares sources, checks facts and writes a sourced answer.',
    capabilities: ['research', 'web_research', 'github_research', 'fact_verification', 'synthesis', 'source_comparison'],
    supportedTaskTypes: ['research', 'comparison', 'fact_check'],
    tools: ['web_search', 'deep_search', 'news_search', 'youtube_trending', 'github_search', 'github_repo', 'search_memory', 'search_documents'],
    maxRisk: 1,
    allowedChildRoles: [RESEARCH_ROLES.github, RESEARCH_ROLES.web, RESEARCH_ROLES.architecture, RESEARCH_ROLES.factCheck],
    examples: ['Find the best GitHub projects for giving JARVIS browser awareness', 'Compare Playwright and Puppeteer for JARVIS'],
    behavior: researchSpecialist,
  }),
  specialist({
    role: 'browser_agent', name: 'Browser & Web Operations Agent',
    description: 'Reads and navigates the Chrome debugging browser: tabs, page text, page structure, screenshots.',
    capabilities: ['browser', 'page_reading', 'navigation'],
    supportedTaskTypes: ['browse', 'read_page'],
    tools: ['browser_state', 'browser_read_page', 'browser_page_structure', 'get_browser_tabs', 'is_tab_open', 'browser_navigate', 'browser_scroll', 'browser_screenshot', 'browser_tab:new', 'browser_tab:switch', 'control_browser:list', 'control_browser:focus', 'control_browser:open_url', 'youtube_search', 'youtube_play', 'site_search'],
    maxRisk: 1, allowedChildRoles: ['browser_page_worker'],
    examples: ['What do my open tabs say about the project deadline?'],
    behavior: loop('You are the Browser & Web Operations Agent: you read and navigate the user\'s Chrome debugging profile and check that each action happened.', BROWSER_RULES, 'browser_page_worker'),
  }),
  specialist({
    role: 'pc_agent', name: 'Desktop & System Operations Agent',
    description: 'Observes and operates Windows: open apps and windows, system state, focusing and opening apps. Sensitive actions ask for approval.',
    capabilities: ['windows', 'apps', 'system_state'],
    supportedTaskTypes: ['observe_pc', 'operate_pc'],
    tools: ['get_system_info', 'get_system_state', 'get_pc_state', 'get_open_apps', 'get_active_window', 'is_app_open', 'system_overview', 'windows_overview', 'ui_elements', 'get_jarvis_service_status', 'diagnose_app', 'open_app', 'control_app:open', 'control_app:focus', 'control_window:focus', 'control_window:minimize', 'control_window:maximize', 'screenshot'],
    maxRisk: 2, allowedChildRoles: ['pc_inspect_worker', 'system_diagnostics_worker'],
    examples: ['Which apps are open and which one is using the most memory?', 'Why is my local server not working?'],
    behavior: desktopSpecialist,
  }),
  specialist({
    role: 'coding_agent', name: 'Software Engineering & Code Execution Agent',
    description: 'Reads, explains, tests and (with approval) changes code; git and GitHub: branches, commits, pushes, GitHub research. '
      + 'Writing, committing and pushing ask for approval.',
    capabilities: ['coding', 'code_reading', 'code_analysis', 'testing', 'git', 'github', 'github_research'],
    supportedTaskTypes: ['explain_code', 'code_review', 'edit_code', 'run_tests', 'git', 'github_research'],
    tools: ['read_file', 'files:list', 'files:search', 'files:compare', 'explain_code', 'dev_status', 'dev:scripts', 'dev:servers', 'dev:run',
      'git:status', 'git:diff', 'git:log', 'git:branches', 'git:commit', 'git:switch', 'git_overview', 'git_push',
      'github_search', 'github_repo', 'write_file', 'diagnose_app'],
    maxRisk: 3, allowedChildRoles: ['code_analysis_worker', 'test_runner_worker', RESEARCH_ROLES.discovery, RESEARCH_ROLES.codeAnalysis],
    examples: ['Explain what core/orchestrator.ts does', 'Find TypeScript libraries for Chrome DevTools Protocol', 'What changed in git recently?'],
    behavior: engineeringSpecialist,
  }),
  specialist({
    role: 'data_agent', name: 'Data & Problem-Solving Agent',
    description: 'Exact calculations, statistics, comparisons and log analysis; splits independent analyses across workers and combines them.',
    capabilities: ['data_analysis', 'calculation', 'comparison', 'log_analysis'],
    supportedTaskTypes: ['calculate', 'analyze_data', 'compare', 'analyze_logs'],
    tools: ['data_tools', 'read_file', 'files:search'],
    maxRisk: 0, allowedChildRoles: [DATA_WORKER_ROLE],
    examples: ['What is the average of 12, 15, 19 and 30?', 'Summarise the errors in this log'],
    behavior: dataSpecialist,
  }),
  specialist({
    role: 'qa_agent', name: 'Verification, Security & Reliability Agent',
    description: 'Independently checks results, evidence and code changes: runs checks and tests, reviews diffs, reports defects. '
      + 'It cannot approve actions or change anything.',
    capabilities: ['verification', 'testing', 'qa', 'diagnosis', 'security_review'],
    supportedTaskTypes: ['verify', 'run_tests', 'diagnose', 'review'],
    tools: ['dev_status', 'dev:scripts', 'dev:run', 'read_file', 'files:search', 'git:status', 'git:diff', 'diagnose_app', 'github_repo', 'web_search'],
    maxRisk: 1, allowedChildRoles: ['test_runner_worker', EVIDENCE_WORKER_ROLE],
    examples: ['Run the type check and tell me what fails', 'Check the sources behind this research result'],
    behavior: verificationSpecialist,
  }),
  specialist({
    role: 'memory_agent', name: 'Memory & Personalization Agent',
    description: 'Searches JARVIS\'s memory and documents, and stores what the user asks to keep after checking it is not already known.',
    capabilities: ['memory', 'knowledge', 'personalization'],
    supportedTaskTypes: ['recall', 'remember'],
    tools: ['search_memory', 'search_documents', 'save_relation', 'ingest_documents'],
    maxRisk: 1, allowedChildRoles: [MEMORY_RETRIEVAL_ROLE, MEMORY_CONSISTENCY_ROLE],
    examples: ['What do you remember about my Python project?', 'Remember that my exam is on Friday'],
    behavior: memorySpecialist,
  }),
];

export const WORKER_ROLES: AgentRoleDefinition[] = [
  worker({
    role: RESEARCH_ROLES.github, name: 'GitHub Research Agent', description: 'Finds and ranks GitHub projects for a question.',
    capabilities: ['github_research', 'code_analysis'], supportedTaskTypes: [], tools: ['github_search', 'github_repo'], maxRisk: 1,
    allowedChildRoles: [RESEARCH_ROLES.discovery, RESEARCH_ROLES.codeAnalysis], behavior: githubResearchAgent,
  }),
  worker({
    role: RESEARCH_ROLES.web, name: 'Web Research Agent', description: 'Searches the web for articles, docs and comparisons.',
    capabilities: ['web_research'], supportedTaskTypes: [], tools: ['web_search', 'deep_search'], maxRisk: 1, allowedChildRoles: [], behavior: webResearchAgent,
  }),
  worker({
    role: RESEARCH_ROLES.architecture, name: 'Architecture Research Agent', description: 'Judges how each candidate fits JARVIS, as candidates are found.',
    capabilities: ['architecture_review'], supportedTaskTypes: [], tools: [], maxRisk: 0, allowedChildRoles: [], behavior: architectureResearchAgent,
  }),
  worker({
    role: RESEARCH_ROLES.discovery, name: 'Repository Discovery Worker', description: 'Searches GitHub for candidate repositories.',
    capabilities: ['github_search'], supportedTaskTypes: [], tools: ['github_search'], maxRisk: 1, allowedChildRoles: [], behavior: repoDiscoveryWorker,
  }),
  worker({
    role: RESEARCH_ROLES.codeAnalysis, name: 'Repository Code Analysis Worker', description: 'Ranks discovered repositories and sends the leading one for a deep look.',
    // Holds github_repo only to hand it to its Deep Analysis child (a child's tools come from its parent).
    capabilities: ['code_analysis', 'ranking'], supportedTaskTypes: [], tools: ['github_repo'], maxRisk: 1,
    allowedChildRoles: [RESEARCH_ROLES.deepAnalysis], canSpawn: true, behavior: repoCodeAnalysisWorker,
  }),
  worker({
    role: RESEARCH_ROLES.deepAnalysis, name: 'Project Deep Analysis Worker', description: 'Reads one repository\'s README, files and licence.',
    capabilities: ['repo_reading', 'code_analysis'], supportedTaskTypes: [], tools: ['github_repo'], maxRisk: 1, allowedChildRoles: [], behavior: projectDeepAnalysisWorker,
  }),
  worker({
    role: RESEARCH_ROLES.factCheck, name: 'Fact Check Worker', description: 'Checks a disputed claim at its most reliable source.',
    capabilities: ['fact_verification'], supportedTaskTypes: [], tools: ['github_repo', 'web_search'], maxRisk: 1, allowedChildRoles: [], behavior: factCheckWorker,
  }),
  worker({
    role: 'browser_page_worker', name: 'Browser Page Worker', description: 'Reads one page or tab.',
    capabilities: ['page_reading'], supportedTaskTypes: [], tools: ['browser_state', 'browser_read_page', 'browser_page_structure'], maxRisk: 0, allowedChildRoles: [],
    behavior: loop('You read one browser page or tab and report what it says.', BROWSER_RULES),
  }),
  worker({
    role: 'pc_inspect_worker', name: 'PC Inspection Worker', description: 'Looks at one part of the PC\'s state.',
    capabilities: ['system_state'], supportedTaskTypes: [], tools: ['get_system_info', 'get_open_apps', 'get_active_window', 'system_overview', 'windows_overview'], maxRisk: 0, allowedChildRoles: [],
    behavior: loop('You inspect one part of the PC\'s state and report it.', PC_RULES),
  }),
  worker({
    role: 'code_analysis_worker', name: 'Code Analysis Worker', description: 'Reads and explains one part of the code.',
    capabilities: ['code_reading'], supportedTaskTypes: [], tools: ['read_file', 'files:list', 'files:search', 'explain_code'], maxRisk: 0, allowedChildRoles: [],
    behavior: loop('You read one part of the code and explain it.', CODING_RULES),
  }),
  worker({
    role: 'system_diagnostics_worker', name: 'System Diagnostics Worker', description: 'Finds why one app, server or part of the PC is not working; proposes repairs, runs none.',
    capabilities: ['diagnosis', 'system_state'], supportedTaskTypes: [], tools: ['diagnose_app', 'system_overview', 'get_system_info', 'get_jarvis_service_status'], maxRisk: 0, allowedChildRoles: [],
    behavior: loop('You find out why one thing on the PC is not working and report the cause and the proposed repair. You change nothing.', DIAGNOSTICS_RULES),
  }),
  worker({
    role: EVIDENCE_WORKER_ROLE, name: 'Evidence Check Worker', description: 'Re-reads one cited source and compares it with the answer.',
    capabilities: ['fact_verification'], supportedTaskTypes: [], tools: ['github_repo'], maxRisk: 1, allowedChildRoles: [], behavior: evidenceCheckWorker,
  }),
  worker({
    role: MEMORY_RETRIEVAL_ROLE, name: 'Memory Retrieval Worker', description: 'Searches memory or documents for one thing.',
    capabilities: ['memory'], supportedTaskTypes: [], tools: ['search_memory', 'search_documents'], maxRisk: 0, allowedChildRoles: [], behavior: memoryRetrievalWorker,
  }),
  worker({
    role: MEMORY_CONSISTENCY_ROLE, name: 'Memory Consistency Worker', description: 'Checks a new fact against memory: ADD, UPDATE or NONE. Never writes.',
    capabilities: ['memory'], supportedTaskTypes: [], tools: ['search_memory'], maxRisk: 0, allowedChildRoles: [], behavior: memoryConsistencyWorker,
  }),
  worker({
    role: DATA_WORKER_ROLE, name: 'Data Analysis Worker', description: 'Does one calculation or analysis.',
    capabilities: ['calculation', 'data_analysis'], supportedTaskTypes: [], tools: ['data_tools'], maxRisk: 0, allowedChildRoles: [],
    behavior: dataWorker,
  }),
  worker({
    role: 'test_runner_worker', name: 'Test Runner Worker', description: 'Runs one check or test script.',
    capabilities: ['testing'], supportedTaskTypes: [], tools: ['dev_status', 'dev:run'], maxRisk: 1, allowedChildRoles: [],
    behavior: loop('You run one check or test of the project and report the result.', QA_RULES),
  }),
];

/** Defines every specialist and worker role on the manager (idempotent per manager). */
export function registerAgentRoles(manager: AgentManager): void {
  for (const def of [...WORKER_ROLES, ...SPECIALIST_ROLES]) {
    if (!manager.registry.hasRole(def.role)) manager.defineRole(def);
  }
}
