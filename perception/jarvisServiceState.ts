import { isRedisAvailable } from '../memory/redisCache.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import axios from 'axios';

export interface JarvisServicesState {
  redis: 'online' | 'offline' | 'unknown';
  vectorMemory: 'online' | 'offline' | 'unknown';
  nodeBridge: 'online' | 'offline' | 'unknown';
  stt: 'connected' | 'disconnected' | 'unknown';
  tts: 'connected' | 'disconnected' | 'unknown';
  wakeword: 'connected' | 'disconnected' | 'unknown';
  vision: 'connected' | 'disconnected' | 'unknown';
}

export async function getJarvisServiceState(): Promise<JarvisServicesState> {
  const readyClients = nodeBridge.getReadyClients() || [];
  
  // 1. Redis
  let redisStatus: 'online' | 'offline' | 'unknown' = 'offline';
  try {
    redisStatus = isRedisAvailable() ? 'online' : 'offline';
  } catch {
    redisStatus = 'unknown';
  }

  // 2. Vector Memory
  let vectorMemoryStatus: 'online' | 'offline' | 'unknown' = 'offline';
  try {
    const res = await axios.get('http://127.0.0.1:8000/stats', { timeout: 800 });
    if (res.status === 200) {
      vectorMemoryStatus = 'online';
    }
  } catch {
    try {
      const resHealth = await axios.get('http://127.0.0.1:8000/health', { timeout: 800 });
      if (resHealth.status === 200) {
        vectorMemoryStatus = 'online';
      }
    } catch {
      vectorMemoryStatus = 'offline';
    }
  }

  // 3. NodeBridge health endpoint check
  let nodeBridgeStatus: 'online' | 'offline' | 'unknown' = 'offline';
  try {
    const res = await axios.get('http://127.0.0.1:9001/health', { timeout: 800 });
    if (res.status === 200) {
      nodeBridgeStatus = 'online';
    }
  } catch {
    nodeBridgeStatus = 'offline';
  }

  return {
    redis: redisStatus,
    vectorMemory: vectorMemoryStatus,
    nodeBridge: nodeBridgeStatus,
    stt: readyClients.includes('stt') ? 'connected' : 'disconnected',
    tts: readyClients.includes('tts') ? 'connected' : 'disconnected',
    wakeword: readyClients.includes('wakeword') ? 'connected' : 'disconnected',
    vision: readyClients.includes('vision') ? 'connected' : 'disconnected',
  };
}
