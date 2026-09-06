import { systemStateObserver } from '../../perception/systemStateObserver.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const appName = String(args['appName'] ?? '').toLowerCase().trim();
  if (!appName) return 'false';
  
  const state = systemStateObserver.getState();
  const openApps = state.openApps || [];
  
  const found = openApps.some((app: any) => 
    (app.name && app.name.toLowerCase().includes(appName)) ||
    (app.windowTitle && app.windowTitle.toLowerCase().includes(appName))
  );
  
  return String(found);
}

export default { execute };
