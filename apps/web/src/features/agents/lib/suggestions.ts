import type { Language } from '@/shared/lib/i18n'

export type Suggestion = { text: string; hint: string }

/**
 * What to offer someone looking at an empty console.
 *
 * The four that used to be here asked the agent to roll a die, add up four
 * numbers, and report a mocked weather forecast. They demonstrated that tool
 * calling worked, which was the point when tool calling was the feature. They
 * also told a first-time user that this is a toy.
 *
 * These ask for the things the workspace can actually produce: a spreadsheet
 * with formulas in it, a Word document, an answer with live sources, a script
 * that ran. Every one of them is backed by something already installed in the
 * sandbox image — openpyxl and python-docx, the docx/xlsx/web-search skills,
 * Python and Node — so none of them depends on a key nobody has set.
 *
 * The order matters: what the workspace already holds comes first, because a
 * suggestion about your own documents is worth more than any general one.
 */

/** Everything the console knows about the workspace when it is sitting idle. */
export type SuggestionContext = {
  /** Titles of indexed documents, newest first. */
  documents: string[]
  /** Names of connected databases. */
  databases: string[]
  /** Names of MCP servers that connected successfully. */
  mcpServers: string[]
}

const SLOTS = 4

/**
 * Available in any workspace, on a machine with no keys configured.
 *
 * Ordered by how much of the product each one reveals: the first two end with a
 * file in the Files panel, which is the thing people do not expect a chat box
 * to do.
 */
const ALWAYS: Record<Language, Suggestion[]> = {
  en: [
  {
    text: 'Build a 12-month cash flow spreadsheet with formulas, and save it to my files.',
    hint: 'xlsx skill · writes to the workspace',
  },
  {
    text: 'Search the web for what changed in the EU AI Act this year and summarise it with sources.',
    hint: 'web-search skill · live results',
  },
  {
    text: 'Draft a one-page project brief as a Word document I can download.',
    hint: 'docx skill · writes to the workspace',
  },
  {
    text: 'Generate 200 rows of realistic test data as CSV, then show me the summary statistics.',
    hint: 'python · runs in the sandbox',
  },
  ],
  ms: [
    {
      text: 'Bina hamparan aliran tunai 12 bulan dengan formula, kemudian simpan ke fail saya.',
      hint: 'kemahiran xlsx · menulis ke ruang kerja',
    },
    {
      text: 'Cari di web perubahan Akta AI EU tahun ini dan ringkaskannya bersama sumber.',
      hint: 'kemahiran web-search · hasil langsung',
    },
    {
      text: 'Draf ringkasan projek satu halaman sebagai dokumen Word yang boleh saya muat turun.',
      hint: 'kemahiran docx · menulis ke ruang kerja',
    },
    {
      text: 'Jana 200 baris data ujian realistik sebagai CSV, kemudian tunjukkan statistik ringkasan.',
      hint: 'python · berjalan dalam kotak pasir',
    },
  ],
}

export function buildSuggestions(context: SuggestionContext, language: Language = 'en'): Suggestion[] {
  const contextual: Suggestion[] = []

  const [document] = context.documents
  if (document) {
    contextual.push({
      text: language === 'ms'
        ? `Ringkaskan “${document}” dan senaraikan setiap komitmen berserta tarikh akhirnya.`
        : `Summarise "${document}" and list every commitment in it with its deadline.`,
      hint: language === 'ms' ? 'dokumen anda' : 'your documents',
    })
  }

  const [database] = context.databases
  if (database) {
    contextual.push({
      text: language === 'ms'
        ? `Dalam ${database}, cari jadual terbesar dan tunjukkan cara jadual itu disambungkan.`
        : `In ${database}, find the largest tables and show me how they join.`,
      hint: language === 'ms' ? 'sql baca sahaja' : 'read-only sql',
    })
  }

  // Worth offering because a server that was added five minutes ago is a
  // surface nobody has read yet, and `search_tools` is how the agent reads it.
  const [server] = context.mcpServers
  if (server) {
    contextual.push({
      text: language === 'ms'
        ? `Apakah yang boleh dilakukan oleh pelayan ${server}? Tunjukkan alatnya, kemudian gunakan alat yang paling berguna.`
        : `What can the ${server} server do? Show me its tools, then use the most useful one.`,
      hint: `mcp · ${server}`,
    })
  }

  return [...contextual, ...ALWAYS[language]].slice(0, SLOTS)
}
