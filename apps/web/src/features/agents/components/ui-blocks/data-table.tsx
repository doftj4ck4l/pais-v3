import { useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/ui/table'
import { cn } from '@/shared/lib/utils'
import type { TableProps } from '@/features/agents/lib/ui-blocks'

/**
 * A model-authored table. Named `data-table` so it does not shadow the `Table`
 * primitive it is built from. Sorting is client-side over the given rows —
 * the model hands us data, not a query, so there is nothing to round-trip.
 */
export function DataTable({ columns, rows, caption }: TableProps) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)

  const sorted = sort
    ? [...rows].sort((a, b) => compare(a[sort.key], b[sort.key]) * sort.dir)
    : rows

  function toggle(key: string) {
    setSort((s) => (s?.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  }

  return (
    <div className="my-4 overflow-hidden rounded-lg border bg-card text-card-foreground">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                onClick={() => toggle(c.key)}
                className={cn(
                  'cursor-pointer select-none hover:text-foreground',
                  c.align === 'right' && 'text-right',
                  c.align === 'center' && 'text-center',
                )}
              >
                <span className="inline-flex items-center gap-1">
                  {c.label ?? c.key}
                  {sort?.key === c.key ? (
                    sort.dir === 1 ? (
                      <ChevronUpIcon className="size-3" />
                    ) : (
                      <ChevronDownIcon className="size-3" />
                    )
                  ) : null}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  className={cn(
                    'text-[0.8125rem]',
                    c.align === 'right' && 'text-right tabular-nums',
                    c.align === 'center' && 'text-center',
                  )}
                >
                  {cell(row[c.key])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {caption ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  )
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function compare(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a ?? '').localeCompare(String(b ?? ''))
}
