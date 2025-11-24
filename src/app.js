import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config/app.config.js'

const app = express()

app.use(helmet())
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.json({ success: true, message: 'RiverFlow Realtime ServerSide', documentation: '/realtime' })
})

app.post('/realtime/mindmap/event', async (req, res) => {
  try {
    const { mindmapId, room, event, data } = req.body || {}
    const io = globalThis.realtimeIO
    if (!io) return res.status(500).json({ ok: false, error: 'io not ready' })
    if (!event || (!mindmapId && !room)) return res.status(400).json({ ok: false, error: 'missing event or room/mindmapId' })
    const r = room || `mindmap:${mindmapId}`
    io.of('/realtime').to(r).emit(event, data || {})
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) })
  }
})

export default app
