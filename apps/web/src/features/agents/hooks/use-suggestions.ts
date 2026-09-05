import { useEffect, useState } from 'react'
import { listConnections, listDocuments, listMcpServers } from '@/shared/api/api'
import { useScope } from '@/features/workspace/hooks/use-workspace'
import { buildSuggestions, type Suggestion } from '@/features/agents/lib/suggestions'
import { usePreferences } from '@/shared/hooks/use-preferences'

/**
 * The starter prompts, tailored to what this workspace actually holds.
 *
 * Fetched here rather than in the console so the three requests only happen on
 * the screen that uses them — this hook lives inside the empty state, which is
 * mounted only when there is no transcript open.
 *
 * A failed fetch is not surfaced. The fallback is the general set, which is
 * exactly what an empty workspace would have been offered anyway, so there is
 * nothing to tell anyone about.
 */
export function useSuggestions(): Suggestion[] {
  const scope = useScope()
  const { language } = usePreferences()
  const [suggestions, setSuggestions] = useState<Suggestion[]>(() =>
    buildSuggestions({ documents: [], databases: [], mcpServers: [] }, language),
  )

  useEffect(() => {
    if (!scope.workspaceId) return
    let live = true

    void Promise.all([
      listDocuments(scope).catch(() => []),
      listConnections(scope).catch(() => []),
      listMcpServers(scope).catch(() => []),
    ]).then(([documents, databases, servers]) => {
      if (!live) return
      setSuggestions(
        buildSuggestions(
          {
            // Only indexed documents can be searched; one still being ingested
            // would be suggested and then not found.
            documents: documents.filter((d) => d.status === 'indexed').map((d) => d.title),
            databases: databases.filter((d) => d.status === 'connected').map((d) => d.name),
            mcpServers: servers
              .filter((s) => s.enabled && s.status === 'connected')
              .map((s) => s.name),
          },
          language,
        ),
      )
    })

    return () => {
      live = false
    }
  }, [language, scope])

  return suggestions
}
