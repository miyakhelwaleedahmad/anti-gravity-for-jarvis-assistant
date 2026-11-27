import { EventEmitter } from "events";

class InterruptManager extends EventEmitter {
    private _isInterrupted: boolean = false;
    private _isUserSpeaking: boolean = false;

    get isInterrupted(): boolean {
        return this._isInterrupted;
    }

    get isUserSpeaking(): boolean {
        return this._isUserSpeaking;
    }

    triggerInterrupt(): void {
        this._isInterrupted = true;
        this._isUserSpeaking = true;
        console.log("🚨 [InterruptManager] INTERRUPT TRIGGERED - Cancelling current operations");
        this.emit("interrupted");
    }

    clearInterrupt(): void {
        this._isInterrupted = false;
        this._isUserSpeaking = false;
        console.log("🟢 [InterruptManager] INTERRUPT CLEARED - Ready for new operations");
        this.emit("cleared");
    }

    shouldBlockTTS(): boolean {
        return this._isInterrupted || this._isUserSpeaking;
    }
}

export const interruptManager = new InterruptManager();
