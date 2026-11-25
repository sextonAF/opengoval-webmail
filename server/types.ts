import type { Env } from '../functions/_lib/env'

/** Runtime hook supplied by each deployment entrypoint. */
export interface AppRuntime {
  /** Only the isolated IMAP Worker supplies this; all existing runtimes keep the password guard. */
  authenticationMode?: 'imap'
  waitUntil(promise: Promise<unknown>): void
}

/**
 * Shape handed to the existing Pages Functions handlers. They only rely on this
 * subset of the Pages context, so the same modules run on Workers, Pages and
 * Node without changes.
 */
export interface ApiContext {
  request: Request
  env: Env
  params: Record<string, string>
  waitUntil(promise: Promise<unknown>): void
  next(): Promise<Response>
}

export type ApiHandler = (context: ApiContext) => Response | Promise<Response>

export type RouteModule = {
  onRequest?: ApiHandler
  onRequestGet?: ApiHandler
  onRequestHead?: ApiHandler
  onRequestPost?: ApiHandler
  onRequestPut?: ApiHandler
  onRequestPatch?: ApiHandler
  onRequestDelete?: ApiHandler
  onRequestOptions?: ApiHandler
}
