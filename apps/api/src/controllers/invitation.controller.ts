import type { Context } from "hono";
import { currentUser, currentUserId } from "../middleware/auth";
import { organizationInvitationService } from "../services/organizations/invitation.service";

async function tokenFrom(c: Context): Promise<string | null> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof (body as { token?: unknown }).token !== "string") {
    return null;
  }
  const token = (body as { token: string }).token.trim();
  return token.length <= 256 ? token : null;
}

function noStore(c: Context) {
  c.header("Cache-Control", "no-store");
}

export async function inspectInvitation(c: Context) {
  noStore(c);
  const token = await tokenFrom(c);
  if (!token) return c.json({ error: "token is required." }, 400);
  return c.json(await organizationInvitationService.inspect(token, currentUser(c).email));
}

export async function acceptInvitation(c: Context) {
  noStore(c);
  const token = await tokenFrom(c);
  if (!token) return c.json({ error: "token is required." }, 400);
  return c.json(
    await organizationInvitationService.accept(token, {
      userId: currentUserId(c),
      email: currentUser(c).email,
    }),
  );
}
