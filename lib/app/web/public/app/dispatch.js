/** Compose independent packet/intent tables; duplicate keys fail before connection. */
export function compose(domains, ctx) {
  const packets = new Map();
  const intents = new Map();
  for (const domain of domains) for (const [table, target] of [[domain.packets, packets], [domain.intents, intents]]) {
    for (const [name, handler] of Object.entries(table)) {
      if (target.has(name)) throw new Error(`duplicate ${target === packets ? "packet" : "intent"}: ${name}`);
      target.set(name, handler);
    }
  }
  return {
    packet(message) { const handler = packets.get(message?.type); if (handler) handler(ctx, message); else console.warn(`unknown packet: ${message?.type}`); },
    intent(name, payload) { const handler = intents.get(name); if (handler) return handler(ctx, payload); console.warn(`unknown intent: ${name}`); },
  };
}
