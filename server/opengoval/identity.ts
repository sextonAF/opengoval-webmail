import { fromBase64, safeEqual, toBase64Url } from '../../functions/_lib/crypto'

export const LOGIN_DOMAIN = 'opengoval.org'
export const MAIL_HOST = 'web.fxs.se'
export const REVALIDATE_MS = 5 * 60 * 1000

export function normalizeLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._%+-]{0,63}@opengoval\.org$/.test(email) ? email : null
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

async function mac(key: string, purpose: string, value: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = fromBase64(key)
  if (raw.length !== 32) throw new Error('Invalid encryption key')
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  const encoder = new TextEncoder()
  const derived = await crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32),
    info: encoder.encode('opengoval-webmail/' + purpose),
  }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', derived, encoder.encode(value)))
}

const ROUTE_ID = /^[0-9a-f]{64}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export async function sealSession(key: string, objectId: string, token: string): Promise<string> {
  if (!ROUTE_ID.test(objectId) || !TOKEN.test(token)) throw new Error('Invalid session')
  const payload = objectId + '.' + token
  return payload + '.' + toBase64Url(await mac(key, 'session-route-v1', payload))
}

export async function openSession(key: string, value: string | null): Promise<{ objectId: string; token: string } | null> {
  if (!value || value.length !== 152) return null
  const [objectId, token, signature] = value.split('.')
  if (!ROUTE_ID.test(objectId ?? '') || !TOKEN.test(token ?? '') || !TOKEN.test(signature ?? '')) return null
  const expected = await sealSession(key, objectId, token)
  return safeEqual(expected, value) ? { objectId, token } : null
}

export async function mailboxKey(key: string, objectId: string): Promise<Uint8Array<ArrayBuffer>> {
  return mac(key, 'mailbox-encryption-v1', objectId)
}

/** Primary credentials must never be changed via an account edit or import. */
export function primaryPatchAllowed(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const safe = new Set([
    'displayName', 'signature', 'signatureHtml', 'incomingLabelId',
    'autoSync', 'syncIntervalMinutes', 'autoReplyEnabled', 'autoReplySubject',
    'autoReplyBody', 'autoReplyBodyHtml', 'sentFolder', 'autoSavesSent', 'replyAccountId',
  ])
  const fixed: Record<string, unknown> = {
    username: undefined, imapHost: MAIL_HOST, smtpHost: MAIL_HOST,
    imapPort: 993, smtpPort: 465, imapSecurity: 'tls', smtpSecurity: 'tls',
    archiveImapBodies: false, deleteAfterArchive: false,
    storageDriver: 'provider', imapArchiveDriver: 'r2',
  }
  return Object.entries(body).every(([key, value]) =>
    safe.has(key) || (key !== 'username' && Object.hasOwn(fixed, key) && fixed[key] === value))
}
