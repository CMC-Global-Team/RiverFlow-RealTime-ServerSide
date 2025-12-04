
// src/buffer.js (ESM)

import { Server } from 'socket.io';
import redis from 'redis';

class Buffer {
  /**
   * @param {import('http').Server} server - Node HTTP server instance
   * @param {object} [options]
   * @param {number} [options.flushIntervalMs=1000]
   * @param {number} [options.maxBufferSize=5000]
   * @param {number} [options.maxChunkSize=500]
   * @param {boolean} [options.useRedis=false]
   * @param {object} [options.socketOptions]
   */
  constructor(server, options = {}) {
    const {
      flushIntervalMs = 1000,
      maxBufferSize = 5000,
      maxChunkSize = 500,
      useRedis = false,
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

    this._wireSocketLifecycle();
    this.startBuffering();

    if (this.useRedis) {
      this._initRedis().catch((err) => {
        console.error('[Buffer] Redis init failed:', err);
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
   * @param {any} data
   * @param {{room?: string, event?: string}} [opts]
   */
  addToBuffer(data, opts = {}) {
    const { room = null, event = 'bufferedData' } = opts;
    const item = { payload: data, room, event };

    // Backpressure: drop oldest if exceeding max
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
    if (this.buffer.length === 0) return;
    this._isFlushing = true;

    try {
      const toSend = this.buffer;
      this.buffer = [];

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

  /** Initialize a singleton Redis client */
  async _initRedis() {
    if (this.redisClientInstance) return this.redisClientInstance;

    const client = redis.createClient();
    client.on('error', (err) => {
      console.error('[Buffer] Redis Client Error:', err);
    });

    await client.connect();
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
      } catch (err) {
        console.error('[Buffer] Redis quit error:', err);
      } finally {
        this.redisClientInstance = null;
      }
    }
    // Optionally: await this.io.close();
  }
}

export { Buffer };
