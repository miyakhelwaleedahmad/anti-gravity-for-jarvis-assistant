import { agentStateMachine, AgentState } from "../core/agentStateMachine.js";
import { conversationBus } from "../core/conversationBus.js";
import { evaluateEcho } from "../core/voiceEchoFilter.js";

// Replicate isEcho exactly from jarvis.ts:
function isEcho(sttText: string, lastTtsText: string): boolean {
  return evaluateEcho(sttText, lastTtsText).isEcho;
}

// Mocking NodeBridge and voiceInputQueue for test assertions
const mockNodeBridge = {
  lastTtsText: "",
  sentMessages: [] as any[],
  sendToRole(role: string, msg: any) {
    this.sentMessages.push({ role, msg });
  },
  sendListenStart() {
    this.sentMessages.push({ role: "stt", msg: "listen_start" });
  }
};

let voiceInputQueue: string[] = [];

// Replicated handlers
function handleWakeWord(detected: boolean, hasCommand: boolean) {
  if (detected) {
    const cur = agentStateMachine.currentState;
    const isSpeaking = conversationBus.isSpeaking || cur === AgentState.SPEAKING;
    const BUSY_STATES = [
      AgentState.PLANNING,
      AgentState.EXECUTING,
      AgentState.OBSERVING,
      AgentState.REFLECTING,
      AgentState.REPAIRING,
    ];

    if (isSpeaking || BUSY_STATES.includes(cur)) {
      mockNodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
      mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'clear' } });
      mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
      voiceInputQueue.length = 0;

      agentStateMachine.interrupt();

      if (!hasCommand) {
        try { agentStateMachine.transition(AgentState.LISTENING); } catch {}
        mockNodeBridge.sendListenStart();
      }
      return;
    }

    mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
    if (!hasCommand) {
      try { agentStateMachine.transition(AgentState.LISTENING); } catch {}
      mockNodeBridge.sendListenStart();
    }
  }
}

function handleSttResult(text: string) {
  if (isEcho(text, mockNodeBridge.lastTtsText)) {
    mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });
    return;
  }

  mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'resume' } });

  const cur = agentStateMachine.currentState;
  const isSpeaking = conversationBus.isSpeaking || cur === AgentState.SPEAKING;

  if (isSpeaking) {
    mockNodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
    mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'clear' } });
    mockNodeBridge.sendToRole('wakeword', { type: 'command', payload: { action: 'pause' } });
    voiceInputQueue.length = 0;
    agentStateMachine.interrupt();
  }

  const nextState = agentStateMachine.currentState;
  const BUSY_STATES = [
    AgentState.PLANNING,
    AgentState.EXECUTING,
    AgentState.OBSERVING,
    AgentState.REFLECTING,
    AgentState.REPAIRING,
  ];

  if (BUSY_STATES.includes(nextState)) {
    const cleanInput = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const SAFE_TRIGGERS = ['open', 'launch', 'start'];
    const SAFE_ALIASES = ['youtube', 'google', 'gmail', 'github', 'notepad', 'cmd'];
    const isSafeDeterministic = SAFE_TRIGGERS.some(trigger =>
      cleanInput.startsWith(trigger + ' ') &&
      SAFE_ALIASES.some(alias => cleanInput.includes(alias))
    );

    if (isSafeDeterministic) {
      mockNodeBridge.sentMessages.push({ role: "orchestrator", msg: "process_arbitrated", text });
      return;
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < 2) {
      return;
    }

    voiceInputQueue.length = 0;
    voiceInputQueue.push(text);
    mockNodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'speak_wait_msg' } });
    return;
  }

  const PROCESSING_STT_ALLOWED = [
    AgentState.IDLE,
    AgentState.LISTENING,
    AgentState.INTERRUPTED,
  ];
  if (PROCESSING_STT_ALLOWED.includes(nextState)) {
    try {
      agentStateMachine.transition(AgentState.PROCESSING_STT);
    } catch {}
  }
}

async function runTests() {
  console.log("=== Barge-In & Echo Suppression Unit Test ===");

  // --- Test Case 1: Echo Suppression checks ---
  console.log("\n--- Test Case 1: Echo Suppression ---");
  mockNodeBridge.lastTtsText = "I am opening google for you";
  
  // Exact match
  let result = isEcho("I am opening google for you", mockNodeBridge.lastTtsText);
  console.log(`Exact match: ${result} (expected true)`);
  if (!result) throw new Error("Exact match echo filter failed!");

  // Substring match
  result = isEcho("opening google", mockNodeBridge.lastTtsText);
  console.log(`Substring match: ${result} (expected true)`);
  if (!result) throw new Error("Substring match echo filter failed!");

  // Overlap ratio > 60%
  result = isEcho("opening google for you", mockNodeBridge.lastTtsText);
  console.log(`Overlap ratio match: ${result} (expected true)`);
  if (!result) throw new Error("Overlap ratio match echo filter failed!");

  // Common phrases
  result = isEcho("would you like me to", mockNodeBridge.lastTtsText);
  console.log(`Common phrase: ${result} (expected true)`);
  if (!result) throw new Error("Common phrase echo filter failed!");

  // Non-echo command
  result = isEcho("no search for something else", mockNodeBridge.lastTtsText);
  console.log(`Non-echo command: ${result} (expected false)`);
  if (result) throw new Error("Non-echo command marked as echo!");

  // --- Test Case 2: Wake Word Interrupt during SPEAKING ---
  console.log("\n--- Test Case 2: Wake Word Interrupt during SPEAKING ---");
  agentStateMachine["_state"] = AgentState.SPEAKING;
  mockNodeBridge.sentMessages = [];
  handleWakeWord(true, false);
  console.log(`New State: ${agentStateMachine.currentState}`);
  console.log(`Sent Messages: ${JSON.stringify(mockNodeBridge.sentMessages)}`);
  
  if (agentStateMachine.currentState !== AgentState.LISTENING) {
    throw new Error("Wake word during SPEAKING failed to transition to LISTENING via interrupt!");
  }
  const stopSent = mockNodeBridge.sentMessages.some(m => m.role === 'tts' && m.msg.payload?.action === 'stop');
  const clearSent = mockNodeBridge.sentMessages.some(m => m.role === 'wakeword' && m.msg.payload?.action === 'clear');
  if (!stopSent || !clearSent) {
    throw new Error("TTS stop or Wakeword clear not sent during interrupt!");
  }

  // --- Test Case 3: Wake Word Interrupt during PLANNING ---
  console.log("\n--- Test Case 3: Wake Word Interrupt during PLANNING ---");
  agentStateMachine["_state"] = AgentState.PLANNING;
  mockNodeBridge.sentMessages = [];
  handleWakeWord(true, false);
  console.log(`New State: ${agentStateMachine.currentState}`);
  if (agentStateMachine.currentState !== AgentState.LISTENING) {
    throw new Error("Wake word during PLANNING failed to transition to LISTENING!");
  }

  // --- Test Case 4: Queue limit (max size 1, drop low-value fragments) ---
  console.log("\n--- Test Case 4: Queue limits and fragment dropping ---");
  agentStateMachine["_state"] = AgentState.PLANNING;
  voiceInputQueue.length = 0;
  mockNodeBridge.lastTtsText = "";

  // Fragment (1 word)
  handleSttResult("the");
  console.log(`Queue after fragment: ${JSON.stringify(voiceInputQueue)}`);
  if ((voiceInputQueue as any).length !== 0) throw new Error("Fragment was not dropped!");

  // Complex command 1
  handleSttResult("first complex voice command");
  console.log(`Queue after command 1: ${JSON.stringify(voiceInputQueue)}`);
  const firstCmd = voiceInputQueue[0] as string;
  if ((voiceInputQueue as any).length !== 1 || firstCmd !== "first complex voice command") {
    throw new Error("Failed to queue command 1!");
  }

  // Complex command 2 (should replace command 1 since max size is 1)
  handleSttResult("second complex command");
  console.log(`Queue after command 2: ${JSON.stringify(voiceInputQueue)}`);
  const secondCmd = voiceInputQueue[0] as string;
  if ((voiceInputQueue as any).length !== 1 || secondCmd !== "second complex command") {
    throw new Error("Queue limit of 1 was not enforced or latest command was not kept!");
  }

  console.log("\n=== All Barge-In & Echo Suppression Tests Passed Successfully! ===");
}

runTests().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
