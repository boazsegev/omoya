/** Invocation-level read-only classification; uncertain arguments serialize. */
export function isReadOnlyCall(info, call) {
  if (info?.safe !== true) return false;
  if (!info.readOnly) return true;
  try {
    const args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
    return info.readOnly(args ?? {}) === true;
  } catch { return false; }
}
