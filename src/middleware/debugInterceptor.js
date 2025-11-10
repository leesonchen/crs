const winston = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const path = require('path')
const fs = require('fs')
const config = require('../../config/config')

// 增强版logger导入
const logger = require('../utils/logger')

// Ensure logs directory exists
const logsDir = config.logging?.dirname || path.join(__dirname, '..', '..', 'logs')
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 })
}

// 🆕 增强版HTTP调试日志记录器 - 包含更详细的请求信息
const httpDebugLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'http-debug-enhanced-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: config.logging?.maxSize || '20m',
      maxFiles: config.logging?.maxFiles || 10
    })
  ]
})

// 🔍 专门的客户端请求详情日志记录器
const clientRequestLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'client-requests-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: config.logging?.maxSize || '10m',
      maxFiles: config.logging?.maxFiles || 7
    })
  ]
})

// 对话日志记录器（保持现有功能）
const conversationLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
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

// 🔐 增强版敏感信息脱敏
function sanitizeHeaders(headers) {
  const redacted = {}
  const redactKeys = [
    'authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'x-admin-token',
    'cookie',
    'set-cookie',
    'x-auth-token',
    'x-access-token',
    'x-refresh-token',
    'proxy-authorization'
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

// 🛡️ 安全序列化函数
function stringifySafe(obj, maxLength = 5000) {
  try {
    if (typeof obj === 'string') {
      const truncated =
        obj.length > maxLength ? `${obj.substring(0, maxLength)}...[TRUNCATED]` : obj
      return truncated
    }
    const jsonStr = JSON.stringify(obj, null, 2)
    return jsonStr.length > maxLength ? `${jsonStr.substring(0, maxLength)}...[TRUNCATED]` : jsonStr
  } catch (_e) {
    return '[Unserializable Body]'
  }
}

// 🌐 获取真实客户端IP
function getClientIP(req) {
  const xForwardedFor = req.headers['x-forwarded-for']
  const xRealIp = req.headers['x-real-ip']
  const cfConnectingIp = req.headers['cf-connecting-ip']

  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim()
  }
  if (cfConnectingIp) {
    return cfConnectingIp
  }
  if (xRealIp) {
    return xRealIp
  }
  return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'
}

// 📝 生成详细的请求摘要
function generateRequestSummary(req, requestId, startTime) {
  const clientIP = getClientIP(req)
  const userAgent = req.headers['user-agent'] || 'Unknown'
  const contentType = req.headers['content-type'] || 'Unknown'
  const contentLength = req.headers['content-length'] || 'Unknown'
  const accept = req.headers['accept'] || 'Unknown'
  const duration = Date.now() - startTime

  // 构建请求摘要
  const summary = {
    requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    clientIP,
    userAgent: userAgent.length > 200 ? `${userAgent.substring(0, 200)}...[TRUNCATED]` : userAgent,
    contentType,
    contentLength,
    accept,
    referer: req.headers['referer'] || req.headers['referrer'] || 'None',
    duration: `${duration}ms`,
    httpVersion: req.httpVersion,
    protocol: req.protocol,
    secure: req.secure || false
  }

  return summary
}

// 🆕 增强版Express中间件 - 捕获完整的请求/响应用于调试
function debugInterceptor(req, res, next) {
  const requestId =
    req.requestId || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const startTime = Date.now()

  // 添加请求ID到请求对象，方便后续使用
  req.requestId = requestId

  // 生成详细的请求摘要
  const summary = generateRequestSummary(req, requestId, startTime)

  // 在主日志中记录请求摘要 - 让调试信息更显眼
  logger.info(
    `🔍 CLIENT REQUEST [${requestId}] ${req.method} ${summary.url} from ${summary.clientIP} (${summary.duration}) - UA: ${summary.userAgent}`,
    {
      type: 'client-request',
      requestId,
      method: req.method,
      url: summary.url,
      clientIP: summary.clientIP,
      userAgent: summary.userAgent,
      duration: summary.duration
    }
  )

  // 记录详细的客户端请求信息
  clientRequestLogger.info(
    `===== CLIENT REQUEST ${requestId} =====\n` +
      `时间: ${summary.timestamp}\n` +
      `方法: ${summary.method}\n` +
      `URL: ${summary.url}\n` +
      `路径: ${summary.path}\n` +
      `客户端IP: ${summary.clientIP}\n` +
      `用户代理: ${summary.userAgent}\n` +
      `内容类型: ${summary.contentType}\n` +
      `内容长度: ${summary.contentLength}\n` +
      `接受类型: ${summary.accept}\n` +
      `来源页面: ${summary.referer}\n` +
      `HTTP版本: ${summary.httpVersion}\n` +
      `协议: ${summary.protocol} (${summary.secure ? '安全' : '非安全'})\n` +
      `处理耗时: ${summary.duration}`
  )

  const reqHeaders = sanitizeHeaders(req.headers)

  // 记录HTTP请求行和头部信息
  httpDebugLogger.info(
    `===== BEGIN REQUEST ${requestId} =====\n` +
      `${req.method} ${req.originalUrl}\n` +
      `客户端: ${summary.clientIP}\n` +
      `用户代理: ${summary.userAgent}\n` +
      `请求头: ${JSON.stringify(reqHeaders, null, 2)}`
  )

  // 🆕 增强的请求体记录逻辑
  let requestBodyLogged = false

  // 方法1：检查解析后的请求体
  if (req.body !== undefined) {
    const bodyStr = stringifySafe(req.body, 10000) // 增加长度限制
    if (bodyStr !== '{}' && bodyStr !== '[]' && bodyStr.trim() !== '') {
      httpDebugLogger.info(`解析后请求体 (${requestId}):\n${bodyStr}`)
      clientRequestLogger.info(`请求体内容 (${requestId}):\n${bodyStr}`)
      conversationLogger.info(
        `===== CONVERSATION ${requestId} =====\nREQUEST(${requestId}):\n${bodyStr}`
      )
      requestBodyLogged = true
    } else {
      clientRequestLogger.info(`请求体为空对象 (${requestId}): ${bodyStr}`)
    }
  }

  // 方法2：检查原始请求体（如果解析后的为空）
  if (!requestBodyLogged && req.rawBody !== undefined) {
    if (typeof req.rawBody === 'string' && req.rawBody.length > 0) {
      const rawBodyStr = stringifySafe(req.rawBody, 10000)
      httpDebugLogger.info(`原始请求体 (${requestId}):\n${rawBodyStr}`)
      clientRequestLogger.info(`原始请求体内容 (${requestId}):\n${rawBodyStr}`)
      requestBodyLogged = true
    } else if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
      const rawBodyStr = stringifySafe(req.rawBody.toString('utf8'), 10000)
      httpDebugLogger.info(`原始请求体 (${requestId}):\n${rawBodyStr}`)
      clientRequestLogger.info(`原始请求体内容 (${requestId}):\n${rawBodyStr}`)
      requestBodyLogged = true
    }
  }

  // 方法3：检查content-length，如果明确有内容但没解��到，也记录
  if (
    !requestBodyLogged &&
    req.headers['content-length'] &&
    parseInt(req.headers['content-length']) > 0
  ) {
    clientRequestLogger.info(
      `⚠️ 注意 (${requestId}): 检测到Content-Length为 ${req.headers['content-length']}，但请求体未被解析或为空`
    )
  }

  // 总是记录是否有请求体
  const hasBody = req.body !== undefined || (req.rawBody !== undefined && req.rawBody.length > 0)
  const contentLength = req.headers['content-length'] || 'unknown'
  clientRequestLogger.info(
    `📋 请求体状态 (${requestId}): 有数据=${hasBody}, Content-Length=${contentLength}, Content-Type=${req.headers['content-type'] || 'none'}`
  )

  // 拦截响应以捕获body/stream
  const originalWrite = res.write
  const originalEnd = res.end
  const originalJson = res.json
  const originalSend = res.send

  const responseChunks = []
  const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB 限制防止内存泄漏
  let totalResponseSize = 0
  let isSSE = false
  let responseStartTime = 0

  // 记录响应开始
  const recordResponseStart = () => {
    if (!responseStartTime) {
      responseStartTime = Date.now()
      const responseTime = responseStartTime - startTime
      logger.info(
        `📤 CLIENT RESPONSE START [${requestId}] Status: ${res.statusCode} (${responseTime}ms)`,
        {
          type: 'client-response-start',
          requestId,
          statusCode: res.statusCode,
          responseTime
        }
      )
    }
  }

  // Helper to record a chunk (带大小限制)
  function recordChunk(chunk) {
    try {
      if (!chunk || totalResponseSize >= MAX_RESPONSE_SIZE) {
        return
      }
      let chunkBuffer
      if (Buffer.isBuffer(chunk)) {
        chunkBuffer = chunk
      } else if (typeof chunk === 'string') {
        chunkBuffer = Buffer.from(chunk)
      } else {
        chunkBuffer = Buffer.from(String(chunk))
      }

      // 检查是否会超出限制
      if (totalResponseSize + chunkBuffer.length > MAX_RESPONSE_SIZE) {
        const remainingSize = MAX_RESPONSE_SIZE - totalResponseSize
        if (remainingSize > 0) {
          responseChunks.push(chunkBuffer.slice(0, remainingSize))
          totalResponseSize = MAX_RESPONSE_SIZE
          clientRequestLogger.info(`⚠️ 响应体已截断 (${requestId}): 达到 ${MAX_RESPONSE_SIZE / 1024 / 1024}MB 限制`)
        }
        return
      }

      responseChunks.push(chunkBuffer)
      totalResponseSize += chunkBuffer.length
    } catch (_) {
      // ignore chunk recording errors
    }
  }

  // Patch write/end for streaming(SSE) and generic responses
  res.write = function (chunk, encoding, cb) {
    try {
      recordResponseStart()

      const ct = res.getHeader('Content-Type') || res.getHeader('content-type')
      isSSE = isSSE || (ct && String(ct).includes('text/event-stream'))
      if (isSSE) {
        // For SSE, log incrementally to avoid huge memory
        const out = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
        const sseLine = out.length > 500 ? `${out.substring(0, 500)}...[TRUNCATED]` : out
        httpDebugLogger.info(`SSE数据流 (${requestId}): ${sseLine}`)
        conversationLogger.info(`SSE流 (${requestId}): ${sseLine}`)
      } else {
        recordChunk(chunk)
      }
    } catch (_) {
      // Silent catch for debug interceptor errors
    }
    return originalWrite.call(this, chunk, encoding, cb)
  }

  res.end = function (chunk, encoding, cb) {
    try {
      recordResponseStart()

      if (chunk && !isSSE) {
        recordChunk(chunk)
      }

      const resHeaders = sanitizeHeaders(res.getHeaders ? res.getHeaders() : {})
      let bodyText = ''
      const totalDuration = Date.now() - startTime

      if (!isSSE) {
        try {
          bodyText = Buffer.concat(responseChunks).toString('utf8')
          // 额外的截断保护（10KB）
          if (bodyText.length > 10000) {
            bodyText = `${bodyText.substring(0, 10000)}...[RESPONSE TRUNCATED]`
          }
        } catch (_e) {
          bodyText = '[Uncollectable Body]'
        }
      } else {
        bodyText = '[SSE Streamed Above]'
      }

      // 记录完整的响应信息
      httpDebugLogger.info(
        `===== RESPONSE ${requestId} =====\n` +
          `状态码: ${res.statusCode}\n` +
          `内容类型: ${res.getHeader('Content-Type') || res.getHeader('content-type') || 'unknown'}\n` +
          `响应大小: ${totalResponseSize} bytes (${(totalResponseSize / 1024).toFixed(2)} KB)\n` +
          `响应头: ${JSON.stringify(resHeaders, null, 2)}\n` +
          `响应体: ${bodyText}\n` +
          `总耗时: ${totalDuration}ms`
      )

      // 记录到客户端请求日志
      clientRequestLogger.info(
        `===== RESPONSE ${requestId} =====\n` +
          `状态码: ${res.statusCode}\n` +
          `响应大小: ${totalResponseSize} bytes (${(totalResponseSize / 1024).toFixed(2)} KB)\n` +
          `响应头: ${JSON.stringify(resHeaders, null, 2)}\n` +
          `响应内容: ${bodyText}\n` +
          `处理耗时: ${totalDuration}ms`
      )

      // 记录到对话日志
      if (!isSSE) {
        conversationLogger.info(`RESPONSE (${requestId}):\n${bodyText}`)
      }

      conversationLogger.info(`===== END CONVERSATION ${requestId} =====`)
      httpDebugLogger.info(`===== END REQUEST ${requestId} =====`)

      // 在主日志中记录响应完成
      const level = res.statusCode >= 400 ? 'error' : res.statusCode >= 300 ? 'warn' : 'info'
      const emoji = res.statusCode >= 400 ? '❌' : res.statusCode >= 300 ? '⚠️' : '✅'
      logger[level](
        `${emoji} CLIENT RESPONSE [${requestId}] ${res.statusCode} - ${totalDuration}ms`,
        {
          type: 'client-response',
          requestId,
          statusCode: res.statusCode,
          totalDuration
        }
      )
    } catch (_) {
      // Silent catch for debug interceptor errors
    }
    return originalEnd.call(this, chunk, encoding, cb)
  }

  // Patch json/send to ensure capture for non-stream paths using them directly
  res.json = function (data) {
    try {
      recordChunk(Buffer.from(JSON.stringify(data)))
    } catch (_) {
      // Silent catch for debug interceptor errors
    }
    return originalJson.call(this, data)
  }

  res.send = function (body) {
    try {
      recordChunk(body)
    } catch (_) {
      // Silent catch for debug interceptor errors
    }
    return originalSend.call(this, body)
  }

  next()
}

module.exports = { debugInterceptor }
