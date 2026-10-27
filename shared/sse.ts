/** Decode SSE across arbitrary byte/UTF-8 boundaries, including CRLF and multi-line data. */
export async function* readSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let data: string[] = []
  function line(value: string) {
    if (value === '') {
      const result = data.length ? { event, data: data.join('\n') } : null
      event = 'message'; data = []
      return result
    }
    if (value.startsWith(':')) return null
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = content
    if (field === 'data') data.push(content)
    return null
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const result = line(buffer.slice(0, index).replace(/\r$/, ''))
        buffer = buffer.slice(index + 1)
        if (result) yield result
      }
      if (done) {
        if (buffer) line(buffer.replace(/\r$/, ''))
        const result = line('')
        if (result) yield result
        break
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
