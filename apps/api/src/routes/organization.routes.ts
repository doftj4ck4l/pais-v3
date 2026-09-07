import { Hono } from "hono";
import * as controller from "../controllers/organization.controller";
import { requireSuperAdmin } from "../middleware/super-admin";
import { requireJsonMutation, requireSameOrigin } from "../middleware/json-mutation";

export const organizationRoutes = new Hono();

organizationRoutes.use("*", requireSuperAdmin);
organizationRoutes.get("/", controller.listOrganizations);
organizationRoutes.post("/", requireJsonMutation, controller.createOrganization);
organizationRoutes.get("/:organizationId", controller.showOrganization);
organizationRoutes.patch("/:organizationId", requireJsonMutation, controller.renameOrganization);
organizationRoutes.post(
  "/:organizationId/invitations",
  requireJsonMutation,
  controller.createInvitation,
);
organizationRoutes.post(
  "/:organizationId/invitations/:invitationId/revoke",
  requireJsonMutation,
  controller.revokeInvitation,
);
organizationRoutes.delete(
  "/:organizationId/members/:membershipId",
  requireSameOrigin,
  controller.removeMember,
);
organizationRoutes.patch(
  "/:organizationId/members/:membershipId/role",
  requireJsonMutation,
  controller.setMemberRole,
);
organizationRoutes.get("/:organizationId/grants", controller.listGrants);
organizationRoutes.put("/:organizationId/grants", requireJsonMutation, controller.setGrants);
