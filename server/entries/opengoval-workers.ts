import schema from '../../db/schema.sql'
import { APP_VERSION } from '../../shared/version'
import { clearedSessionCookie, createSession, decryptString, encryptString, readCookie, sessionCookie, toBase64, verifySession } from '../../functions/_lib/crypto'
import type { Env } from '../../functions/_lib/env'
import { fail, json } from '../../functions/_lib/http'
import { ImapConnection } from '../../functions/_lib/imap/client'
import { runScheduledTasks } from '../../functions/api/cron/notifications'
import { handleRequest, SECURITY_HEADERS } from '../app'
import { registerWorkersSockets } from '../adapters/sockets/workers'
import { DurableDatabase } from '../opengoval/durable-db'
import { MAIL_HOST, REVALIDATE_MS, mailboxKey, normalizeLogin, openSession, primaryPatchAllowed, sealSession, validPassword } from '../opengoval/identity'
import { matchRoute } from '../router'

registerWorkersSockets()

interface MultiuserEnv {
  MAILBOXES: DurableObjectNamespace
  LOGIN_LIMITER: DurableObjectNamespace
  TOKEN_ENC_KEY: string
}

interface Identity {
  email: string
  account_id: string
  secret_enc: string
  verified_at: number
}

const LOGIN = '/api/auth/login'
const LOGOUT = '/api/auth/logout'
const HEALTH = '/api/health'
const SCHEMA_VERSION = 1
const MAX_LOGIN_BYTES = 4096
const SESSION_COOKIE = 'mc_session'

function pathOf(request: Request): string {
  return new URL(request.url).pathname.replace(/\/+$/, '')
}

function secure(response: Response, extra?: HeadersInit): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value)
  headers.set('Cache-Control', 'private, no-store')
  for (const [key, value] of new Headers(extra)) headers.set(key, value)
  return new Response(response.body, { status: response.status, headers })
}

function unauthorized(): Response {
  return fail('Authentication required', 401, undefined, 'unauthorized')
}

function invalidLogin(): Response {
  return fail('Invalid email address or password', 401, undefined, 'login_failed')
}

function blocked(): Response {
  return fail('This feature is not available in OpenGovAL multi-user beta', 403, undefined, 'feature_unavailable')
}

function blockedRoute(path: string): boolean {
  return path === '/api/auth/2fa' || path === '/api/auth/totp' ||
    path.startsWith('/api/config/') || path.startsWith('/api/cron/') ||
    path.startsWith('/api/push/') || path.includes('/oauth/')
}

async function credentials(request: Request): Promise<{ email: string; password: string } | null> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > MAX_LOGIN_BYTES) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_LOGIN_BYTES) { await reader.cancel(); return null }
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const body = JSON.parse(new TextDecoder().decode(bytes))
    const email = normalizeLogin(body?.email)
    return email && validPassword(body?.password) ? { email, password: body.password } : null
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

async function verifyImap(email: string, password: string): Promise<void> {
  const connection = await ImapConnection.open({ host: MAIL_HOST, port: 993, security: 'tls' })
  try {
    await connection.login(email, password)
  } finally {
    await connection.logout()
  }
}

/** Rate limits are private Durable Objects, not public API endpoints.
 * Count all attempts, not only failures, to bound concurrent login attempts.
 */
export class LoginLimiter {
  private readonly state: DurableObjectState
  constructor(state: DurableObjectState) { this.state = state }
  async fetch(): Promise<Response> {
    const now = Date.now()
    const allowed = await this.state.storage.transaction(async txn => {
      const old = await txn.get<{ start: number; count: number }>('attempts')
      const attempts = old && now - old.start < 15 * 60 * 1000 ? old : { start: now, count: 0 }
      if (attempts.count >= 10) return false
      await txn.put('attempts', { ...attempts, count: attempts.count + 1 })
      return true
    })
    // Remove expired rate-limit state; no mail or credential data lives here.
    await this.state.storage.setAlarm(now + 15 * 60 * 1000)
    return new Response(null, { status: allowed ? 204 : 429 })
  }
  async alarm(): Promise<void> {
    const old = await this.state.storage.get<{ start: number; count: number }>('attempts')
    if (old && Date.now() - old.start < 15 * 60 * 1000) {
      await this.state.storage.setAlarm(old.start + 15 * 60 * 1000)
    } else {
      await this.state.storage.delete('attempts')
    }
  }
}

/** Exactly one private SQLite database per normalized mailbox login.
 * No code path in this class binds the legacy shared D1 database.
 */
export class MailboxUser {
  private readonly state: DurableObjectState
  private readonly bindings: MultiuserEnv
  private readonly envPromise: Promise<Env>
  private authQueue: Promise<unknown> = Promise.resolve()

  constructor(state: DurableObjectState, bindings: MultiuserEnv) {
    this.state = state
    this.bindings = bindings
    this.envPromise = this.createEnv()
  }

  private async createEnv(): Promise<Env> {
    const key = toBase64(await mailboxKey(this.bindings.TOKEN_ENC_KEY, this.state.id.toString()))
    // Deliberately exclude shared R2, relay, OAuth and push secrets. Those
    // integrations need their own tenant-scoped authorization before enabling.
    return {
      DB: new DurableDatabase(this.state.storage).asD1(),
      TOKEN_ENC_KEY: key,
      APP_PASSWORD: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      UPDATE_CHECK: 'off',
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.authQueue.then(task)
    this.authQueue = result.catch(() => undefined)
    return result
  }

  private async initialize(): Promise<void> {
    const version = await this.state.storage.get<number>('schema-version')
    if (version === SCHEMA_VERSION) return
    if (version !== undefined) throw new Error('Mailbox schema migration required')
    const sql = this.state.storage.sql
    this.state.storage.transactionSync(() => {
      sql.exec(schema).toArray()
      sql.exec(`CREATE TABLE IF NOT EXISTS opengoval_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        email TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL UNIQUE,
        secret_enc TEXT NOT NULL, verified_at INTEGER NOT NULL
      )`).toArray()
    })
    await this.state.storage.put('schema-version', SCHEMA_VERSION)
  }

  private identity(): Identity | null {
    return this.state.storage.sql.exec('SELECT email, account_id, secret_enc, verified_at FROM opengoval_identity WHERE singleton = 1').toArray()[0] as unknown as Identity ?? null
  }

  private async login(request: Request): Promise<Response> {
    const body = await credentials(request)
    if (!body) return invalidLogin()
    const { email, password } = body
    if (!this.state.id.equals(this.bindings.MAILBOXES.idFromName(email))) return invalidLogin()
    try { await verifyImap(email, password) } catch { return invalidLogin() }
    // No database/profile is initialized before successful provider login.
    await this.initialize()
    const env = await this.envPromise
    const old = this.identity()
    if (old && old.email !== email) throw new Error('Mailbox identity mismatch')
    const changed = old ? !(await decryptString(env, old.secret_enc) === password) : false
    const encrypted = await encryptString(env, password)
    const id = old?.account_id ?? crypto.randomUUID()
    const sql = this.state.storage.sql
    this.state.storage.transactionSync(() => {
      if (changed) sql.exec('DELETE FROM sessions').toArray()
      sql.exec(`INSERT INTO accounts
        (id, email, display_name, kind, imap_host, imap_port, imap_security,
         smtp_host, smtp_port, smtp_security, username, auth_type, secret_enc,
         storage_driver, created_at)
        VALUES (?, ?, ?, 'imap', ?, 993, 'tls', ?, 465, 'tls', ?, 'password', ?, 'provider', ?)
        ON CONFLICT(id) DO UPDATE SET
          email=excluded.email, username=excluded.username, kind='imap',
          imap_host=excluded.imap_host, imap_port=993, imap_security='tls',
          smtp_host=excluded.smtp_host, smtp_port=465, smtp_security='tls',
          auth_type='password', secret_enc=excluded.secret_enc,
          oauth_provider=NULL, access_token_enc=NULL, access_token_expires_at=NULL,
          archive_imap_bodies=0, delete_after_archive=0, storage_driver='provider'`,
        id, email, email, MAIL_HOST, MAIL_HOST, email, encrypted, new Date().toISOString()).toArray()
      sql.exec(`INSERT INTO opengoval_identity (singleton, email, account_id, secret_enc, verified_at)
        VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
        secret_enc=excluded.secret_enc, verified_at=excluded.verified_at`,
        email, id, encrypted, Date.now()).toArray()
    })
    const token = await createSession(env, request)
    await this.state.storage.setAlarm(Date.now() + REVALIDATE_MS)
    // Internal response only. The public Worker consumes the token and
    // returns an HttpOnly signed routing cookie, never a token in JSON.
    return json({ token })
  }

  private async revalidate(env: Env, force = false): Promise<boolean> {
    const identity = this.identity()
    if (!identity) return false
    if (!force && Date.now() - identity.verified_at < REVALIDATE_MS) return true
    try {
      await verifyImap(identity.email, await decryptString(env, identity.secret_enc))
      this.state.storage.sql.exec('UPDATE opengoval_identity SET verified_at = ? WHERE singleton = 1', Date.now()).toArray()
      return true
    } catch {
      // Fail closed on a revoked/changed password or provider outage. Never
      // continue exposing cached mail when the provider cannot authenticate.
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec('DELETE FROM sessions').toArray()
        this.state.storage.sql.exec('UPDATE opengoval_identity SET verified_at = 0 WHERE singleton = 1').toArray()
        this.state.storage.sql.exec('UPDATE accounts SET secret_enc = NULL WHERE id = ?', identity.account_id).toArray()
      })
      await this.state.storage.deleteAlarm()
      return false
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = pathOf(request)
    if (path === LOGIN && request.method === 'POST') return this.serial(() => this.login(request))
    if (blockedRoute(path)) return blocked()
    if (path === LOGIN || path === HEALTH) return unauthorized()
    const version = await this.state.storage.get<number>('schema-version')
    if (version !== SCHEMA_VERSION) return unauthorized()
    const env = await this.envPromise
    const token = readCookie(request, SESSION_COOKIE)
    const allowed = await this.serial(async () =>
      await verifySession(env, token) && (path === LOGOUT || await this.revalidate(env)))
    if (!allowed) return unauthorized()

    const route = matchRoute(new URL(request.url).pathname)
    if (route?.route.path === '/api/accounts/:id' && route.params.id === this.identity()?.account_id) {
      if (request.method === 'DELETE') return fail('The primary mailbox is managed by the mail server', 403)
      if (request.method === 'PATCH' || request.method === 'PUT') {
        const patch = await request.clone().json().catch(() => null)
        if (!primaryPatchAllowed(patch)) return fail('Primary mailbox connection settings are managed by the mail server', 403)
      }
    }
    if (path === '/api/accounts' && request.method === 'POST') {
      const body = await request.clone().json().catch(() => null) as { kind?: string; authType?: string } | null
      if (!body || body.kind !== 'imap' || (body.authType && body.authType !== 'password')) return blocked()
    }

    return handleRequest(request, env, {
      authenticationMode: 'imap',
      waitUntil: promise => this.state.waitUntil(promise),
    })
  }

  async alarm(): Promise<void> {
    if (await this.state.storage.get<number>('schema-version') !== SCHEMA_VERSION) return
    const env = await this.envPromise
    const allowed = await this.serial(async () => {
      const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?')
        .bind(Math.floor(Date.now() / 1000)).first<{ n: number }>()
      return Boolean(active?.n) && await this.revalidate(env, true)
    })
    if (!allowed) return
    try {
      await runScheduledTasks(env)
    } finally {
      await this.state.storage.setAlarm(Date.now() + REVALIDATE_MS)
    }
  }
}

async function login(request: Request, env: MultiuserEnv): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const ipLimit = await env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName('ip:' + ip)).fetch('https://internal/limit')
  if (ipLimit.status !== 204) return fail('Too many attempts', 429, undefined, 'too_many_attempts', { 'Retry-After': '900' })
  const body = await credentials(request)
  if (!body) return invalidLogin()
  const accountLimit = await env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName('mailbox:' + body.email)).fetch('https://internal/limit')
  if (accountLimit.status !== 204) return fail('Too many attempts', 429, undefined, 'too_many_attempts', { 'Retry-After': '900' })
  const id = env.MAILBOXES.idFromName(body.email)
  const response = await env.MAILBOXES.get(id).fetch(new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'User-Agent': request.headers.get('User-Agent') ?? '' },
    body: JSON.stringify(body),
  }))
  if (!response.ok) return response
  const { token } = await response.json() as { token: string }
  const sealed = await sealSession(env.TOKEN_ENC_KEY, id.toString(), token)
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sealed, true) })
}

export default {
  async fetch(request: Request, env: MultiuserEnv): Promise<Response> {
    try {
      const url = new URL(request.url)
      const path = pathOf(request)
      if (url.protocol !== 'https:') return secure(fail('HTTPS required', 400))
      const origin = request.headers.get('Origin')
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && origin !== url.origin) {
        return secure(fail('Origin not allowed', 403, undefined, 'invalid_origin'))
      }
      if (path === HEALTH && ['GET', 'HEAD'].includes(request.method)) {
        return secure(json({
          ok: true, version: APP_VERSION, driveConfigured: false, r2Configured: false,
          relayConfigured: false, relayProvider: 'smtp2go', relayLabel: 'SMTP2GO',
          maxAttachmentBytes: 15 * 1024 * 1024, microsoftConfigured: false,
          googleMailConfigured: false, pushConfigured: false, cronConfigured: true,
          authenticationMode: 'imap',
        }))
      }
      if (path === LOGIN && request.method === 'POST') return secure(await login(request, env))
      if (blockedRoute(path)) return secure(blocked())

      const session = await openSession(env.TOKEN_ENC_KEY, readCookie(request, SESSION_COOKIE))
      if (!session) {
        if (path === LOGOUT && request.method === 'POST') {
          return secure(json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(true) }))
        }
        return secure(unauthorized())
      }
      const headers = new Headers(request.headers)
      headers.delete('Cookie')
      headers.set('Cookie', SESSION_COOKIE + '=' + session.token)
      const id = env.MAILBOXES.idFromString(session.objectId)
      const result = await env.MAILBOXES.get(id).fetch(new Request(request, { headers }))
      if (path === LOGOUT && request.method === 'POST' && (result.ok || result.status === 401)) {
        return secure(json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(true) }))
      }
      // Only the public gateway may issue the browser's routing cookie.
      const resultHeaders = new Headers(result.headers)
      resultHeaders.delete('Set-Cookie')
      return secure(new Response(result.body, { status: result.status, headers: resultHeaders }))
    } catch {
      // Do not emit credentials, account identifiers or provider error detail.
      return secure(fail('Webmail is temporarily unavailable', 503, undefined, 'internal'))
    }
  },
}
