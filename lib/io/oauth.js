/**
 * Exchange a refresh token for an access token at the provider's token endpoint.
 * Sends JSON when `descriptor.tokenFormat` is `"json"`; otherwise sends form-encoded
 * data. Retains the supplied refresh token if the response omits a replacement.
 *
 * @param {{tokenUrl: string, clientId?: string, tokenFormat?: string}} descriptor
 *   Provider settings; `tokenUrl` must be a string. `clientId` is sent with the
 *   refresh request, and only the exact `"json"` token format selects JSON encoding.
 * @param {string} refresh Non-empty refresh token to exchange.
 * @param {{signal?: AbortSignal}} [options={}] Optional request settings.
 * @param {AbortSignal} [options.signal] Optional signal to cancel the fetch.
 * @returns {Promise<{type: "oauth", access: string, token: string, refresh: string, expires?: number}>}
 *   A credential with the access token in both `access` and `token`, the new or
 *   retained refresh token, and `expires` (an epoch timestamp in milliseconds)
 *   only when the response has a finite `expires_in` value.
 * @throws {Error} The promise rejects for a missing/invalid token URL or refresh
 *   token, a failed or non-successful HTTP request, invalid response JSON, or a
 *   response without a non-empty access token. An aborted fetch also rejects.
 */
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
