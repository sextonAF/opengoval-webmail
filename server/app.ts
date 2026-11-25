import { readCookie, verifySession } from '../functions/_lib/crypto'
import type { Env } from '../functions/_lib/env'
import { fail, HttpError } from '../functions/_lib/http'
import { passwordGuard } from '../functions/_lib/password-guard'
import { allowedMethods, handlerFor, matchRoute } from './router'
import type { ApiContext, AppRuntime, ApiHandler } from './types'

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/2fa',
  '/api/health',
  '/api/cron/notifications',
])

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'",
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Runtime-agnostic entrypoint for the API. Pages keeps using its own
 * `functions/api/_middleware.ts`; the Workers and Node entries call this.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  runtime: AppRuntime,
): Promise<Response> {
  try {
    const url = new URL(request.url)

    // An insecure APP_PASSWORD must not serve the application at all: the Node
    // entry refuses to start, this is the same policy for Workers.
    const blocked = runtime.authenticationMode === 'imap' ? null : passwordGuard(env, url.pathname)
    if (blocked) {
      return withSecurityHeaders(blocked)
    }

    if (!PUBLIC_PATHS.has(url.pathname)) {
      const session = readCookie(request, 'mc_session')
      if (!(await verifySession(env, session))) {
        return withSecurityHeaders(fail('Authentication required', 401, undefined, 'unauthorized'))
      }
    }

    if (!READ_ONLY_METHODS.has(request.method)) {
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) {
        return withSecurityHeaders(fail('Origin not allowed', 403, undefined, 'invalid_origin'))
      }
    }

    const matched = matchRoute(url.pathname)
    if (!matched) {
      return withSecurityHeaders(fail('Not found', 404, undefined, 'not_found'))
    }

    const method = request.method.toUpperCase()
    const handler = handlerFor(matched.route.module, method) as ApiHandler | undefined
    if (!handler) {
      return withSecurityHeaders(
        fail('Method not allowed', 405, undefined, 'method_not_allowed', {
          Allow: allowedMethods(matched.route.module).join(', '),
        }),
      )
    }

    const context: ApiContext = {
      request,
      env,
      params: matched.params,
      waitUntil: (promise) => runtime.waitUntil(promise),
      next: async () => fail('Not found', 404, undefined, 'not_found'),
    }

    const response = await handler(context)
    if (method === 'HEAD') {
      return withSecurityHeaders(
        new Response(null, { status: response.status, headers: response.headers }),
      )
    }
    return withSecurityHeaders(response)
  } catch (error) {
    if (error instanceof HttpError) {
      return withSecurityHeaders(fail(error.message, error.status))
    }
    return withSecurityHeaders(fail('Internal error', 500, undefined, 'internal'))
  }
}
