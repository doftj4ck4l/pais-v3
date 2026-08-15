import { createFileRoute } from '@tanstack/react-router'
import { ConnectorsPage } from '@/pages/resources/connectors-page'

export const Route = createFileRoute('/connectors')({
  component: ConnectorsPage,
})
