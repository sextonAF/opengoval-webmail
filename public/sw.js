const CACHE = 'whelkmail-v4'
const SHELL = [
  '/',
  '/favicon.svg',
  '/whelkmail-logo.svg',
  '/manifest.webmanifest',
  '/notification-badge.png',
  '/notification-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      // Revalidate the shell with the network: a stale index.html keeps an
      // installed PWA on an old bundle even after a deploy.
      fetch(request, { cache: 'no-cache' })
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => undefined)
          return response
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    )
    return
  }

  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webmanifest')
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined)
            return response
          }),
      ),
    )
  }
})

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function fetchApplicationServerKey() {
  try {
    const response = await fetch('/api/push/key', { credentials: 'same-origin' })
    if (!response.ok) {
      return null
    }
    const data = await response.json()
    return data && data.publicKey ? base64UrlToBytes(data.publicKey) : null
  } catch {
    return null
  }
}

async function postSubscription(subscription) {
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys || !json.keys.p256dh || !json.keys.auth) {
    return
  }
  await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: self.navigator ? self.navigator.userAgent : undefined,
    }),
  })
}

async function forgetSubscription(endpoint) {
  if (!endpoint) {
    return
  }
  try {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
  } catch {
    // The cron worker also drops endpoints that answer 404/410.
  }
}

// Chrome can rotate or invalidate the subscription while the app is closed.
// Resubscribe and re-register so the server stops sending to a dead endpoint.
// The app also re-registers on every start (src/lib/push.ts), which covers
// browsers that never fire this event and sessions that expire here.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription
      if (!subscription) {
        const options = event.oldSubscription ? event.oldSubscription.options : null
        const applicationServerKey =
          (options && options.applicationServerKey) || (await fetchApplicationServerKey())
        if (!applicationServerKey) {
          return
        }
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })
      }
      if (event.oldSubscription && event.oldSubscription.endpoint !== subscription.endpoint) {
        await forgetSubscription(event.oldSubscription.endpoint)
      }
      await postSubscription(subscription)
    })().catch(() => undefined),
  )
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const title = payload.title || 'WhelkMail'
  const options = {
    body: payload.body || '',
    // Android masks the badge into a monochrome silhouette in the status bar and
    // only renders bitmaps there, so both assets are PNG (see scripts/generate-icons.mjs).
    icon: payload.icon || '/notification-icon.png',
    badge: payload.badge || '/notification-badge.png',
    data: { url: payload.url || '/', tag: payload.tag || undefined },
    tag: payload.tag || undefined,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === target && 'focus' in client) {
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
