import { createFileRoute } from '@tanstack/react-router'
import { LearnedPage } from '@/pages/resources/learned-page'

export const Route = createFileRoute('/learned')({
  component: LearnedPage,
})
