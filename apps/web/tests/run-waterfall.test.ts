import { describe, expect, it } from 'bun:test'
import type { RunSpan } from '../src/shared/lib/types'
import {
  collapseUnchangedToolAvailability,
  descriptionOf,
  fieldLabelOf,
  labelOf,
  payloadPresentationOf,
} from '../src/pages/admin/components/run-span-presentation'

const availableToolsSpan: RunSpan = {
  id: 'available-tools',
  step: 'llm.tools',
  startedAt: 1,
  endedAt: 1,
  durationMs: 0,
  offsetMs: 29_660,
  fields: {
    count: 3,
    tools: 'bash, search_schema, describe_table',
  },
}

describe('run span wording', () => {
  it('describes llm.tools as availability rather than execution', () => {
    expect(labelOf(availableToolsSpan)).toBe('Tools available to model')
    expect(fieldLabelOf(availableToolsSpan, 'count')).toBe('available tools')
    expect(payloadPresentationOf(availableToolsSpan, 'tools', String(availableToolsSpan.fields.tools))).toEqual({
      label: 'available tool names',
      meta: '3 total',
    })
    expect(descriptionOf(availableToolsSpan)).toBe(
      'The model could choose from these 3 tools for this turn. This records availability, not tools actually called. Another row appears only when the list changes.',
    )
  })

  it('keeps tool availability changes while folding repeated unchanged snapshots', () => {
    const calledTool: RunSpan = {
      ...availableToolsSpan,
      id: 'called-tool-between-snapshots',
      step: 'tool',
      fields: { name: 'search_schema' },
    }
    const repeated = { ...availableToolsSpan, id: 'same-tools-next-turn', offsetMs: 30_000 }
    const changed = {
      ...availableToolsSpan,
      id: 'tools-changed',
      offsetMs: 31_000,
      fields: { count: 4, tools: `${availableToolsSpan.fields.tools}, run_query` },
    }

    expect(
      collapseUnchangedToolAvailability([
        availableToolsSpan,
        calledTool,
        repeated,
        changed,
      ]).map((span) => span.id),
    ).toEqual(['available-tools', 'called-tool-between-snapshots', 'tools-changed'])
  })

  it('keeps actual tool calls named after the tool and measures their payload', () => {
    const calledTool: RunSpan = {
      ...availableToolsSpan,
      id: 'called-tool',
      step: 'tool',
      fields: { name: 'search_schema' },
    }

    expect(labelOf(calledTool)).toBe('search_schema')
    expect(fieldLabelOf(calledTool, 'count')).toBe('count')
    expect(payloadPresentationOf(calledTool, 'result', 'hello')).toEqual({
      label: 'output',
      meta: '5 chars',
    })
    expect(descriptionOf(calledTool)).toBeNull()
  })
})
