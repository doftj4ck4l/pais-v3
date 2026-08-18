import { createFileRoute } from '@tanstack/react-router'
import { OrganizationsPage } from '@/pages/organizations/organizations-page'

export const Route = createFileRoute('/admin/organizations')({ component: OrganizationsPage })
