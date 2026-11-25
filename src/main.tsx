import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n.tsx'

if (import.meta.env.VITE_OPENGOVAL_IMAP_LOGIN === '1') {
  document.documentElement.dataset.opengoval = 'true'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller)
  // A new service worker calls skipWaiting()/clients.claim(). Reload once so the
  // already-open page stops running the previous bundle, which otherwise keeps an
  // installed PWA on an old build for days.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) {
      window.location.reload()
    }
  })
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
