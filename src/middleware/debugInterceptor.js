const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const path = require('path')
const fs = require('fs')
const config = require('../../config/config')

// Ensure logs directory exists
const logsDir = config.logging?.dirname || path.join(__dirname, '..', '..', 'logs')
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 })
}

// Dedicated HTTP debug logger (separate files)
const httpDebugLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`
    })
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'http-debug-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: config.logging?.maxSize || '10m',
      maxFiles: config.logging?.maxFiles || 5
    })
  ]
})

// Dedicated conversation logger for conversation text content only
const conversationLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`
    })
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'http-conversation-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: config.logging?.maxSize || '10m',
      maxFiles: config.logging?.maxFiles || 5
    })
  ]
})

function sanitizeHeaders(headers) {
  const redacted = {}
  const redactKeys = [
    'authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'x-admin-token',
    'cookie',
    'set-cookie'
  ]
  for (const [k, v] of Object.entries(headers || {})) {
    if (redactKeys.includes(k.toLowerCase())) {
      redacted[k] = '[REDACTED]'
    } else {
      redacted[k] = v
    }
  }
  return redacted
}

function stringifySafe(obj) {
  try {
    return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  } catch (_e) {
    return '[Unstringifiable Body]'
  }
}

// Express middleware to capture full request/response for debugging
function debugInterceptor(req, res, next) {
  const requestId = req.requestId || `dbg_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`

  const reqLine = `${req.method} ${req.originalUrl}`
  const reqHeaders = sanitizeHeaders(req.headers)

  // Log request line + headers immediately
  httpDebugLogger.info(
    `===== BEGIN REQUEST ${requestId} =====\n` +
      `${reqLine}\n` +
      `Headers: ${JSON.stringify(reqHeaders, null, 2)}`
  )

  // Log parsed body (available because we mount this after body parsers)
  if (req.body !== undefined) {
    httpDebugLogger.info(
      `RequestBody(${requestId}):\n${stringifySafe(req.body)}`
    )
    conversationLogger.info(
      `===== CONVERSATION ${requestId} =====\n` +
        `REQUEST(${requestId}):\n${stringifySafe(req.body)}`
    )
  } else if (req.rawBody !== undefined) {
    httpDebugLogger.info(
      `RequestRawBody(${requestId}):\n${stringifySafe(req.rawBody)}`
    )
    conversationLogger.info(
      `===== CONVERSATION ${requestId} =====\n` +
        `REQUEST(raw:${requestId}):\n${stringifySafe(req.rawBody)}`
    )
  }

  // Intercept response to capture body/stream
  const originalWrite = res.write
  const originalEnd = res.end
  const originalJson = res.json
  const originalSend = res.send

  const responseChunks = []
  let isSSE = false

  // Helper to record a chunk
  function recordChunk(chunk) {
    try {
      if (!chunk) return
      if (Buffer.isBuffer(chunk)) {
        responseChunks.push(chunk)
      } else if (typeof chunk === 'string') {
        responseChunks.push(Buffer.from(chunk))
      } else {
        responseChunks.push(Buffer.from(String(chunk)))
      }
    } catch (_) {
      // ignore
    }
  }

  // Patch write/end for streaming(SSE) and generic responses
  res.write = function (chunk, encoding, cb) {
    try {
      const ct = res.getHeader('Content-Type') || res.getHeader('content-type')
      isSSE = isSSE || (ct && String(ct).includes('text/event-stream'))
      if (isSSE) {
        // For SSE, log incrementally to avoid huge memory
        const out = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
        httpDebugLogger.info(`SSE(${requestId}) << ${out}`)
        conversationLogger.info(`SSE(${requestId}) << ${out}`)
      } else {
        recordChunk(chunk)
      }
    } catch (_) {}
    return originalWrite.call(this, chunk, encoding, cb)
  }

  res.end = function (chunk, encoding, cb) {
    try {
      if (chunk && !isSSE) recordChunk(chunk)

      const resHeaders = sanitizeHeaders(res.getHeaders ? res.getHeaders() : {})
      let bodyText = ''
      if (!isSSE) {
        try {
          bodyText = Buffer.concat(responseChunks).toString('utf8')
        } catch (_e) {
          bodyText = '[Uncollectable Body]'
        }
      } else {
        bodyText = '[SSE streamed above]'
      }

      httpDebugLogger.info(
        `Response(${requestId}) Status=${res.statusCode} Content-Type=${res.getHeader('Content-Type') || res.getHeader('content-type') || 'unknown'}\n` +
          `Headers: ${JSON.stringify(resHeaders, null, 2)}\n` +
          `Body:\n${bodyText}`
      )

      conversationLogger.info(
        `RESPONSE(${requestId}):\n${bodyText}`
      )

      conversationLogger.info(`===== END CONVERSATION ${requestId} =====`)
      httpDebugLogger.info(`===== END REQUEST ${requestId} =====`)
    } catch (_) {}
    return originalEnd.call(this, chunk, encoding, cb)
  }

  // Patch json/send to ensure capture for non-stream paths using them directly
  res.json = function (data) {
    try {
      recordChunk(Buffer.from(JSON.stringify(data)))
    } catch (_) {}
    return originalJson.call(this, data)
  }

  res.send = function (body) {
    try {
      recordChunk(body)
    } catch (_) {}
    return originalSend.call(this, body)
  }

  next()
}

module.exports = { debugInterceptor }


