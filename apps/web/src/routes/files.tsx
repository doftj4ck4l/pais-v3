import { createFileRoute } from '@tanstack/react-router'
import { FilesPage } from '@/pages/resources/files-page'

export const Route = createFileRoute('/files')({
  component: FilesPage,
})
