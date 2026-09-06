import * as vm from 'vm';

/**
 * Runs generated code in an isolated VM context.
 */
export class Sandbox {
    public async runCode(code: string): Promise<any> {
        console.log(`[Sandbox] Running code securely...`);
        return new Promise((resolve, reject) => {
            try {
                // Create a secure sandbox context with limited globals
                const sandboxEnv = {
                    console: {
                        log: (...args: any[]) => console.log('[Sandbox]', ...args),
                        error: (...args: any[]) => console.error('[Sandbox]', ...args)
                    },
                    setTimeout,
                    Math,
                    JSON,
                    Buffer
                };
                
                const context = vm.createContext(sandboxEnv);
                const script = new vm.Script(code);
                
                // Execute with a strict 5 second timeout
                const result = script.runInContext(context, { timeout: 5000 });
                resolve(result);
            } catch (error) {
                console.error('[Sandbox] Code execution failed:', error);
                reject(error);
            }
        });
    }
}

export const sandbox = new Sandbox();
