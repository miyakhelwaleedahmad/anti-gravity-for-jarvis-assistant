import { systemStateObserver } from '../../perception/systemStateObserver.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const query = String(args['tabNameOrUrl'] ?? '').toLowerCase().trim();
  if (!query) return 'false';
  
  const state = systemStateObserver.getState();
  const tabs = state.chrome?.tabs || [];
  
  const found = tabs.some((tab: any) => 
    (tab.title && tab.title.toLowerCase().includes(query)) ||
    (tab.url && tab.url.toLowerCase().includes(query))
  );
  
  return String(found);
}

export default { execute };
