import http from 'http'
import app from './app.js'
import { config } from './config/app.config.js'
import { initRealtimeServer } from './realtime/socket.js'

const start = async () => {
  const server = http.createServer(app)
  initRealtimeServer(server)
  const PORT = config.port
  server.listen(PORT, () => {
    console.log('===========================================')
    console.log('RiverFlow Realtime ServerSide')
    console.log('===========================================')
    console.log(`Port: ${PORT}`)
    console.log(`Env: ${config.nodeEnv}`)
    console.log(`CORS: ${config.corsOrigins.join(', ')}`)
    console.log('Path: /socket.io, Namespace: /realtime')
    console.log('===========================================')
  })
}

start()

