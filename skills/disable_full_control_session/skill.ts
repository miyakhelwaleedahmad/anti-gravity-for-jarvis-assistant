import { permissionSession } from '../../control/permissionSession.js';
import { getRequestSource } from '../../core/traceContext.js';

export async function execute(args: Record<string, unknown> = {}): Promise<string> {
  // The audit records how the request arrived, not free text from the model.
  const claimed = String(args['source'] ?? '');
  const source = getRequestSource() ?? (['voice', 'cli', 'gui', 'auto'].includes(claimed) ? claimed : 'cli');
  permissionSession.deactivateFullControl(`manual_by_${source}`);
  return permissionSession.getStatus();
}

export default { execute };
