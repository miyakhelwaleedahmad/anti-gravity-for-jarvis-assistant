import { messageBus } from '../core/messageBus.js';

export interface WorldState {
    currentUserTask: string;
    activeGoal: string;
    currentProjectPath: string;
    recentActions: string[];
    openErrors: string[];
    runningProcesses: string[];
    currentEnvironmentState: string;
    lastToolUsed: string;
    lastFileEdited: string;
    pendingApprovals: number;
}

/**
 * WorldModel tracks the current state of the environment and simulates outcomes.
 * Refactored to act as the central state tracker for the Jarvis loop.
 */
export class WorldModel {
    public state: WorldState = {
        currentUserTask: 'idle',
        activeGoal: 'none',
        currentProjectPath: process.cwd(),
        recentActions: [],
        openErrors: [],
        runningProcesses: [],
        currentEnvironmentState: 'normal',
        lastToolUsed: 'none',
        lastFileEdited: 'none',
        pendingApprovals: 0
    };

    constructor() {
        // Subscribe to events to update world state
        messageBus.subscribe('TOOL_EXECUTED', (data: any) => {
            this.state.lastToolUsed = data.toolName;
            this.state.recentActions.unshift(`Executed ${data.toolName}`);
            if (this.state.recentActions.length > 10) this.state.recentActions.pop();
            
            if (data.toolName === 'write_file' || data.toolName === 'file.write') {
                this.state.lastFileEdited = data.args?.filePath || 'unknown';
            }
        });

        messageBus.subscribe('AGENT_STATE_CHANGED', (data: any) => {
            if (data.to === 'ERROR') {
                this.state.openErrors.unshift(`State changed to ERROR from ${data.from}`);
                if (this.state.openErrors.length > 5) this.state.openErrors.pop();
            }
        });
        
        messageBus.subscribe('NEW_GOAL' as any, (data: any) => {
            this.state.activeGoal = data.goal;
        });
    }

    public updateTask(task: string) {
        this.state.currentUserTask = task;
    }

    public getStateSummary(): string {
        return JSON.stringify(this.state, null, 2);
    }

    public simulateAction(action: string, context: any): { safe: boolean; outcome: string } {
        console.log(`[WorldModel] Simulating action: ${action}`);
        // Mock simulation
        if (action.includes('rm -rf') || action.includes('format')) {
            return { safe: false, outcome: 'Catastrophic failure' };
        }
        return { safe: true, outcome: 'Expected success' };
    }
}

export const worldModel = new WorldModel();
