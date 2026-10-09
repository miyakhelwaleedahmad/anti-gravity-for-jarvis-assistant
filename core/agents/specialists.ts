/**
 * core/agents/specialists.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The seven permanent specialists under JARVIS, and the worker roles they may
 * create. These are the only permanent agents; everything else is a temporary
 * worker that exists for one task.
 *
 *   research_agent  browser_agent  pc_agent  coding_agent
 *   github_agent    qa_agent       memory_agent
 *
 * A role's `tools` is the most that kind of agent may ever use; an agent gets
 * the intersection with its parent's scope (permissions.ts), and every call
 * still passes the risk engine and the approval gate. Risk ceilings:
 * research/browser/QA/memory 1, PC/coding 2, GitHub 3 (git push asks for
 * approval). Session control and messaging tools are never given to agents.
 */

import type { AgentManager } from './agentManager.js';
import type { AgentRoleDefinition } from './registry.js';
import {
  RESEARCH_ROLES, architectureResearchAgent, factCheckWorker, githubResearchAgent, projectDeepAnalysisWorker,
  repoCodeAnalysisWorker, repoDiscoveryWorker, researchSpecialist, webResearchAgent,
} from './behaviors/research.js';
import { toolLoopBehavior, type FallbackRule } from './behaviors/toolLoop.js';
import { keywords } from './behaviors/common.js';
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
  { pattern: /status|branch|commit|local|repo/i, tool: 'git_overview', args: () => ({}) },
  { pattern: /find|search|project|repositor/i, tool: 'github_search', args: (t) => ({ ...query(t), sort: 'stars', limit: 5 }) },
];
const QA_RULES: FallbackRule[] = [
  { pattern: /test|build|check|script|lint/i, tool: 'dev_status', args: () => ({}) },
  { pattern: /fail|error|crash|broken/i, tool: 'diagnose_app', args: () => ({}) },
];
const MEMORY_RULES: FallbackRule[] = [
  { pattern: /.*/, tool: 'search_memory', args: (t) => query(t) },
  { pattern: /document|file|notes|pdf/i, tool: 'search_documents', args: (t) => query(t) },
];

function specialist(def: Omit<AgentRoleDefinition, 'permanent' | 'version' | 'canSpawn'> & { canSpawn?: boolean }): AgentRoleDefinition {
  return { ...def, permanent: true, version: V, canSpawn: def.canSpawn ?? def.allowedChildRoles.length > 0 };
}

function worker(def: Omit<AgentRoleDefinition, 'permanent' | 'version' | 'canSpawn'> & { canSpawn?: boolean }): AgentRoleDefinition {
  return { ...def, version: V, canSpawn: def.canSpawn ?? def.allowedChildRoles.length > 0 };
}

const loop = (purpose: string, fallbackRules: FallbackRule[], workerRole?: string): AgentBehavior =>
  toolLoopBehavior({ purpose, fallbackRules, ...(workerRole ? { workerRole } : {}) });

/** GitHub specialist: research questions go through the research flow; repository chores through the tool loop. */
const githubSpecialist: AgentBehavior = {
  run(ctx) {
    return /\b(find|search|best|compare|recommend|alternatives?|which)\b/i.test(ctx.task.description)
      ? githubResearchAgent.run(ctx)
      : loop('You are the GitHub Agent: repositories, branches, commits, pull requests, issues, CI and GitHub research.', GITHUB_RULES).run(ctx);
  },
};

export const SPECIALIST_ROLES: AgentRoleDefinition[] = [
  specialist({
    role: RESEARCH_ROLES.research, name: 'Research Agent',
    description: 'Researches questions on GitHub and the web, compares sources, checks facts and writes a sourced answer.',
    capabilities: ['research', 'web_research', 'github_research', 'fact_verification', 'synthesis', 'source_comparison'],
    supportedTaskTypes: ['research', 'comparison', 'fact_check'],
    tools: ['web_search', 'deep_search', 'github_search', 'github_repo', 'search_memory', 'search_documents'],
    maxRisk: 1,
    allowedChildRoles: [RESEARCH_ROLES.github, RESEARCH_ROLES.web, RESEARCH_ROLES.architecture, RESEARCH_ROLES.factCheck],
    examples: ['Find the best GitHub projects for giving JARVIS browser awareness', 'Compare Playwright and Puppeteer for JARVIS'],
    behavior: researchSpecialist,
  }),
  specialist({
    role: 'browser_agent', name: 'Browser Agent',
    description: 'Reads and navigates the Chrome debugging browser: tabs, page text, page structure, screenshots.',
    capabilities: ['browser', 'page_reading', 'navigation'],
    supportedTaskTypes: ['browse', 'read_page'],
    tools: ['browser_state', 'browser_read_page', 'browser_page_structure', 'get_browser_tabs', 'is_tab_open', 'browser_navigate', 'browser_scroll', 'browser_screenshot', 'browser_tab:new', 'browser_tab:switch', 'control_browser:list', 'control_browser:focus', 'control_browser:open_url'],
    maxRisk: 1, allowedChildRoles: ['browser_page_worker'],
    examples: ['What do my open tabs say about the project deadline?'],
    behavior: loop('You are the Browser Agent: you read and navigate the user\'s Chrome debugging profile.', BROWSER_RULES, 'browser_page_worker'),
  }),
  specialist({
    role: 'pc_agent', name: 'PC Agent',
    description: 'Observes and operates Windows: open apps and windows, system state, focusing and opening apps.',
    capabilities: ['windows', 'apps', 'system_state'],
    supportedTaskTypes: ['observe_pc', 'operate_pc'],
    tools: ['get_system_info', 'get_system_state', 'get_pc_state', 'get_open_apps', 'get_active_window', 'is_app_open', 'system_overview', 'windows_overview', 'ui_elements', 'get_jarvis_service_status', 'open_app', 'control_app:open', 'control_app:focus', 'control_window:focus', 'control_window:minimize', 'control_window:maximize', 'screenshot'],
    maxRisk: 2, allowedChildRoles: ['pc_inspect_worker'],
    examples: ['Which apps are open and which one is using the most memory?'],
    behavior: loop('You are the PC Agent: you observe and operate the user\'s Windows PC.', PC_RULES, 'pc_inspect_worker'),
  }),
  specialist({
    role: 'coding_agent', name: 'Coding Agent',
    description: 'Reads and explains code, checks the project state, git changes and dev scripts; writes files with approval.',
    capabilities: ['coding', 'code_reading', 'code_analysis'],
    supportedTaskTypes: ['explain_code', 'code_review', 'edit_code'],
    tools: ['read_file', 'files:list', 'files:search', 'files:compare', 'explain_code', 'dev_status', 'git:status', 'git:diff', 'git:log', 'git:branches', 'git_overview', 'dev:scripts', 'dev:servers', 'write_file', 'diagnose_app'],
    maxRisk: 2, allowedChildRoles: ['code_analysis_worker'],
    examples: ['Explain what core/orchestrator.ts does'],
    behavior: loop('You are the Coding Agent: you read, explain and (with approval) change code in the user\'s project.', CODING_RULES, 'code_analysis_worker'),
  }),
  specialist({
    role: 'github_agent', name: 'GitHub Agent',
    description: 'Repositories, branches, commits, pull requests, issues, CI and GitHub research. Pushing asks for approval.',
    capabilities: ['github', 'github_research', 'git'],
    supportedTaskTypes: ['github_research', 'git'],
    tools: ['github_search', 'github_repo', 'git:status', 'git:log', 'git:branches', 'git:diff', 'git_overview', 'git:commit', 'git:switch', 'git_push'],
    maxRisk: 3, allowedChildRoles: [RESEARCH_ROLES.discovery, RESEARCH_ROLES.codeAnalysis],
    examples: ['Find TypeScript libraries for Chrome DevTools Protocol'],
    behavior: githubSpecialist,
  }),
  specialist({
    role: 'qa_agent', name: 'QA Agent',
    description: 'Runs and reads the project\'s checks and tests, and diagnoses failures.',
    capabilities: ['testing', 'qa', 'diagnosis'],
    supportedTaskTypes: ['run_tests', 'diagnose'],
    tools: ['dev_status', 'dev:scripts', 'dev:run', 'read_file', 'files:search', 'git:status', 'git:diff', 'diagnose_app'],
    maxRisk: 1, allowedChildRoles: ['test_runner_worker'],
    examples: ['Run the type check and tell me what fails'],
    behavior: loop('You are the QA Agent: you run checks and tests of the user\'s project and explain failures.', QA_RULES, 'test_runner_worker'),
  }),
  specialist({
    role: 'memory_agent', name: 'Memory Agent',
    description: 'Searches JARVIS\'s memory and documents, and stores relations the user asks to keep.',
    capabilities: ['memory', 'knowledge'],
    supportedTaskTypes: ['recall', 'remember'],
    tools: ['search_memory', 'search_documents', 'save_relation', 'ingest_documents'],
    maxRisk: 1, allowedChildRoles: [], canSpawn: false,
    examples: ['What do you remember about my Python project?'],
    behavior: loop('You are the Memory Agent: you search what JARVIS remembers and the user\'s documents.', MEMORY_RULES),
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
