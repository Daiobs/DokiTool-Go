import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Use the browser's debugging endpoint only for this dedicated test profile.
// Native download naming remains browser-owned; the test never renames files.
export async function connect(profileDir, onEvent = () => {}) {
  const [port, socketPath] = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
  const ws = new WebSocket('ws://127.0.0.1:' + Number(port) + socketPath)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Browser debug socket did not open')) }, 10_000)
    timer.unref?.()
    ws.onopen = () => { clearTimeout(timer); resolve() }
    ws.onerror = () => { clearTimeout(timer); try { ws.close() } catch {} reject(new Error('Browser debug socket failed to open')) }
  })
  let sequence = 0
  const pending = new Map()
  const disconnected = () => {
    for (const reply of pending.values()) {
      clearTimeout(reply.timer)
      reply.reject(new Error('Browser disconnected during ' + reply.method))
    }
    pending.clear()
  }
  ws.onclose = disconnected
  ws.onerror = () => {
    try { ws.close() } catch {}
    disconnected()
  }
  ws.onmessage = message => {
    const packet = JSON.parse(message.data)
    const reply = pending.get(packet.id)
    if (!packet.id) { onEvent(packet); return }
    if (!reply) return
    clearTimeout(reply.timer)
    pending.delete(packet.id)
    if (packet.error) reply.reject(new Error(reply.method + ': ' + packet.error.message))
    else reply.resolve(packet.result)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('Browser is not connected for ' + method))
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Browser RPC timed out: ' + method))
    }, 15_000)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer, method })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
  return {
    send,
    close: () => {
      disconnected()
      try { ws.close() } catch {}
    },
  }
}

// Connect to Chrome launched with --remote-debugging-pipe (FD 3 write, FD 4 read, NUL-delimited JSON).
// Eliminates any local TCP DevTools listening port on POSIX hosts.
export function connectPipe(child, onEvent = () => {}) {
  const pipeWrite = child?.stdio?.[3]
  const pipeRead = child?.stdio?.[4]
  if (!pipeWrite || !pipeRead) {
    throw new Error('Browser child process missing stdio FD 3/4 for --remote-debugging-pipe')
  }
  let sequence = 0
  let closed = false
  let buffer = Buffer.alloc(0)
  const pending = new Map()

  const disconnected = (reason = 'Browser pipe disconnected') => {
    closed = true
    for (const reply of pending.values()) {
      clearTimeout(reply.timer)
      reply.reject(new Error(reason + ' during ' + reply.method))
    }
    pending.clear()
  }

  pipeRead.on('data', chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buffer = buffer.length ? Buffer.concat([buffer, data]) : data
    let nulIdx = buffer.indexOf(0)
    while (nulIdx !== -1) {
      const frame = buffer.subarray(0, nulIdx).toString('utf8')
      buffer = buffer.subarray(nulIdx + 1)
      nulIdx = buffer.indexOf(0)
      if (!frame) continue
      let packet
      try {
        packet = JSON.parse(frame)
      } catch {
        continue
      }
      if (!packet.id) {
        onEvent(packet)
        continue
      }
      const reply = pending.get(packet.id)
      if (!reply) continue
      clearTimeout(reply.timer)
      pending.delete(packet.id)
      if (packet.error) reply.reject(new Error(reply.method + ': ' + packet.error.message))
      else reply.resolve(packet.result)
    }
  })

  pipeRead.on('end', () => disconnected('Browser pipe ended'))
  pipeRead.on('close', () => disconnected('Browser pipe closed'))
  pipeRead.on('error', () => disconnected('Browser pipe read error'))
  pipeWrite.on('error', () => disconnected('Browser pipe write error'))
  child.once('exit', () => disconnected('Browser exited'))

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed || pipeWrite.destroyed || pipeWrite.writableEnded) {
      return reject(new Error('Browser pipe is not connected for ' + method))
    }
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Browser RPC timed out: ' + method))
    }, 15_000)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer, method })
    const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0'
    try {
      pipeWrite.write(payload, 'utf8')
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err)
    }
  })

  return {
    send,
    close: () => {
      disconnected('Browser pipe closed')
      try { pipeWrite.destroy() } catch {}
      try { pipeRead.destroy() } catch {}
    },
  }
}

export async function until(read, label, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs
  do {
    const result = await read()
    if (result) return result
    await delay(75)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for ' + label)
}
