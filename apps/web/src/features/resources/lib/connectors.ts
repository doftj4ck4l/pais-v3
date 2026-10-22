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
  icon: 'cloud' | 'mail' | 'kanban' | 'search'
  /**
   * The service's own colour, as an `R G B` triple for Tailwind's slash syntax.
   *
   * A stored server is a name and a command, and neither says at a glance which
   * of five rows is the Nextcloud one. The brand colour is the only thing about
   * a service that is recognisable before reading — so it carries the mark, and
   * everything else on the card stays in the console's own greys.
   */
  tint: string
  /** Defaults to stdio; HTTP connectors carry a URL and headers instead. */
  transport?: 'stdio' | 'http'
  /** For HTTP connectors: the endpoint default, the field that supplies it,
   * and the field that supplies the Authorization header. */
  url?: string
  urlField?: string
  authField?: string
  /** Substring used to recognise a stored HTTP server as this connector. */
  urlMatch?: string
  command?: string
  args?: string[]
  /**
   * The argument that identifies this server once it is stored.
   *
   * A row comes back as a command and an argument list, with nothing saying
   * which template built it — the name is the user's and may be anything. This
   * is what `matchConnector` recognises, so it must be the published package,
   * not a flag.
   */
  packageName?: string
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
    tint: '0 130 201',
    command: 'uvx',
    args: ['nextcloud-mcp-server', 'run', '--transport', 'stdio'],
    packageName: 'nextcloud-mcp-server',
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
    id: 'plane',
    name: 'Plane',
    summary: 'Issues, cycles, modules and projects in a Plane workspace',
    icon: 'kanban',
    tint: '63 118 255',
    command: 'uvx',
    args: ['plane-mcp-server', 'stdio'],
    packageName: 'plane-mcp-server',
    // Same shape as Nextcloud: uvx builds a Python environment on the first
    // connection, and that download is what a cold first call is waiting on.
    note: 'First connection builds a Python environment and can take a few minutes. Later ones are fast.',
    fields: [
      {
        key: 'PLANE_API_KEY',
        label: 'API key',
        type: 'password',
        help: 'Plane → Workspace Settings → API tokens. A token belongs to one workspace, so it must match the slug below.',
      },
      {
        key: 'PLANE_WORKSPACE_SLUG',
        label: 'Workspace slug',
        placeholder: 'my-team',
        help: 'The path segment after the host in your Plane URL, e.g. app.plane.so/my-team/ → my-team. Not the display name.',
      },
      {
        key: 'PLANE_BASE_URL',
        label: 'API base URL',
        type: 'url',
        default: 'https://api.plane.so',
        required: false,
        // The server defaults to the cloud API, so this only ever needs changing
        // for self-hosted Plane — where it must resolve from the API container,
        // not from the browser.
        help: 'Only for self-hosted Plane. Must be reachable from the API container.',
      },
    ],
  },
  {
    id: 'odoo',
    name: 'Odoo',
    summary: 'Customers, sales, inventory, stock and accounts in an Odoo database',
    // The leaf-and-column mark is unreadable at tile size, so the colour does
    // the recognising and the shape is that leaf simplified to its teardrop.
    icon: 'kanban',
    tint: '113 75 103',
    command: 'uvx',
    args: ['odoo-mcp'],
    packageName: 'odoo-mcp',
    // Odoo 16-18 are reached over XML-RPC and 19+ over External JSON-2; both
    // need nothing installed on the Odoo side, so the only setup this form does
    // is a name, a database and credentials the site already has.
    note: 'No module needs installing in Odoo. First connection builds a Python environment and can take a few minutes.',
    fields: [
      {
        key: 'ODOO_URL',
        label: 'Server URL',
        placeholder: 'https://odoo.example.com:8069',
        type: 'url',
        help: 'Must be reachable from the API container, not just from your browser. Port 8069 is the default.',
      },
      {
        key: 'ODOO_DB',
        label: 'Database',
        placeholder: 'company',
        help: 'The database name — the choice shown on the login screen, not the domain.',
      },
      { key: 'ODOO_USERNAME', label: 'Username', placeholder: 'admin' },
      {
        key: 'ODOO_PASSWORD',
        label: 'Password',
        type: 'password',
        help: 'In Odoo 19+ prefer an API key here; on 16-18 the account password is what the web login accepts.',
      },
      {
        key: 'ODOO_TRANSPORT',
        label: 'Transport',
        default: 'xmlrpc',
        required: false,
        help: 'xmlrpc covers Odoo 16-18. Only change to json2 for an Odoo 19+ server using an API key.',
      },
    ],
  },
  {
    id: 'ms365',
    name: 'Microsoft 365',
    summary: 'Outlook mail, calendar and contacts through Microsoft Graph',
    icon: 'mail',
    tint: '0 120 212',
    command: 'npx',
    args: ['-y', '@softeria/ms-365-mcp-server', '--discovery'],
    packageName: '@softeria/ms-365-mcp-server',
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
  {
    id: 'lens',
    name: 'Lens.org',
    summary: 'Scholarly works and patents from Lens.org',
    icon: 'search',
    tint: '30 120 170',
    command: 'bun',
    args: ['/app/apps/api/mcp/lens-server.ts'],
    packageName: '/app/apps/api/mcp/lens-server.ts',
    note: 'Lens data requires attribution and a visible Lens logo wherever it is shown. Get a token from your Lens profile → API access.',
    fields: [
      {
        key: 'LENS_API_KEY',
        label: 'API token',
        type: 'password',
        help: 'Sent as Authorization: Bearer. Stored encrypted with CONNECTION_SECRET.',
      },
    ],
  },
  {
    id: 'arkib',
    name: 'Arkib Documents',
    summary: 'Search and read the MOSTI document archive (OCR + semantic search)',
    icon: 'search',
    tint: '110 80 180',
    command: 'bun',
    args: ['/app/apps/api/mcp/arkib-server.ts'],
    packageName: '/app/apps/api/mcp/arkib-server.ts',
    note: 'Read-only. Uses the Arkib app’s existing OCR and semantic index; the account must be able to sign in to Arkib.',
    fields: [
      {
        key: 'ARKIB_URL',
        label: 'Arkib URL',
        type: 'url',
        default: 'http://10.21.48.62:8887',
        required: false,
        help: 'Must be reachable from the API container.',
      },
      { key: 'ARKIB_USERNAME', label: 'Username', default: 'admin' },
      {
        key: 'ARKIB_PASSWORD',
        label: 'Password',
        type: 'password',
        help: 'Stored encrypted with CONNECTION_SECRET.',
      },
    ],
  },
  {
    id: 'drupal',
    name: 'Drupal MCP',
    summary: 'Content and Drupal tools from an MCP-enabled Drupal site',
    icon: 'search',
    tint: '0 105 180',
    transport: 'http',
    url: 'https://repositori.mosti.gov.my/mcp/post',
    urlField: 'DRUPAL_MCP_URL',
    authField: 'DRUPAL_MCP_AUTH',
    urlMatch: '/mcp/post',
    note: 'Requires the Drupal mcp module (^1.0), token auth enabled at /admin/config/mcp, and the "Use MCP server" permission. The endpoint is /mcp/post.',
    fields: [
      {
        key: 'DRUPAL_MCP_URL',
        label: 'MCP endpoint',
        type: 'url',
        default: 'https://repositori.mosti.gov.my/mcp/post',
        help: 'Must end in /mcp/post and be reachable from the API container.',
      },
      {
        key: 'DRUPAL_MCP_AUTH',
        label: 'Authorization header',
        type: 'password',
        help: 'Basic base64(token) or Basic base64(username:password). Stored encrypted.',
      },
    ],
  },
]

/**
 * Which catalog entry a stored server came from, if any.
 *
 * Nothing on the row records it: a server is a name the user chose and a
 * command, and the name is free text. So the package argument is the identity —
 * `uvx nextcloud-mcp-server run …` is a Nextcloud connector however it was
 * named, whether it was added from the picker or typed into the manual form.
 *
 * The credential keys are the fallback, for a server built by hand with a
 * different launcher: `NEXTCLOUD_HOST` is set by exactly one kind of server.
 */
export function matchConnector(server: {
  transport: 'http' | 'stdio'
  args?: string[]
  envKeys?: string[]
  url?: string | null
  headerKeys?: string[]
}): Connector | null {
  if (server.transport === 'http') {
    const url = server.url ?? ''
    return CONNECTORS.find(
      (c) => c.transport === 'http' && c.urlMatch && url.includes(c.urlMatch),
    ) ?? null
  }

  const args = server.args ?? []
  const byPackage = CONNECTORS.find(
    (c) => c.packageName && args.some((a) => a === c.packageName),
  )
  if (byPackage) return byPackage

  const keys = server.envKeys ?? []
  if (!keys.length) return null
  return CONNECTORS.find((c) => c.fields.some((f) => keys.includes(f.key))) ?? null
}

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
