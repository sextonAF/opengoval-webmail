/**
 * Parse the objects a migration file creates.
 *
 * `scripts/migrate.mjs --mark-applied` uses this to check that the database
 * really contains what the migration would have created before recording it as
 * applied. Data changes (`UPDATE`, `DELETE`) cannot be verified this way and are
 * left to the operator.
 *
 * Pure on purpose: the parsing rules are unit tested without a database. It is a
 * scanner for our own migration style, not a SQL parser: comments are stripped,
 * quoted strings are not analysed.
 */
export function requirementsFromSql(text) {
  const sql = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')

  // One pass so the requirements keep the order of the file.
  const pattern =
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)|CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)|CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi

  const items = []
  for (const match of sql.matchAll(pattern)) {
    if (match[1]) {
      items.push({ kind: 'column', table: match[1], name: match[2] })
    } else if (match[3]) {
      items.push({ kind: 'table', name: match[3] })
    } else {
      // Unicity is part of the guarantee: a plain index with the same name is
      // not the same object.
      items.push({ kind: 'index', name: match[5], unique: Boolean(match[4]) })
    }
  }
  return items
}

/** Human readable form used in the error message. */
export function describeRequirement(item) {
  const kind = item.kind === 'index' ? 'index' : item.kind === 'table' ? 'table' : 'column'
  const prefix = item.table ? `${item.table}.` : ''
  const suffix = item.unique ? ' (unique)' : ''
  return `${kind} ${prefix}${item.name}${suffix}`
}

/**
 * Migration 011 replaces the forwarding objects created by 009.
 * These three objects must not be required in a current schema.
 */
export function supersededBaselineRequirement(file, item) {
  if (file !== '009_forward_and_delete.sql') return false
  return (
    (item.kind === 'table' && item.name === 'forward_rules') ||
    (item.kind === 'index' &&
      ['idx_forward_rules_account', 'idx_forward_log_rule'].includes(item.name))
  )
}
