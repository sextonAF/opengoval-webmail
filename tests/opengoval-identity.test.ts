import { describe, expect, it } from 'vitest'
import { toBase64 } from '../functions/_lib/crypto'
import { mailboxKey, normalizeLogin, openSession, primaryPatchAllowed, sealSession, validPassword } from '../server/opengoval/identity'

const secret = toBase64(new Uint8Array(32).fill(9))
const otherSecret = toBase64(new Uint8Array(32).fill(8))
const adminId = 'a'.repeat(64)
const pressId = 'b'.repeat(64)
const token = 'x'.repeat(43)

describe('OpenGovAL IMAP identity boundary', () => {
  it('normalizes only OpenGovAL mailbox identities', () => {
    expect(normalizeLogin(' Admin@OpenGovAL.org ')).toBe('admin@opengoval.org')
    for (const bad of ['admin@gmail.com', 'admin@opengoval.org.evil.test', 'admin@evil.test', 'admin', '@opengoval.org', 'a\n@opengoval.org', null]) {
      expect(normalizeLogin(bad)).toBeNull()
    }
  })
  it('accepts existing provider passwords without imposing an application password policy', () => {
    expect(validPassword('valid')).toBe(true)
    expect(validPassword('')).toBe(false)
    expect(validPassword('line\r\nbreak')).toBe(false)
    expect(validPassword('a'.repeat(501))).toBe(false)
  })
  it('rejects routing an authenticated session into another user database', async () => {
    const sealed = await sealSession(secret, adminId, token)
    expect(await openSession(secret, sealed)).toEqual({ objectId: adminId, token })
    expect(await openSession(secret, sealed.replace(adminId, pressId))).toBeNull()
    expect(await openSession(secret, sealed.replace(token, 'y'.repeat(43)))).toBeNull()
    expect(await openSession(otherSecret, sealed)).toBeNull()
    expect(await openSession(secret, token)).toBeNull()
    expect(await openSession(secret, null)).toBeNull()
  })
  it('derives distinct, stable keys for separate users', async () => {
    expect(await mailboxKey(secret, adminId)).toEqual(await mailboxKey(secret, adminId))
    expect(await mailboxKey(secret, adminId)).not.toEqual(await mailboxKey(secret, pressId))
  })
  it('prevents redirecting managed mailbox credentials to a different server', () => {
    expect(primaryPatchAllowed({ displayName: 'OpenGovAL', smtpHost: 'web.fxs.se', imapPort: 993, username: 'admin@opengoval.org' }, 'admin@opengoval.org')).toBe(true)
    for (const patch of [
      { imapHost: 'evil.test' }, { smtpHost: 'evil.test' },
      { username: 'press@opengoval.org' }, { password: 'replacement' },
      { smtpPort: 25 }, { deleteAfterArchive: true }, { archiveImapBodies: true },
    ]) expect(primaryPatchAllowed(patch, 'admin@opengoval.org')).toBe(false)
  })
})
