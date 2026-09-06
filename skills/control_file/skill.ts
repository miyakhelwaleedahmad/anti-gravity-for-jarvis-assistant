import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const filePath = String(args['path'] ?? '');
  const content = String(args['content'] ?? '');
  const destination = String(args['destination'] ?? '');

  let res;
  if (action === 'search') {
    res = await pcControlKernel.searchFiles(filePath);
  } else if (action === 'read') {
    res = await pcControlKernel.readFile(filePath);
  } else if (action === 'write') {
    res = await pcControlKernel.writeFile(filePath, content);
  } else if (action === 'copy') {
    res = await pcControlKernel.copyFile(filePath, destination);
  } else if (action === 'move' || action === 'rename') {
    res = await pcControlKernel.moveFile(filePath, destination);
  } else if (action === 'delete') {
    res = await pcControlKernel.deleteFile(filePath);
  } else if (action === 'create_folder') {
    res = await pcControlKernel.createFolder(filePath);
  } else if (action === 'delete_folder') {
    res = await pcControlKernel.deleteFolder(filePath);
  } else {
    throw new Error(`Unknown file action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
