// Fallback type declaration for 'ws' WebSocket library
// This can be removed once @types/ws is installed via: pnpm add -D @types/ws

declare module 'ws' {
  import { EventEmitter } from 'events';
  import { IncomingMessage } from 'http';
  import { Duplex } from 'stream';
  import * as net from 'net';

  export interface ServerOptions {
    host?: string;
    port?: number;
    backlog?: number;
    server?: import('http').Server | import('https').Server;
    verifyClient?: (info: { origin: string; req: IncomingMessage; secure: boolean }) => boolean;
    handleProtocols?: (protocols: string[], request: IncomingMessage) => string | false;
    path?: string;
    noServer?: boolean;
    clientTracking?: boolean;
    perMessageDeflate?: boolean | object;
    maxPayload?: number;
  }

  export interface ClientOptions {
    protocol?: string;
    followRedirects?: boolean;
    handshakeTimeout?: number;
    maxRedirects?: number;
    perMessageDeflate?: boolean | object;
    localAddress?: string;
    protocolVersion?: number;
    headers?: { [key: string]: string };
    origin?: string;
    agent?: import('http').Agent;
    host?: string;
    family?: number;
    checkServerIdentity?: (servername: string, cert: object) => boolean | undefined;
    rejectUnauthorized?: boolean;
    maxPayload?: number;
  }

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;

    readonly readyState: 0 | 1 | 2 | 3;
    readonly url: string;
    readonly bufferedAmount: number;
    readonly extensions: string;
    readonly protocol: string;

    constructor(address: string, options?: ClientOptions);
    constructor(address: string, protocols?: string | string[], options?: ClientOptions);

    close(code?: number, reason?: string): void;
    ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
    pong(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
    send(data: unknown, cb?: (err?: Error) => void): void;
    send(data: unknown, options: { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean }, cb?: (err?: Error) => void): void;
    terminate(): void;

    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
    on(event: 'open', listener: () => void): this;
    on(event: 'ping' | 'pong', listener: (data: Buffer) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    options: ServerOptions;
    path: string;
    clients: Set<WebSocket>;

    constructor(options?: ServerOptions, callback?: () => void);

    close(cb?: (err?: Error) => void): void;
    handleUpgrade(request: IncomingMessage, socket: Duplex, upgradeHead: Buffer, callback: (client: WebSocket, request: IncomingMessage) => void): void;
    shouldHandle(request: IncomingMessage): boolean | Promise<boolean>;

    on(event: 'connection', cb: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'error', cb: (error: Error) => void): this;
    on(event: 'headers', cb: (headers: string[], request: IncomingMessage) => void): this;
    on(event: 'close' | 'listening', cb: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export default WebSocket;
}
