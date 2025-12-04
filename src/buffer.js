
// src/buffer.js (ESM)

import { Server } from 'socket.io';
import Redis from 'ioredis';

class Buffer {
  /**
   * @param {import('http').Server} server - Node HTTP server instance
   * @param {object} [options]
   * @param {number} [options.flushIntervalMs=1000]
   * @param {number} [options.maxBufferSize=5000]
   * @param {number} [options.maxChunkSize=500]
   * @param {boolean} [options.useRedis=false]
   * @param {string|null} [options.redisUrl=null]
   * @param {object} [options.socketOptions]
   */
  constructor(server, options = {}) {
    const {
      flushIntervalMs = 1000,
      maxBufferSize = 5000,
      maxChunkSize = 500,
      useRedis = false,
      redisUrl = null,
      socketOptions = {
        cors: {
          origin: '*',
          methods: ['GET', 'POST', 'PUT', 'DELETE'],
        },
      },
    } = options;

    this.io = new Server(server, socketOptions);
    this.buffer = [];
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.maxChunkSize = maxChunkSize;
    this._intervalHandle = null;
    this._isFlushing = false;
    this.redisClientInstance = null;
    this.useRedis = useRedis;
    this.redisUrl = redisUrl;

    // Redis buffer key for persistence
    this.redisBufferKey = 'riverflow:realtime:buffer';

    this._wireSocketLifecycle();
    this.startBuffering();

    if (this.useRedis) {
      this._initRedis().catch((err) => {
        console.error('[Buffer] Redis init failed, falling back to in-memory:', err.message);
        this.useRedis = false;
      });
    }
  }

  _wireSocketLifecycle() {
    this.io.on('connection', (socket) => {
      if (socket.handshake.query?.room) {
        socket.join(socket.handshake.query.room);
      }
      socket.on('disconnect', () => {
        // Example:
        // if (this.io.engine.clientsCount === 0) this.stopBuffering();
      });
    });
  }

  startBuffering() {
    if (this._intervalHandle) return; // already running
    this._intervalHandle = setInterval(() => this._flush(), this.flushIntervalMs);
  }

  stopBuffering() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  /**
   * Add data to buffer. Optionally target a room/event.
   * Uses Redis if available, otherwise in-memory.
   * @param {any} data
   * @param {{room?: string, event?: string}} [opts]
   */
  async addToBuffer(data, opts = {}) {
    const { room = null, event = 'bufferedData' } = opts;
    const item = { payload: data, room, event, timestamp: Date.now() };

    if (this.useRedis && this.redisClientInstance) {
      try {
        // Use Redis list for buffer storage
        await this.redisClientInstance.rpush(this.redisBufferKey, JSON.stringify(item));
        // Trim to max size
        await this.redisClientInstance.ltrim(this.redisBufferKey, -this.maxBufferSize, -1);
        return;
      } catch (err) {
        console.error('[Buffer] Redis addToBuffer failed, using in-memory:', err.message);
      }
    }

    // Fallback: in-memory buffer
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
    }
    this.buffer.push(item);
  }

  getBuffer() {
    return [...this.buffer];
  }

  getBufferLength() {
    return this.buffer.length;
  }

  async _flush() {
    if (this._isFlushing) return;
    this._isFlushing = true;

    try {
      let toSend = [];

      if (this.useRedis && this.redisClientInstance) {
        try {
          // Get all items from Redis and clear
          const items = await this.redisClientInstance.lrange(this.redisBufferKey, 0, -1);
          if (items.length > 0) {
            await this.redisClientInstance.del(this.redisBufferKey);
            toSend = items.map(item => {
              try {
                return JSON.parse(item);
              } catch {
                return null;
              }
            }).filter(Boolean);
          }
        } catch (err) {
          console.error('[Buffer] Redis flush failed, using in-memory:', err.message);
          toSend = this.buffer;
          this.buffer = [];
        }
      } else {
        toSend = this.buffer;
        this.buffer = [];
      }

      if (toSend.length === 0) return;

      const groups = new Map(); // key: `${room ?? ''}::${event ?? 'bufferedData'}`
      for (const { payload, room, event } of toSend) {
        const key = `${room ?? ''}::${event ?? 'bufferedData'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(payload);
      }

      for (const [key, items] of groups.entries()) {
        const [room, event] = key.split('::');
        const actualEvent = event || 'bufferedData';

        for (let i = 0; i < items.length; i += this.maxChunkSize) {
          const chunk = items.slice(i, i + this.maxChunkSize);
          if (room) {
            this.io.to(room).emit(actualEvent, chunk);
          } else {
            this.io.emit(actualEvent, chunk);
          }
        }
      }
    } catch (err) {
      console.error('[Buffer] Flush error:', err);
    } finally {
      this._isFlushing = false;
    }
  }

  /** Initialize Redis client with ioredis (better TLS and reconnection support) */
  async _initRedis() {
    if (this.redisClientInstance) return this.redisClientInstance;

    const redisOptions = this.redisUrl
      ? this.redisUrl
      : {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        // TLS config for Render.com (uses rediss://)
        ...(this.redisUrl?.startsWith('rediss://') ? { tls: {} } : {}),
      };

    const client = new Redis(redisOptions);

    client.on('error', (err) => {
      console.error('[Buffer] Redis Client Error:', err.message);
    });

    client.on('connect', () => {
      console.log('[Buffer] Redis client connected.');
    });

    client.on('ready', () => {
      console.log('[Buffer] Redis client ready.');
    });

    client.on('reconnecting', () => {
      console.log('[Buffer] Redis client reconnecting...');
    });

    // Wait for connection with timeout
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout'));
      }, 10000);

      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      client.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.redisClientInstance = client;
    return client;
  }

  /** Expose a connected Redis client (awaits init) */
  async redisClient() {
    if (this.redisClientInstance) return this.redisClientInstance;
    return this._initRedis();
  }

  /** Graceful shutdown: stop timers and close Redis */
  async close() {
    this.stopBuffering();
    if (this.redisClientInstance) {
      try {
        await this.redisClientInstance.quit();
        console.log('[Buffer] Redis client closed.');
      } catch (err) {
        console.error('[Buffer] Redis quit error:', err.message);
      } finally {
        this.redisClientInstance = null;
      }
    }
    // Optionally: await this.io.close();
  }
}

export { Buffer };
