import { createFileRoute } from '@tanstack/react-router'
import { InvitePage } from '@/pages/invitations/invite-page'

export const Route = createFileRoute('/invite')({
  component: InvitePage,
})
