import { NextResponse } from 'next/server';
import { Redis } from 'ioredis';

// Initialize ioredis client
const redisClient = new Redis('redis://127.0.0.1:6379');

redisClient.on('error', (err) => console.error('Redis Client Error', err));

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (!key) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }

    const value = await redisClient.get(key);

    return NextResponse.json({ key, value });
  } catch (error) {
    console.error('Error fetching memory:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { key, value } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'Key and value are required' }, { status: 400 });
    }

    // Convert objects/arrays to JSON string
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    
    await redisClient.set(key, stringValue);

    return NextResponse.json({ success: true, key, value: stringValue });
  } catch (error) {
    console.error('Error setting memory:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
