/** Refresh a stored OAuth credential at its provider token endpoint. */
export async function refreshOAuth(descriptor, refresh, { signal } = {}) {
  if (typeof descriptor?.tokenUrl !== "string" || typeof refresh !== "string" || refresh === "") {
    throw new Error("OAuth refresh requires a token URL and refresh token");
  }
  const json = descriptor.tokenFormat === "json";
  const fields = { grant_type: "refresh_token", refresh_token: refresh, client_id: descriptor.clientId };
  const response = await fetch(descriptor.tokenUrl, {
    method: "POST",
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(), signal,
  });
  if (!response.ok) throw new Error(`token refresh failed (HTTP ${response.status})`);
  const tokens = await response.json();
  if (typeof tokens?.access_token !== "string" || tokens.access_token === "") throw new Error("token refresh carried no access_token");
  return {
    type: "oauth", access: tokens.access_token, token: tokens.access_token,
    refresh: typeof tokens.refresh_token === "string" && tokens.refresh_token !== "" ? tokens.refresh_token : refresh,
    ...(Number.isFinite(tokens.expires_in) ? { expires: Date.now() + tokens.expires_in * 1000 } : {}),
  };
}
