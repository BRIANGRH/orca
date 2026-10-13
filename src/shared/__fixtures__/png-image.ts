// A real, decodable PNG for tests that need an image a decoder accepts, not just bytes named .png.

import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An RGB PNG of `width` x `height`, a gradient so rows differ. `stored` writes the pixels
 *  uncompressed, which makes a large file from modest dimensions. */
export function pngImage(
  width: number,
  height: number,
  options: { stored?: boolean } = {}
): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // 8-bit depth, truecolor, deflate, adaptive filtering, no interlace.
  header.set([8, 2, 0, 0, 0], 8)
  const row = 1 + width * 3
  const pixels = Buffer.alloc(row * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set([x & 0xff, y & 0xff, (x + y) & 0xff], y * row + 1 + x * 3)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: options.stored ? 0 : 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
