export interface EncryptedSecret {
  ciphertext: string
  nonce: string
}

export async function encryptDeliverySecret(keyMaterial: string, subscriptionId: string, secret: string): Promise<EncryptedSecret> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(subscriptionId) },
    await importKey(keyMaterial),
    new TextEncoder().encode(secret),
  )
  return { ciphertext: encodeBase64(new Uint8Array(ciphertext)), nonce: encodeBase64(nonce) }
}

export async function decryptDeliverySecret(
  keyMaterial: string,
  subscriptionId: string,
  encrypted: EncryptedSecret,
) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64(encrypted.nonce),
      additionalData: new TextEncoder().encode(subscriptionId),
    },
    await importKey(keyMaterial),
    decodeBase64(encrypted.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}

async function importKey(value: string) {
  const bytes = decodeBase64(value)
  if (bytes.byteLength !== 32) throw new Error('DELIVERY_SECRET_KEY must contain exactly 32 bytes.')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function encodeBase64(bytes: Uint8Array) {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

function decodeBase64(value: string) {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}
