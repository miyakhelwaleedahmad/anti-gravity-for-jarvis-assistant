/**
 * control/rollbackManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages backup state and undoes actions (like reopened closed tabs/apps,
 * restored files) where feasible.
 */

export interface RollbackPoint {
  id: string;
  actionType: string;
  description: string;
  timestamp: number;
  undo: () => Promise<boolean>;
}

export class RollbackManager {
  private history: RollbackPoint[] = [];
  private readonly MAX_HISTORY = 50;

  public register(actionType: string, description: string, undoFn: () => Promise<boolean>): string {
    const id = `rb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const point: RollbackPoint = {
      id,
      actionType,
      description,
      timestamp: Date.now(),
      undo: undoFn
    };
    
    this.history.push(point);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }
    
    console.log(`[RollbackManager] Registered rollback point: ${id} (${description})`);
    return id;
  }

  public async rollbackLast(): Promise<{ success: boolean; message: string }> {
    const last = this.history.pop();
    if (!last) {
      return { success: false, message: 'No rollback actions available.' };
    }

    try {
      console.log(`[RollbackManager] Attempting to rollback last action: "${last.description}"`);
      const ok = await last.undo();
      if (ok) {
        return { success: true, message: `Successfully rolled back action: "${last.description}"` };
      } else {
        return { success: false, message: `Rollback function reported failure for: "${last.description}"` };
      }
    } catch (err: any) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  public getHistorySummary(): string[] {
    return this.history.map(h => `${h.id}: ${h.description} (${new Date(h.timestamp).toLocaleTimeString()})`);
  }
}

export const rollbackManager = new RollbackManager();
