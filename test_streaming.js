const http = require('http')

async function testStreaming() {
  const postData = JSON.stringify({
    model: 'gpt-5',
    input: [
      { role: 'user', content: 'Write a simple Python function that calculates the factorial of a number' }
    ],
    stream: true
  })

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/openai/v1/responses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer cr_098eae66053645d044213bda651107389c7f9e68dcec40e83c21156f079a0987',
      'Content-Length': Buffer.byteLength(postData)
    }
  }

  console.log('Starting streaming request...')

  const req = http.request(options, (res) => {
    console.log(`Response status: ${res.statusCode}`)
    console.log(`Response headers:`, res.headers)

    let buffer = ''

    res.on('data', (chunk) => {
      buffer += chunk.toString()

      // Process complete SSE events
      const lines = buffer.split('\n')
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            console.log('Received event:', JSON.stringify(data, null, 2))
          } catch (e) {
            console.log('Raw line:', line)
          }
        }
      }

      // Keep incomplete last line
      if (lines.length > 0) {
        buffer = lines[lines.length - 1]
      } else {
        buffer = ''
      }
    })

    res.on('end', () => {
      console.log('\nStream completed')
    })

    res.on('error', (err) => {
      console.error('Stream error:', err)
    })
  })

  req.on('error', (err) => {
    console.error('Request error:', err)
  })

  req.write(postData)
  req.end()
}

testStreaming().catch(console.error)