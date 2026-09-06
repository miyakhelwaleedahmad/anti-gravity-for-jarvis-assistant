import { permissionSession } from '../../control/permissionSession.js';

export async function execute(args: Record<string, unknown> = {}): Promise<string> {
  const source = String(args['source'] ?? 'cli');
  permissionSession.deactivateFullControl(`manual_by_${source}`);
  return permissionSession.getStatus();
}

export default { execute };
