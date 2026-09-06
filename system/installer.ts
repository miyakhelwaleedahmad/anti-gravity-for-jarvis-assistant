import { exec } from 'child_process';
import { approvalGate } from '../security/approvalGate.js';

/**
 * Runs npm/pip installs with permission.
 */
export class Installer {
    public async installNpmPackage(packageName: string): Promise<void> {
        const approved = await approvalGate.requestApproval('Install NPM Package', `npm install ${packageName}`);
        if (!approved) {
            console.log(`[Installer] Installation of ${packageName} denied.`);
            return;
        }

        console.log(`[Installer] Installing ${packageName}...`);
        return new Promise((resolve, reject) => {
            exec(`npm install ${packageName}`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[Installer] Error installing ${packageName}:`, stderr);
                    reject(error);
                } else {
                    console.log(`[Installer] Successfully installed ${packageName}.`);
                    resolve();
                }
            });
        });
    }
}

export const installer = new Installer();
