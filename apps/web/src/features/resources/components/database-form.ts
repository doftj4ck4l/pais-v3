import type { DatabaseConnectionInput } from '@/shared/api/api'
import type { DbConnectionRow } from '@/shared/lib/types'

export type DatabaseFormState = {
  engine: DatabaseConnectionInput['engine']
  name: string
  host: string
  port: string
  database: string
  username: string
  password: string
  sslMode: DatabaseConnectionInput['ssl']['mode']
  sslCa: string
  serverName: string
  removeCa: boolean
}

export function emptyFormFor(engine: DatabaseConnectionInput['engine']): DatabaseFormState {
  return {
    engine,
    name: '',
    host: '',
    port: engine === 'mysql' ? '3306' : engine === 'sqlserver' ? '1433' : engine === 'sybase' ? '5000' : '5432',
    database: '',
    username: '',
    password: '',
    sslMode: engine === 'sqlserver' ? 'require' : 'disable',
    sslCa: '',
    serverName: '',
    removeCa: false,
  }
}

export function formFromConnection(connection: DbConnectionRow): DatabaseFormState {
  return {
    ...emptyFormFor(connection.engine),
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    database: connection.database,
    username: connection.username,
    sslMode: connection.sslMode,
  }
}

export function connectionInput(
  form: DatabaseFormState,
  editing: DbConnectionRow | null,
): DatabaseConnectionInput {
  return {
    name: form.name.trim(),
    engine: form.engine,
    host: form.host.trim(),
    port: Number(form.port),
    database: form.database.trim(),
    username: form.username.trim(),
    ...(form.password ? { password: form.password } : {}),
    ssl: {
      mode: form.sslMode,
      ...(form.serverName ? { serverName: form.serverName.trim() } : {}),
      ...(form.sslCa ? { ca: form.sslCa } : form.removeCa && editing?.hasCustomCa ? { ca: null } : {}),
    },
  }
}

export function engineLabel(engine: DatabaseConnectionInput['engine']): string {
  return engine === 'mysql'
    ? 'MySQL / MariaDB'
    : engine === 'sqlserver'
      ? 'SQL Server'
      : engine === 'sybase' ? 'SAP Sybase ASE' : 'PostgreSQL'
}

export function formatServerVersion(
  result: { serverVersion?: string; serverProduct?: 'PostgreSQL' | 'MySQL' | 'MariaDB' | 'SQL Server' | 'SAP ASE' },
  engine: DatabaseConnectionInput['engine'],
): string {
  if (!result.serverVersion) return ''
  const product = result.serverProduct ?? (
    engine === 'mysql' ? 'MySQL' : engine === 'sqlserver' ? 'SQL Server' : engine === 'sybase' ? 'SAP ASE' : 'PostgreSQL'
  )
  return ` · ${product} ${result.serverVersion}`
}
