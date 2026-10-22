import { env } from "../../config/env";
import type { OAuthTokens } from "../../repositories/connector.repository";

/**
 * The Google OAuth dance, shared by every Google connector.
 *
 * Drive, Calendar, and anything that lands later differ only in *scopes* and in
 * the API they call once authorised — the consent redirect, the code exchange,
 * and the refresh are identical. This module owns that identical part so a new
 * connector is a scope list plus its own data functions, never a second copy of
 * the token handling.
 *
 * One OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) serves them
 * all, so one redirect URI does too — the `state` parameter carries which
 * connector a callback belongs to, not the path.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Refresh this long before expiry, so a slow request cannot straddle it. */
const REFRESH_MARGIN_MS = 120_000;

export const redirectUri = () => `${env.publicUrl}${env.publicBasePath}/api/connectors/google/callback`;

export function isConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

/**
 * Where to send the browser to get consent, for a given scope set.
 *
 * `access_type=offline` with `prompt=consent` is what produces a refresh token.
 * Google issues one only on first consent otherwise, so a user who has already
 * authorised this client once would come back with an access token that expires
 * in an hour and no way to renew it — a connector that works until lunchtime.
 */
export function buildAuthUrl(state: string, scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function postToken(body: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // Google's error body is the useful part — "redirect_uri_mismatch" names
    // the actual fix, where a bare 400 would send you to the wrong place.
    throw new Error(
      json.error_description || json.error || `token request failed (HTTP ${res.status})`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export function exchangeCode(code: string): Promise<OAuthTokens> {
  return postToken({
    code,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * The refresh token is carried forward explicitly: Google does not return it
 * again on a refresh, and dropping it here would lose the only credential that
 * survives an access token's hour.
 */
export async function refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new Error("no refresh token — reconnect the account");
  }
  const next = await postToken({
    refresh_token: tokens.refreshToken,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    grant_type: "refresh_token",
  });
  return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
}

export function needsRefresh(tokens: OAuthTokens): boolean {
  return tokens.expiresAt - REFRESH_MARGIN_MS <= Date.now();
}
