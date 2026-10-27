import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/** Minimal ZIP reader for model imports: central directory only, stored/deflate, no ZIP64, no encryption. */
export type ZipEntry = {
  name: string; method: number; compressed: number; size: number; crc: number; offset: number
  directory: boolean; symlink: boolean; encrypted: boolean
}
export class ZipError extends Error {}

const decoders = ['big5', 'gbk'].flatMap(label => { try { return [new TextDecoder(label, { fatal: true })] } catch { return [] } })
/** Names are UTF-8 when flagged; Windows archives often use Big5/GBK, so try those before Latin-1. */
function decodeName(bytes: Buffer, utf8: boolean) {
  for (const decoder of [new TextDecoder('utf-8', { fatal: true }), ...(utf8 ? [] : decoders)]) {
    try { return decoder.decode(bytes) } catch { /* try the next encoding */ }
  }
  return bytes.toString('latin1')
}

export function readZipEntries(zip: Buffer, maxEntries: number): ZipEntry[] {
  // The end-of-central-directory record sits within the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new ZipError('不是有效的 ZIP 檔。')
  const count = zip.readUInt16LE(eocd + 10), size = zip.readUInt32LE(eocd + 12), start = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError('不支援 ZIP64 壓縮檔，請改用一般 ZIP 重新壓縮。')
  if (count > maxEntries) throw new ZipError(`壓縮檔內檔案太多（上限 ${maxEntries} 個）。`)
  if (start + size > eocd) throw new ZipError('ZIP 目錄損毀。')
  const entries: ZipEntry[] = []
  let at = start
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new ZipError('ZIP 目錄損毀。')
    const madeBy = zip.readUInt16LE(at + 4), flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16), compressed = zip.readUInt32LE(at + 20), uncompressed = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32)
    const external = zip.readUInt32LE(at + 38), offset = zip.readUInt32LE(at + 42)
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) throw new ZipError('不支援 ZIP64 壓縮檔，請改用一般 ZIP 重新壓縮。')
    const name = decodeName(zip.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0)
    const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0
    entries.push({ name, method, compressed, size: uncompressed, crc, offset, directory: name.endsWith('/') || name.endsWith('\\'), symlink: (unixMode & 0o170000) === 0o120000, encrypted: (flags & 1) !== 0 })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Inflate one entry; the declared size caps the output so a lying header cannot expand without bound. */
export function extractEntry(zip: Buffer, entry: ZipEntry): Buffer {
  if (entry.encrypted) throw new ZipError(`不支援加密的檔案：${entry.name}`)
  const at = entry.offset
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== 0x04034b50) throw new ZipError(`ZIP 檔案資料損毀：${entry.name}`)
  const begin = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28), end = begin + entry.compressed
  if (end > zip.length) throw new ZipError(`ZIP 檔案資料不完整：${entry.name}`)
  const raw = zip.subarray(begin, end)
  let data: Buffer
  if (entry.method === 0) data = Buffer.from(raw)
  else if (entry.method === 8) {
    try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) }
    catch { throw new ZipError(`無法解壓縮：${entry.name}`) }
  } else throw new ZipError(`不支援的壓縮方式（${entry.method}）：${entry.name}`)
  if (data.length !== entry.size || (crc32(data) >>> 0) !== entry.crc) throw new ZipError(`檔案內容與 ZIP 記錄不符：${entry.name}`)
  return data
}

/** Write a ZIP (stored or deflated). Used by tests and handy for building fixtures. */
export function writeZip(files: { name: string; data: Buffer | string; deflate?: boolean; mode?: number }[]) {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const body = file.deflate ? deflateRawSync(data) : data, name = Buffer.from(file.name, 'utf8'), crc = crc32(data) >>> 0
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(file.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(file.mode ? (3 << 8) | 20 : 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(file.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((file.mode ?? 0) << 16 >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, name, body); centrals.push(central, name); offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
