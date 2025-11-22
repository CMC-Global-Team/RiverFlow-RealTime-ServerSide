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
      socket.data.token = token || null
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
    const lastSnapshotAtByRoom = new Map()

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
              socket.data.mindmapId = data.id
              socket.data.shareToken = shareToken
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
              socket.data.mindmapId = data.id
              socket.data.shareToken = null
            }
          }
        }
        if (!room) {
          console.log(`[join] refused id=${socket.id} token=${shareToken ? 'public' : 'private'} mindmapId=${mindmapId}`)
          return
        }
        socket.join(room)
        socket.data.room = room
        socket.data.canEdit = canEdit
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

    const normalizeChanges = (c) => {
      try {
        if (Array.isArray(c)) {
          return { items: c, count: c.length }
        }
        if (c && typeof c === 'object') {
          return c
        }
        if (c == null) return undefined
        return { value: c }
      } catch (_) {
        return undefined
      }
    }

    const maybeGetSnapshot = async () => {
      try {
        const room = socket.data.room
        if (!room) return null
        const lastAt = lastSnapshotAtByRoom.get(room) || 0
        const now = Date.now()
        if (now - lastAt < 1000) return null
        const mindmapId = socket.data.mindmapId
        if (!mindmapId) return null
        const shareToken = socket.data.shareToken
        let res
        if (shareToken) {
          res = await fetch(`${config.backendUrl}/mindmaps/public/${shareToken}`)
        } else {
          const token = socket.data.token
          const headers = token ? { Authorization: `Bearer ${token}` } : {}
          res = await fetch(`${config.backendUrl}/mindmaps/${mindmapId}`, { headers })
        }
        if (!res?.ok) return null
        const data = await res.json()
        lastSnapshotAtByRoom.set(room, now)
        return {
          nodes: data?.nodes || [],
          edges: data?.edges || [],
          viewport: data?.viewport || null,
        }
      } catch (_) {
        return null
      }
    }

    const lastLogAtByRoomAction = new Map()

    const logHistory = async (action, changes, snapshot = null, status = 'active') => {
      try {
        if (!config.backendUrl) return
        if (!socket.data.room) return
        if (!socket.data.canEdit) return
        const allowed = String(action).startsWith('node_') || String(action).startsWith('edge_') || action === 'delete' || action === 'restore'
        if (!allowed) return
        const mindmapId = (socket.data.mindmapId) || (String(socket.data.room).split(':')[1])
        if (!mindmapId) return
        const token = socket.data.token
        const headers = {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }
        const key = `${socket.data.room}:${action}`
        const now = Date.now()
        const lastAt = lastLogAtByRoomAction.get(key) || 0
        const minInterval = (action === 'node_update' || action === 'edge_update') ? 1000 : 0
        if (minInterval > 0 && now - lastAt < minInterval) return
        const snap = snapshot || (await maybeGetSnapshot())
        const body = {
          action,
          changes: normalizeChanges(changes),
          snapshot: normalizeChanges(snap),
          metadata: {
            ip: socket.handshake.address || null,
            userAgent: socket.handshake.headers['user-agent'] || null,
            sessionId: socket.id,
          },
          status,
        }
        const res = await fetch(`${config.backendUrl}/mindmaps/${mindmapId}/history`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const txt = await res.text()
          console.log(`[history:log:error] id=${socket.id} action=${action} code=${res.status} msg=${txt}`)
          socket.emit('history:log:error', { mindmapId, action, code: res.status })
        }
        if (res.ok) {
          lastLogAtByRoomAction.set(key, now)
          const entry = {
            id: null,
            mindmapId,
            mysqlUserId: socket.data.user?.id || null,
            action,
            changes: body.changes,
            snapshot: body.snapshot,
            metadata: body.metadata,
            createdAt: new Date().toISOString(),
            status,
          }
          const room = socket.data.room
          if (room) io.of('/realtime').to(room).emit('history:log', entry)
        }
      } catch (e) {
        console.log(`[history:log:error] id=${socket.id} action=${action} msg=${e?.message || e}`)
        socket.emit('history:log:error', { mindmapId: socket.data.mindmapId || null, action })
      }
    }

    socket.on('history:restore', (room, payload) => {
      try {
        const snapshot = payload?.snapshot || null
        const historyId = payload?.historyId || null
        io.of('/realtime').to(room).emit('history:restore', { historyId, snapshot })
        logHistory('restore', { targetHistoryId: historyId }, snapshot)
      } catch (e) {
        console.log(`[history:restore:error] id=${socket.id} ${e?.message || e}`)
      }
    })

    const dragStateByRoom = new Map()

    socket.on('mindmap:nodes:change', (room, changes) => {
      socket.broadcast.to(room).emit('mindmap:nodes:change', changes)
      try {
        if (!room || !Array.isArray(changes)) return
        const trackers = dragStateByRoom.get(room) || new Map()
        dragStateByRoom.set(room, trackers)
        for (const ch of changes) {
          const isPos = ch && ch.type === 'position'
          const id = ch && ch.id
          const pos = ch && ch.position
          const dragging = ch && Object.prototype.hasOwnProperty.call(ch, 'dragging') ? ch.dragging === true : undefined
          if (!isPos || !id || !pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue
          const prev = trackers.get(id) || { start: null, last: null }
          if (!prev.start) prev.start = { x: pos.x, y: pos.y }
          prev.last = { x: pos.x, y: pos.y }
          trackers.set(id, prev)
          if (dragging === false) {
            const t = trackers.get(id)
            if (t && t.start && t.last && (t.start.x !== t.last.x || t.start.y !== t.last.y)) {
              logHistory('node_update', { id, from: t.start, to: t.last })
            }
            trackers.delete(id)
          }
        }
      } catch (_) {}
    })
    socket.on('mindmap:edges:change', (room, changes) => {
      socket.broadcast.to(room).emit('mindmap:edges:change', changes)
      logHistory('edge_update', changes)
    })
    socket.on('mindmap:connect', (room, connection) => {
      socket.broadcast.to(room).emit('mindmap:connect', connection)
      logHistory('edge_add', connection)
    })
    socket.on('mindmap:viewport', (room, viewport) => {
      socket.broadcast.to(room).emit('mindmap:viewport', viewport)
    })

    socket.on('mindmap:nodes:update', (room, node) => {
      socket.broadcast.to(room).emit('mindmap:nodes:update', node)
      logHistory('node_update', node)
    })
    socket.on('mindmap:edges:update', (room, edge) => {
      socket.broadcast.to(room).emit('mindmap:edges:update', edge)
      logHistory('edge_update', edge)
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
