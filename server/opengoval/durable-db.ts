/** D1-compatible subset backed by a single user's Durable Object SQLite storage.
 * The adapter never accepts a user id or a database selector from API input.
 */
type Bind = string | number | null | ArrayBuffer

function normalize(value: unknown): Bind {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer
  }
  if (value instanceof Date) return value.toISOString()
  throw new Error('Unsupported SQL binding')
}

class Statement {
  private readonly storage: DurableObjectStorage
  private readonly query: string
  private readonly values: Bind[]
  constructor(storage: DurableObjectStorage, query: string, values: Bind[] = []) {
    this.storage = storage
    this.query = query
    this.values = values
  }
  bind(...values: unknown[]): Statement {
    return new Statement(this.storage, this.query, values.map(normalize))
  }
  execute<T = Record<string, unknown>>() {
    const cursor = this.storage.sql.exec(this.query, ...this.values)
    const results = cursor.toArray() as T[]
    // SQLite changes() counts affected table rows, unlike rowsWritten which
    // includes index writes. Sync locks depend on this exact distinction.
    const changes = cursor.rowsWritten > 0
      ? Number(this.storage.sql.exec('SELECT changes() AS n').one().n)
      : 0
    return { results, success: true as const, meta: { changes, last_row_id: 0 } }
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>().results[0]
    return row === undefined ? null : (column ? (row[column] ?? null) : row) as T
  }
  async all<T = Record<string, unknown>>() { return this.execute<T>() }
  async run<T = Record<string, unknown>>() { return this.execute<T>() }
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const cursor = this.storage.sql.exec(this.query, ...this.values)
    const rows = [...cursor.raw()] as T[]
    return options?.columnNames ? [cursor.columnNames as T, ...rows] : rows
  }
}

export class DurableDatabase {
  private readonly storage: DurableObjectStorage
  constructor(storage: DurableObjectStorage) { this.storage = storage }
  prepare(query: string): Statement { return new Statement(this.storage, query) }
  async batch<T = Record<string, unknown>>(statements: Statement[]) {
    return this.storage.transactionSync(() => statements.map(statement => statement.execute<T>()))
  }
  asD1(): D1Database { return this as unknown as D1Database }
}
