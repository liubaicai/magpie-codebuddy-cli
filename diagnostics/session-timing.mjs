// Read a DSH v4 trace for timing metadata only. Never emit message/tool contents.
import fs from "node:fs"
import zlib from "node:zlib"

const filename = process.argv[2]
if (!filename) throw new Error("Usage: node diagnostics/session-timing.mjs <session.v4.jsonl.zstd>")
let bytes = fs.readFileSync(filename)
let text = ""
while (bytes.length) {
  const frame = zlib.zstdDecompressSync(bytes, { info: true })
  if (!(frame.engine.bytesWritten > 0)) throw new Error("Invalid compressed frame")
  text += frame.buffer.toString("utf8")
  bytes = bytes.subarray(frame.engine.bytesWritten)
}
const records = text.trim().split("\n").map((line) => JSON.parse(line))
const cutoff = Number(process.argv[3] ?? 0)
const date = (time) => time ? new Date(time).toISOString() : undefined
for (const row of records) {
  if (row.time < cutoff) continue
  const data = row.data
  if (row.type === "model/selection") {
    console.log(JSON.stringify({ type: row.type, time: date(row.time), provider: data.provider, model: data.model, effort: data.reasoningEffort }))
  } else if (["turn/start", "step/start", "step/end", "turn/end"].includes(row.type)) {
    console.log(JSON.stringify({ type: row.type, time: date(row.time) }))
  } else if (row.type === "request/header") {
    const header = data.header
    console.log(JSON.stringify({ type: row.type, time: date(row.time), configKeys: Object.keys(header?.config ?? {}),
      tools: header?.tools?.length, toolsBytes: Buffer.byteLength(JSON.stringify(header?.tools ?? [])),
      configBytes: Buffer.byteLength(JSON.stringify(header?.config ?? {})) }))
  } else if (row.type === "assistant/message") {
    const first = {}
    const counts = {}
    const last = {}
    const mark = (kind, time, size = 0) => {
      if (!(kind in first)) first[kind] = date(time)
      last[kind] = date(time)
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    for (const event of data.stream ?? []) {
      if (event.type === "chunk") {
        const chunk = event.chunk
        const kind = chunk.type
        if (kind.endsWith("-delta")) {
          if (typeof chunk.delta === "string" && chunk.delta.trim()) mark(kind, event.time, chunk.delta.length)
        } else mark(kind, event.time)
      } else if (event.type.endsWith("-chunks")) {
        let time = event.time0
        for (let i = 0; i < (event.dt?.length ?? 0); i++) {
          time += event.dt[i]
          if (event.texts?.[i]?.trim()) mark(event.type, time, event.texts[i].length)
        }
      }
    }
    const content = data.message?.content ?? []
    console.log(JSON.stringify({ type: row.type, time: date(row.time), first, last, counts,
      blocks: Array.isArray(content) ? content.map((block) => ({ type: block.type,
        size: (block.text ?? block.thinking ?? block.content ?? "").length })) : [] }))
  }
}
