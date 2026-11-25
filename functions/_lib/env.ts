export interface Env {
  DB: D1Database
  /** OpenGovAL accounts receive an address label by default. */
  OPENGOVAL_IMAP_LOGIN?: boolean
  BUCKET?: R2Bucket
  APP_PASSWORD: string
  TOKEN_ENC_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_MAIL_CLIENT_ID?: string
  GOOGLE_MAIL_CLIENT_SECRET?: string
  MICROSOFT_CLIENT_ID?: string
  MICROSOFT_CLIENT_SECRET?: string
  MICROSOFT_TENANT?: string
  RELAY_PROVIDER?: string
  RELAY_API_KEY?: string
  RELAY_API_SECRET?: string
  MAILGUN_DOMAIN?: string
  MAILGUN_REGION?: string
  SMTP2GO_API_KEY?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  CRON_SECRET?: string
  /** Public origin used by the cron worker / Node scheduler. */
  APP_URL?: string
  /** Set to `off` to stop the outbound check for new releases. */
  UPDATE_CHECK?: string
  /** Optional GitHub token, only used to raise the release-check rate limit. */
  GITHUB_TOKEN?: string
}
