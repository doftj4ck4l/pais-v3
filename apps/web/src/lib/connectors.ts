/**
 * Known MCP servers, as templates.
 *
 * Everything about a published server except its credentials is fixed: the
 * launcher, the package, the flags, and the *names* of the environment
 * variables it reads. Typing all of that by hand is where the mistakes come
 * from — `uvx` misspelled, a flag dropped, `NEXTCLOUD_HOST` entered as
 * `NEXTCLOUD_URL`, a value wrapped in quotes that then become part of it.
 *
 * So a connector carries the fixed half and asks only for the rest. The manual
 * form is still there for anything not listed here; this is a shortcut, not a
 * gate.
 */

/** One credential, rendered as a labelled field instead of a line of env text. */
export type ConnectorField = {
  /** The environment variable the server actually reads. Never shown as-is. */
  key: string
  label: string
  placeholder?: string
  /** `password` masks the input; `url` gets the browser's URL keyboard. */
  type?: 'text' | 'password' | 'url'
  /** Prefilled, for values that have a correct answer the user should not invent. */
  default?: string
  /** Blocks submit while empty. Defaults to true. */
  required?: boolean
  /** One line under the field, for the thing that is easy to get wrong. */
  help?: string
}

export type Connector = {
  id: string
  name: string
  /** One line, shown in the picker. */
  summary: string
  /** Resolved to a component by the panel — the catalog stays free of JSX. */
  icon: 'cloud' | 'mail'
  command: string
  args: string[]
  fields: ConnectorField[]
  /** Shown above the fields once chosen. Setup that the form cannot do itself. */
  note?: string
}

export const CONNECTORS: Connector[] = [
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    summary: 'Files, notes, calendar and tables on a Nextcloud instance',
    icon: 'cloud',
    command: 'uvx',
    args: ['nextcloud-mcp-server', 'run', '--transport', 'stdio'],
    note: 'First connection builds a Python environment and can take a few minutes. Later ones are fast.',
    fields: [
      {
        key: 'NEXTCLOUD_HOST',
        label: 'Host',
        placeholder: 'https://nextcloud.example.com',
        type: 'url',
        help: 'Must be reachable from the API container, not just from your browser.',
      },
      { key: 'NEXTCLOUD_USERNAME', label: 'Username', placeholder: 'admin' },
      {
        key: 'NEXTCLOUD_PASSWORD',
        label: 'Password',
        type: 'password',
        help: 'Prefer an app password — it is scoped to this integration and revocable on its own.',
      },
    ],
  },
  {
    id: 'ms365',
    name: 'Microsoft 365',
    summary: 'Outlook mail, calendar and contacts through Microsoft Graph',
    icon: 'mail',
    command: 'npx',
    args: ['-y', '@softeria/ms-365-mcp-server', '--discovery'],
    // Device-code login blocks until the browser half completes, which outlasts
    // CALL_TIMEOUT_MS. So it cannot be done from a tool call, and the token has
    // to already exist by the time this server is added.
    note: 'Sign in once first: docker compose exec api npx -y @softeria/ms-365-mcp-server --login. This form only points at the token it leaves behind.',
    fields: [
      {
        key: 'MS365_MCP_TOKEN_CACHE_PATH',
        label: 'Token cache path',
        default: '/cache/ms365/.token-cache.json',
        help: 'Under HOME=/cache, which is a named volume — the token survives a rebuild.',
      },
      {
        key: 'MS365_MCP_SELECTED_ACCOUNT_PATH',
        label: 'Selected account path',
        default: '/cache/ms365/.selected-account.json',
      },
    ],
  },
]

/**
 * Build the env object a connector's filled-in fields amount to.
 *
 * Values are trimmed for the same reason the manual form trims them: a trailing
 * space pasted along with a password is invisible and fails as a wrong
 * credential rather than as a malformed one. Empty optional fields are dropped
 * rather than sent as `""`, which a server would read as "set, but blank".
 */
export function connectorEnv(
  connector: Connector,
  values: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const field of connector.fields) {
    const value = (values[field.key] ?? field.default ?? '').trim()
    if (value) env[field.key] = value
  }
  return env
}

/** Every field without an explicit `required: false` must be filled to submit. */
export function missingFields(
  connector: Connector,
  values: Record<string, string>,
): ConnectorField[] {
  return connector.fields.filter(
    (f) => f.required !== false && !(values[f.key] ?? f.default ?? '').trim(),
  )
}
