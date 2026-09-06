import { Redis } from 'ioredis';

async function testNodeRedis() {
  const client = new Redis('redis://127.0.0.1:6379');

  client.on('error', (err) => console.error('Redis Client Error', err));

  console.log('Node.js connected to Redis (via ioredis)');

  // Read the key written by Python
  const testKey = 'jarvis:test';
  const value = await client.get(testKey);

  console.log(`Read key '${testKey}' -> '${value}'`);

  if (value === 'system_online') {
    console.log('Success: Node.js successfully read the value written by Python.');
  } else {
    console.log('Failed: Value mismatch or key not found.');
  }

  client.disconnect();
}

testNodeRedis().catch(console.error);
