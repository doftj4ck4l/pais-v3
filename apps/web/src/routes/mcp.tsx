import { createFileRoute } from '@tanstack/react-router'
import { McpPage } from '@/pages/resources/mcp-page'

export const Route = createFileRoute('/mcp')({
  component: McpPage,
})
