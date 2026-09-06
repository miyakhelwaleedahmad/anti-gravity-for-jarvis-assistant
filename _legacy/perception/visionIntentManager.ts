import { messageBus } from '../core/messageBus.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { conversationBus } from '../core/conversationBus.js';

export class VisionIntentManager {
    private state: 'IDLE' | 'ACTIVE' = 'IDLE';
    private lastTriggered: number = 0;
    private checkInterval: NodeJS.Timeout | null = null;
    private readonly timeoutMs = 20000; // 20 seconds of inactivity to stop

    constructor() {
        // Automatically start checking for auto-stop condition
        this.startAutoStopCheck();
        
        // Reset timer on each user input to prevent early shutdown
        messageBus.subscribe('INPUT_RECEIVED', () => {
            if (this.state === 'ACTIVE') {
                this.lastTriggered = Date.now();
            }
        });
    }

    public startVision() {
        if (this.state === 'IDLE') {
            this.state = 'ACTIVE';
            console.log(`[VisionIntentManager] 🔥 Vision Mode ACTIVE.`);
            // Send signal to Python bridge to start streaming frames
            nodeBridge.broadcast({ type: 'vision_start', payload: {} });
        }
        this.lastTriggered = Date.now();
    }

    public stopVision() {
        if (this.state === 'ACTIVE') {
            this.state = 'IDLE';
            console.log(`[VisionIntentManager] 💤 Vision Mode IDLE.`);
            // Send signal to Python bridge to stop streaming frames
            nodeBridge.broadcast({ type: 'vision_stop', payload: {} });
        }
    }

    private startAutoStopCheck() {
        if (this.checkInterval) clearInterval(this.checkInterval);
        
        this.checkInterval = setInterval(() => {
            if (this.state === 'ACTIVE') {
                const elapsed = Date.now() - this.lastTriggered;
                // Only stop if timeout reached AND conversation is no longer active
                if (elapsed > this.timeoutMs && !conversationBus.isActive) {
                    console.log(`[VisionIntentManager] 🛑 Auto-stopping vision due to inactivity.`);
                    this.stopVision();
                }
            }
        }, 5000);
    }
}

export const visionIntentManager = new VisionIntentManager();
