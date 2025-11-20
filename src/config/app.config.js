import dotenv from 'dotenv'

dotenv.config()

export const config = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'production',
  jwtSecret: process.env.JWT_SECRET || null,
  backendUrl: process.env.APP_BACKEND_URL || 'https://riverflow-server.onrender.com/api',
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:8080', 'https://riverflow-server.onrender.com', 'https://river-flow-client.vercel.app'],
}

export default config
