import { describe, expect, it } from 'bun:test'
import {
  connectionInput,
  emptyFormFor,
  formatServerVersion,
  formFromConnection,
} from '../src/features/resources/components/database-form'
import type { DbConnectionRow } from '../src/shared/lib/types'

const mysqlConnection: DbConnectionRow = {
  id: 'db_mysql',
  name: 'inventory',
  engine: 'mysql',
  status: 'connected',
  error: null,
  host: 'mysql.internal',
  port: 3307,
  database: 'inventory',
  username: 'reader',
  sslMode: 'verify-full',
  hasCustomCa: true,
  tableCount: 12,
  lastIntrospectedAt: 1,
  createdAt: 1,
}

describe('database connector form', () => {
  it('selects the correct default port for each engine', () => {
    expect(emptyFormFor('postgresql').port).toBe('5432')
    expect(emptyFormFor('mysql').port).toBe('3306')
  })

  it('preserves MySQL when editing and sends it to the API', () => {
    const form = formFromConnection(mysqlConnection)
    expect(form.engine).toBe('mysql')
    expect(form.port).toBe('3307')
    expect(connectionInput({ ...form, password: 'test-only' }, mysqlConnection)).toMatchObject({
      engine: 'mysql',
      port: 3307,
      database: 'inventory',
    })
  })

  it('labels MySQL and MariaDB test results from the server', () => {
    expect(formatServerVersion({ serverVersion: '8.0.46', serverProduct: 'MySQL' }, 'mysql'))
      .toBe(' · MySQL 8.0.46')
    expect(formatServerVersion({ serverVersion: '5.5.64', serverProduct: 'MariaDB' }, 'mysql'))
      .toBe(' · MariaDB 5.5.64')
    expect(formatServerVersion({ serverVersion: '17', serverProduct: 'PostgreSQL' }, 'postgresql'))
      .toBe(' · PostgreSQL 17')
  })
})
