import { describe, expect, it } from 'bun:test'
import {
  connectionInput,
  emptyFormFor,
  engineLabel,
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
    expect(emptyFormFor('sqlserver')).toMatchObject({ port: '1433', sslMode: 'require' })
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
    expect(engineLabel('sqlserver')).toBe('SQL Server')
    expect(formatServerVersion({ serverVersion: '15.0.2080.9', serverProduct: 'SQL Server' }, 'sqlserver'))
      .toBe(' · SQL Server 15.0.2080.9')
  })

  it('keeps SQL Server password and custom CA behavior engine-neutral', () => {
    const form = {
      ...emptyFormFor('sqlserver'),
      name: 'warehouse',
      host: 'db.internal',
      database: 'Inventory',
      username: 'reader',
      password: 'test-only',
      sslMode: 'verify-full' as const,
      sslCa: 'PEM',
      serverName: 'tls.internal',
    }
    expect(connectionInput(form, null)).toMatchObject({
      engine: 'sqlserver',
      port: 1433,
      password: 'test-only',
      ssl: { mode: 'verify-full', ca: 'PEM', serverName: 'tls.internal' },
    })
  })
})
