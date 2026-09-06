/**
 * One centralized log system for everything.
 */
export class EventLogger {
    public log(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level}] [${source}] ${message}`);
        // In a real app, write this to a file or external logging service
    }

    public info(source: string, message: string) {
        this.log('INFO', source, message);
    }

    public warn(source: string, message: string) {
        this.log('WARN', source, message);
    }

    public error(source: string, message: string) {
        this.log('ERROR', source, message);
    }
}

export const eventLogger = new EventLogger();
