/**
 * OS control: processes, disk, app launching.
 */
import * as os from 'os';
import { execSync } from 'child_process';

export class SystemTool {
    public getProcessList(): string[] {
        console.log('[SystemTool] Fetching process list...');
        try {
            const isWin = os.platform() === 'win32';
            const cmd = isWin ? 'tasklist' : 'ps aux';
            const output = execSync(cmd, { encoding: 'utf-8' });
            return output.split('\n').slice(0, 20); // Top 20 processes
        } catch (err) {
            return [`Failed to list processes: ${err}`];
        }
    }

    public getDiskUsage(): string {
        console.log('[SystemTool] Fetching disk usage...');
        try {
            const isWin = os.platform() === 'win32';
            const cmd = isWin ? 'wmic logicaldisk get size,freespace,caption' : 'df -h';
            return execSync(cmd, { encoding: 'utf-8' }).trim();
        } catch (err) {
            return `Failed to fetch disk usage: ${err}`;
        }
    }
    
    public getSystemInfo(): Record<string, any> {
        return {
            platform: os.platform(),
            cpuUsage: os.loadavg(),
            totalMem: os.totalmem(),
            freeMem: os.freemem(),
            uptime: os.uptime()
        };
    }
}

export const systemTool = new SystemTool();
