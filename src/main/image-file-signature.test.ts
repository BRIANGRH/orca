import { describe, expect, it } from 'vitest'
import { detectImageMimeType } from './image-file-signature'

describe('detectImageMimeType', () => {
  it('recognizes png, jpeg, gif and webp signatures', () => {
    expect(detectImageMimeType(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('image/png')
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMimeType(Buffer.from('GIF87a....', 'ascii'))).toBe('image/gif')
    expect(detectImageMimeType(Buffer.from('GIF89a....', 'ascii'))).toBe('image/gif')
    expect(detectImageMimeType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'ascii'))).toBe('image/webp')
  })

  it('rejects non-image and truncated content', () => {
    expect(detectImageMimeType(Buffer.from('not an image at all', 'ascii'))).toBeNull()
    expect(detectImageMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(detectImageMimeType(Buffer.from('89504e47', 'hex'))).toBeNull()
    expect(detectImageMimeType(Buffer.from('RIFF\0\0\0\0WAVE', 'ascii'))).toBeNull()
    expect(detectImageMimeType(new Uint8Array())).toBeNull()
  })
})
