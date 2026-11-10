import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { ToolBridge } from '../mcp-bridge.mjs'

function post(bridge, pathname) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': bridge.token },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
  })
}

test('MCP accepts only the exact /mcp pathname, with optional query strings', async (t) => {
  const bridge = await new ToolBridge(() => {}).start()
  t.after(() => bridge.close())
  for (const pathname of ['/mcp', '/mcp?transport=http', '/mcp?next=/mcp-other']) {
    const response = await post(bridge, pathname)
    assert.equal(response.status, 200, pathname)
    assert.deepEqual(JSON.parse(response.body), { jsonrpc: '2.0', id: 1, result: {} })
  }
  for (const pathname of ['/mcp-other', '/mcp/child', '/mcp/', '/mcpx?transport=http', '/?path=/mcp']) {
    const response = await post(bridge, pathname)
    assert.equal(response.status, 404, pathname)
  }
})
