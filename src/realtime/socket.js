import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import { config } from '../config/app.config.js'

export function initRealtimeServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
    path: '/socket.io',
  })

  const roomParticipants = new Map()

  io.of('/realtime').use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers['authorization']?.replace('Bearer ', '')
      socket.data.user = null
      if (token && config.jwtSecret) {
        const payload = jwt.verify(token, config.jwtSecret)
        socket.data.user = { id: payload?.sub || payload?.userId || payload?.id }
      }
      next()
    } catch (e) {
      next()
    }
  })

  io.of('/realtime').on('connection', (socket) => {
    try {
      const origin = socket.handshake.headers?.origin || 'unknown'
      const uid = socket.data.user?.id || 'anonymous'
      console.log(`[socket] connected id=${socket.id} origin=${origin} userId=${uid}`)
    } catch {}
    socket.on('mindmap:join', async (payload) => {
      try {
        const { mindmapId, shareToken } = payload || {}
        let room = null
        let canEdit = false
        let ok = false
        if (config.backendUrl) {
          if (shareToken) {
            const res = await fetch(`${config.backendUrl}/mindmaps/public/${shareToken}`)
            ok = res.ok
            if (ok) {
              const data = await res.json()
              room = `mindmap:${data.id}`
              canEdit = data.publicAccessLevel === 'edit'
            }
          } else if (mindmapId) {
            const token = socket.handshake.auth?.token
            const headers = token ? { Authorization: `Bearer ${token}` } : {}
            const res = await fetch(`${config.backendUrl}/mindmaps/${mindmapId}`, { headers })
            ok = res.ok
            if (ok) {
              const data = await res.json()
              room = `mindmap:${data.id}`
              canEdit = true
            }
          }
        }
        if (!room) {
          console.log(`[join] refused id=${socket.id} token=${shareToken ? 'public' : 'private'} mindmapId=${mindmapId}`)
          return
        }
        socket.join(room)
        socket.data.room = room
        socket.emit('mindmap:joined', { room, canEdit })
        console.log(`[join] room=${room} id=${socket.id} canEdit=${canEdit}`)
        const participants = roomParticipants.get(room) || new Map()
        roomParticipants.set(room, participants)
        const snapshot = Array.from(participants.values())
        socket.emit('presence:state', snapshot)
      } catch (err) {
        console.log(`[join:error] id=${socket.id} ${err?.message || err}`)
      }
    })

    socket.on('mindmap:nodes:change', (room, changes) => {
      socket.broadcast.to(room).emit('mindmap:nodes:change', changes)
    })
    socket.on('mindmap:edges:change', (room, changes) => {
      socket.broadcast.to(room).emit('mindmap:edges:change', changes)
    })
    socket.on('mindmap:connect', (room, connection) => {
      socket.broadcast.to(room).emit('mindmap:connect', connection)
    })
    socket.on('mindmap:viewport', (room, viewport) => {
      socket.broadcast.to(room).emit('mindmap:viewport', viewport)
    })

    socket.on('cursor:move', (room, data) => {
      const participants = roomParticipants.get(room)
      if (participants) {
        const p = participants.get(socket.id)
        if (p) {
          p.cursor = data?.cursor || null
        }
      }
      socket.broadcast.to(room).emit('cursor:move', data)
    })

    socket.on('presence:announce', (room, info) => {
      const participants = roomParticipants.get(room) || new Map()
      roomParticipants.set(room, participants)
      const clientId = socket.id
      const userId = socket.data.user?.id || info?.userId || null
      const name = info?.name || ''
      const color = info?.color || '#3b82f6'
      const existing = participants.get(clientId) || {}
      participants.set(clientId, {
        clientId,
        userId,
        name,
        color,
        cursor: existing.cursor || null,
        active: existing.active || null,
      })
      console.log(`[presence] announce clientId=${clientId} userId=${userId} name=${name}`)
      socket.broadcast.to(room).emit('presence:announce', { clientId, userId, name, color })
    })

    socket.on('presence:active', (room, data) => {
      const participants = roomParticipants.get(room)
      if (participants) {
        const p = participants.get(socket.id)
        if (p) {
          p.active = data || null
        }
      }
      console.log(`[presence] active clientId=${socket.id} type=${data?.type || 'none'} id=${data?.id || ''}`)
      socket.broadcast.to(room).emit('presence:active', { clientId: socket.id, active: data || null })
    })

    socket.on('presence:clear', (room) => {
      const participants = roomParticipants.get(room)
      if (participants) {
        const p = participants.get(socket.id)
        if (p) {
          p.active = null
        }
      }
      console.log(`[presence] clear clientId=${socket.id}`)
      socket.broadcast.to(room).emit('presence:clear', { clientId: socket.id })
    })

    socket.on('disconnect', () => {
      const room = socket.data.room
      if (!room) return
      const participants = roomParticipants.get(room)
      if (!participants) return
      if (participants.has(socket.id)) {
        participants.delete(socket.id)
        console.log(`[socket] disconnected id=${socket.id} room=${room}`)
        socket.broadcast.to(room).emit('presence:left', { clientId: socket.id })
      }
    })
  })
}

export default initRealtimeServer
