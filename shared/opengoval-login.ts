export const OPENGOVAL_DOMAIN = 'opengoval.org'

/** Accept a local username or a complete address in the permitted domain.
 * Never append the domain twice or accept an address from another domain. */
export function opengovalLoginAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  const address = name.includes('@') ? name : name + '@' + OPENGOVAL_DOMAIN
  return /^[a-z0-9][a-z0-9._%+-]{0,63}@opengoval\.org$/.test(address) ? address : null
}
