import dotenv from 'dotenv'

dotenv.config()

export const config = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'production',
  jwtSecret: process.env.JWT_SECRET || null,
  backendUrl: process.env.APP_BACKEND_URL || 'https://river-flow.id.vn/api',
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3000', 'http://localhost:8080', 'https://river-flow.id.vn', 'https://river-flow-client.vercel.app'],
}

export default config
