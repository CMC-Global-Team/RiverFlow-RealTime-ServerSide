
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

  // Initialize Socket.IO or other realtime integrations on this server
  initRealtimeServer(server);

  // Initialize and start the buffering utility (Socket.IO-based)
  const bufferInstance = new DataBuffer(server, {
    // You can tune these options as needed
    flushIntervalMs: 1000,
    maxBufferSize: 5000,
    maxChunkSize: 500,
    useRedis: true, // set true if you actually want Redis
    socketOptions: {
      cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
      },
    },
  });

  // If you need Redis immediately in server.js, await the public getter:
  try {
    const redisClient = await bufferInstance.redisClient();
    server.OTMZ_Buffer_instance_redis = redisClient; // expose on server if you need it elsewhere
    console.log('Redis client connected.');
  } catch (err) {
    console.error('Redis client failed to connect:', err);
  }

  // Useful diagnostics
  console.log(`Buffer length: ${bufferInstance.getBuffer()?.length ?? 0}`);
  console.log('Buffering started.');

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
