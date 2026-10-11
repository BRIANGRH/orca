export type SignedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

/** Detects the image format from the file's leading bytes, ignoring its extension. */
export function detectImageMimeType(bytes: Uint8Array): SignedImageMimeType | null {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    /^GIF8[79]a$/.test(Buffer.from(bytes.subarray(0, 6)).toString('ascii'))
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}
