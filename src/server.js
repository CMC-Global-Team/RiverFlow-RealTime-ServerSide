
// server.js (ESM)

import http from 'http';
import express from 'express';

// Your existing Express app composed of routers/middlewares
// If app.js exports an Express.Router() or an Express app, we can mount it below.
import app from './app.js';

import { config } from './config/app.config.js';
import { initRealtimeServer } from './realtime/socket.js';

// Import Buffer from the actual file location you provided.
// If buffer.js is in ./Tuning, change the path back to './Tuning/buffer.js'.
import { Buffer as DataBuffer } from './buffer.js'

const start = async () => {
  // Create the top-level Express app
  const APP = express();

  // Global middlewares first
  APP.use(express.json());

  // Mount your modular app/routers
  APP.use(app);

  // Optional: log registered routes safely
  if (APP?._router?.stack) {
    APP._router.stack.forEach((middleware) => {
      if (middleware.route) {
        console.log(`Route: ${middleware.route.path}`);
      } else if (middleware.name === 'router' && middleware.handle?.stack) {
        middleware.handle.stack.forEach((handler) => {
          const route = handler.route;
          if (route) console.log(`Route: ${route.path}`);
        });
      }
    });
  }

  // Create ONE HTTP server wrapping the APP
  const server = http.createServer(APP);

  // Initialize Socket.IO - returns the io instance
  const io = initRealtimeServer(server);

  // Initialize the buffering utility (uses the same io instance, no duplicate server)
  const bufferInstance = new DataBuffer({
    // Tuning options
    flushIntervalMs: 1000,
    maxBufferSize: 5000,
    maxChunkSize: 500,
    // Redis config from environment
    useRedis: config.useRedis,
    redisUrl: config.redisUrl,
    // Share the existing io instance
    io: io,
  });

  // If Redis is enabled, try to get the client for other uses
  if (config.useRedis) {
    try {
      const redisClient = await bufferInstance.redisClient();
      server.OTMZ_Buffer_instance_redis = redisClient;
      console.log('[Server] Redis buffer client ready.');
    } catch (err) {
      console.warn('[Server] Redis buffer client unavailable, using in-memory:', err.message);
    }
  } else {
    console.log('[Server] Using in-memory buffer (no Redis configured).');
  }

  // Useful diagnostics
  console.log(`[Server] Buffer length: ${bufferInstance.getBufferLength()}`);
  console.log('[Server] Buffering started.');

  const PORT = config.port;
  server.listen(PORT, () => {
    console.log('===========================================');
    console.log('RiverFlow Realtime ServerSide');
    console.log('===========================================');
    console.log(`Port: ${PORT}`);
    console.log(`Env: ${config.nodeEnv}`);
    console.log(`CORS: ${Array.isArray(config.corsOrigins) ? config.corsOrigins.join(', ') : config.corsOrigins}`);
    console.log('Path: /socket.io, Namespace: /realtime');
    console.log('===========================================');
  });

  // Graceful shutdown example (optional)
  const shutdown = async () => {
    console.log('Shutting down...');
    await bufferInstance.close();
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start();
