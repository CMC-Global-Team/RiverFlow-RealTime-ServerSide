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

export default app
