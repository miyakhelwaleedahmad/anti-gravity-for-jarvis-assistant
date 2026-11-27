/**
 * core/capabilities.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Where a tool can run (phase A5e, audit TRA-09). A tool's catalog entry
 * (core/toolCatalog.ts) lists what it needs; this says whether that is met on
 * this computer, and why not. The planner offers only tools that can run, the
 * registry refuses the others before anything runs, and list_capabilities says
 * which is which.
 *
 * Only the platform is checked (owner's choice Q1): it is known at once, and a
 * tool marked "windows" works only through Windows PowerShell or
 * win_automate.ps1. Chrome starts on demand, and the tools that use it say why
 * when it cannot.
 */

export type Requirement = 'windows';

/** The computer the record is read against, so tests can stand in for it. Nothing else changes it. */
export const capabilityHost = {
  platform: (): NodeJS.Platform => process.platform,
};

/** Why `name` cannot run here, or undefined when it can. */
export function unmetRequirement(name: string, requires?: readonly Requirement[]): string | undefined {
  if (requires?.includes('windows') && capabilityHost.platform() !== 'win32') {
    return `${name} needs Windows, and this computer is not running Windows`;
  }
  return undefined;
}
