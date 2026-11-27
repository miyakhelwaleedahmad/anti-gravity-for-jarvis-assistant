/**
 * Safe bubble for tool execution.
 */
export class ContainerManager {
    public createContainer(name: string): string {
        console.log(`[ContainerManager] Created container: ${name}`);
        return `container_${name}`;
    }

    public executeInContainer(containerId: string, command: string): void {
        console.log(`[ContainerManager] Executing '${command}' inside ${containerId}`);
    }

    public destroyContainer(containerId: string): void {
        console.log(`[ContainerManager] Destroyed container: ${containerId}`);
    }
}

export const containerManager = new ContainerManager();
