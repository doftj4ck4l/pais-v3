import { describe, expect, it } from 'bun:test'
import {
  CONNECTORS,
  connectorEnv,
  matchConnector,
  missingFields,
} from '../src/features/resources/lib/connectors'

const odoo = CONNECTORS.find((c) => c.id === 'odoo')
if (!odoo) throw new Error('odoo connector missing from catalog')

describe('connector catalog', () => {
  it('keeps packageName as the bare published package, not a flag', () => {
    expect(odoo.command).toBe('uvx')
    expect(odoo.args).toContain(odoo.packageName)
  })

  it('matches a stored odoo server by its package argument', () => {
    expect(
      matchConnector({ transport: 'stdio', args: ['odoo-mcp'] }),
    ).toBe(odoo)
  })

  it('matches by an ODOO_* env key when the launcher differs', () => {
    expect(
      matchConnector({
        transport: 'stdio',
        args: ['python3', '-m', 'odoo_mcp'],
        envKeys: ['ODOO_URL', 'ODOO_DB'],
      }),
    ).toBe(odoo)
  })

  it('never matches a remote server', () => {
    expect(matchConnector({ transport: 'http' })).toBeNull()
  })
})

describe('odoo connector form', () => {
  const creds = {
    ODOO_URL: 'https://odoo.example.com:8069',
    ODOO_DB: 'company',
    ODOO_USERNAME: 'admin',
    ODOO_PASSWORD: 'secret',
  }

  it('builds env with transport defaulted to xmlrpc', () => {
    expect(connectorEnv(odoo, creds)).toEqual({
      ...creds,
      ODOO_TRANSPORT: 'xmlrpc',
    })
  })

  it('drops a blank optional transport so the server default applies', () => {
    const env = connectorEnv(odoo, { ...creds, ODOO_TRANSPORT: ' ' })
    expect(env.ODOO_TRANSPORT).toBeUndefined()
  })

  it('requires url, db and credentials but not transport', () => {
    expect(missingFields(odoo, {})).toHaveLength(4)
    expect(
      missingFields(odoo, {
        ODOO_URL: 'https://odoo.example.com:8069',
        ODOO_DB: 'company',
        ODOO_USERNAME: 'admin',
        ODOO_PASSWORD: 'secret',
      }),
    ).toHaveLength(0)
  })
})
