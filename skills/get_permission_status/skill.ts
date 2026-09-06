import { permissionSession } from '../../control/permissionSession.js';

export async function execute(): Promise<string> {
  const remaining = permissionSession.getRemainingSeconds();
  const remainStr = remaining !== null
    ? ` | ${Math.floor(remaining / 60)}m ${remaining % 60}s remaining`
    : '';
  return permissionSession.getStatus() + remainStr;
}

export default { execute };
