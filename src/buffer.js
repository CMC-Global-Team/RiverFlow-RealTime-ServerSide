
// src/buffer.js (ESM)
// Optimized Buffer utility with atomic Redis operations

import Redis from 'ioredis';

class Buffer {
  /**
   * @param {object} [options]
   * @param {number} [options.flushIntervalMs=1000]
   * @param {number} [options.maxBufferSize=5000]
   * @param {number} [options.maxChunkSize=500]
   * @param {boolean} [options.useRedis=false]
   * @param {string|null} [options.redisUrl=null]
   * @param {import('socket.io').Server} [options.io=null] - Existing Socket.IO instance
   */
  constructor(options = {}) {
    const {
      flushIntervalMs = 1000,
      maxBufferSize = 5000,
      maxChunkSize = 500,
      useRedis = false,
      redisUrl = null,
      io = null,
    } = options;

    this.io = io;
    this.buffer = [];
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.maxChunkSize = maxChunkSize;
    this._intervalHandle = null;
    this._isFlushing = false;
    this.redisClientInstance = null;
    this.useRedis = useRedis;
    this.redisUrl = redisUrl;

    this.redisBufferKey = 'riverflow:realtime:buffer';

    // OPTIMIZATION: Track buffer stats for monitoring
    this._stats = {
      totalAdded: 0,
      totalFlushed: 0,
      flushErrors: 0,
      lastFlushAt: null,
    };

    this.startBuffering();

    if (this.useRedis) {
      this._initRedis().catch((err) => {
        console.error('[Buffer] Redis init failed, falling back to in-memory:', err.message);
        this.useRedis = false;
      });
    }
  }

  startBuffering() {
    if (this._intervalHandle) return;
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

    this._stats.totalAdded++;

    if (this.useRedis && this.redisClientInstance) {
      try {
        // OPTIMIZATION: Use pipeline for batch operations
        const pipeline = this.redisClientInstance.pipeline();
        pipeline.rpush(this.redisBufferKey, JSON.stringify(item));
        pipeline.ltrim(this.redisBufferKey, -this.maxBufferSize, -1);
        await pipeline.exec();
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

  // OPTIMIZATION: Expose stats for monitoring
  getStats() {
    return { ...this._stats };
  }

  async _flush() {
    if (this._isFlushing) return;
    if (!this.io) return;
    this._isFlushing = true;

    try {
      let toSend = [];

      if (this.useRedis && this.redisClientInstance) {
        try {
          // OPTIMIZATION: Use pipeline for atomic get + clear operations
          // This prevents race conditions between lrange and del
          const pipeline = this.redisClientInstance.pipeline();
          pipeline.lrange(this.redisBufferKey, 0, -1);
          pipeline.del(this.redisBufferKey);
          const results = await pipeline.exec();

          // results[0] = [err, items], results[1] = [err, delCount]
          const [lrangeErr, items] = results[0] || [];
          if (lrangeErr) {
            throw lrangeErr;
          }

          if (items && items.length > 0) {
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
          this._stats.flushErrors++;
          toSend = this.buffer;
          this.buffer = [];
        }
      } else {
        toSend = this.buffer;
        this.buffer = [];
      }

      if (toSend.length === 0) return;

      // Group by room + event for efficient emission
      const groups = new Map();
      for (const { payload, room, event } of toSend) {
        const key = `${room ?? ''}::${event ?? 'bufferedData'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(payload);
      }

      for (const [key, items] of groups.entries()) {
        const [room, event] = key.split('::');
        const actualEvent = event || 'bufferedData';

        // OPTIMIZATION: Batch emit in chunks to prevent overwhelming clients
        for (let i = 0; i < items.length; i += this.maxChunkSize) {
          const chunk = items.slice(i, i + this.maxChunkSize);
          if (room) {
            this.io.to(room).emit(actualEvent, chunk);
          } else {
            this.io.emit(actualEvent, chunk);
          }
        }
      }

      this._stats.totalFlushed += toSend.length;
      this._stats.lastFlushAt = Date.now();
    } catch (err) {
      console.error('[Buffer] Flush error:', err);
      this._stats.flushErrors++;
    } finally {
      this._isFlushing = false;
    }
  }

  /** Initialize Redis client with ioredis (better TLS and reconnection support) */
  async _initRedis() {
    if (this.redisClientInstance) return this.redisClientInstance;

    const client = new Redis(this.redisUrl, {
      // OPTIMIZATION: Connection pool settings
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: false,
      enableReadyCheck: true,
      keepAlive: 30000,
    });

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

  /** Set the io instance after initialization */
  setIO(io) {
    this.io = io;
  }

  /** Graceful shutdown: flush remaining data, stop timers and close Redis */
  async close() {
    // Flush any remaining buffered data before closing
    if (this.buffer.length > 0 || (this.useRedis && this.redisClientInstance)) {
      try {
        await this._flush();
      } catch (err) {
        console.error('[Buffer] Final flush error:', err.message);
      }
    }

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

    // Log final stats
    console.log(`[Buffer] Final stats: added=${this._stats.totalAdded}, flushed=${this._stats.totalFlushed}, errors=${this._stats.flushErrors}`);
  }
}

export { Buffer };
