import { describe, expect, it } from 'vitest'
import {
  describeRequirement,
  requirementsFromSql,
  supersededBaselineRequirement,
} from '../scripts/migration-requirements.mjs'

describe('migration requirements', () => {
  it('reads added columns with their table', () => {
    expect(requirementsFromSql('ALTER TABLE imap_messages ADD COLUMN thread_key TEXT;')).toEqual([
      { kind: 'column', table: 'imap_messages', name: 'thread_key' },
    ])
  })

  it('reads created tables, with or without IF NOT EXISTS', () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS storage_cleanup_log (id TEXT);',
      'CREATE TABLE plain_table (id TEXT);',
    ].join('\n')

    expect(requirementsFromSql(sql)).toEqual([
      { kind: 'table', name: 'storage_cleanup_log' },
      { kind: 'table', name: 'plain_table' },
    ])
  })

  it('reads indexes and keeps track of unicity', () => {
    const sql = [
      'CREATE INDEX IF NOT EXISTS idx_a ON t (a);',
      'CREATE UNIQUE INDEX idx_b ON t (lower(email));',
    ].join('\n')

    expect(requirementsFromSql(sql)).toEqual([
      { kind: 'index', name: 'idx_a', unique: false },
      { kind: 'index', name: 'idx_b', unique: true },
    ])
  })

  it('is case insensitive and tolerant of line breaks', () => {
    const sql = `alter table accounts
      add column sent_copy_account_id TEXT;`

    expect(requirementsFromSql(sql)).toEqual([
      { kind: 'column', table: 'accounts', name: 'sent_copy_account_id' },
    ])
  })

  it('ignores everything that is not a schema object', () => {
    const sql = [
      '-- ALTER TABLE fake ADD COLUMN nope TEXT;',
      "UPDATE accounts SET display_name = 'x';",
      "DELETE FROM message_labels WHERE label_id = 'y';",
      'ALTER TABLE accounts ADD CONSTRAINT c CHECK (1);',
    ].join('\n')

    expect(requirementsFromSql(sql)).toEqual([])
  })

  it('finds every object of a realistic migration', () => {
    const sql = `CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    ALTER TABLE messages ADD COLUMN thread_key TEXT;
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (account_id, thread_key);`

    expect(requirementsFromSql(sql).map(describeRequirement)).toEqual([
      'table schema_migrations',
      'column messages.thread_key',
      'index idx_messages_thread',
    ])
  })

  it('marks a unique requirement in the description', () => {
    expect(describeRequirement({ kind: 'index', name: 'idx_email', unique: true })).toBe(
      'index idx_email (unique)',
    )
  })
})

describe('superseded baseline requirements', () => {
  it('recognises obsolete forwarding objects from migration 009', () => {
    const file = '009_forward_and_delete.sql'
    expect(supersededBaselineRequirement(
      file, { kind: 'table', name: 'forward_rules' }
    )).toBe(true)
    for (const name of ['idx_forward_rules_account', 'idx_forward_log_rule']) {
      expect(supersededBaselineRequirement(
        file, { kind: 'index', name }
      )).toBe(true)
    }
  })

  it('preserves active forwarding and deletion requirements', () => {
    const file = '009_forward_and_delete.sql'
    expect(supersededBaselineRequirement(
      file, { kind: 'table', name: 'forward_log' }
    )).toBe(false)
    expect(supersededBaselineRequirement(
      file, { kind: 'table', name: 'deletion_log' }
    )).toBe(false)
    expect(supersededBaselineRequirement(
      '011_filter_forwarding.sql',
      { kind: 'index', name: 'idx_forward_log_filter' }
    )).toBe(false)
  })
})
