/**
 * lib/app/web/hosts.js — the web server's Host-name gate (DNS rebinding).
 *
 * A rebinding page runs in the user's own browser, so its requests arrive
 * from a loopback peer and its Origin matches its Host. Only the Host name
 * gives it away: accept requests addressed to this machine's names on the
 * server's port — loopback names, the bound host, the OS hostname (and its
 * `.local` form), and this machine's interface addresses (LAN use with
 * `--host 0.0.0.0`). Interfaces are read per check, so address changes apply.
 */

import { hostname as osHostname, networkInterfaces } from "node:os";

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
/** Whether an allowed Host is explicitly a loopback name. */
export function loopbackHost(url) { return LOOPBACK.includes(bare(url.hostname)); }
/** Whether Bun's peer IP is loopback (IPv4 or IPv6 mapped IPv4). */
export function loopbackPeer(ip) {
  const address = ip?.address?.toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Strip IPv6 brackets/zone and lowercase a host name. */
const bare = (name) => String(name ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");

/**
 * Whether a request URL names this server.
 * @param {URL} url - The request URL (Bun builds it from the Host header).
 * @param {number} port - The server's listening port.
 * @param {string} [bound] - The bound host name or address.
 * @returns {boolean} true when Host is one of this machine's names on `port`.
 */
export function hostAllowed(url, port, bound) {
  const requested = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (requested !== port) return false;
  const name = bare(url.hostname);
  if (LOOPBACK.includes(name) || name === bare(bound)) return true;
  const host = bare(osHostname());
  if (name === host || name === `${host.replace(/\.local$/, "")}.local`) return true;
  return Object.values(networkInterfaces()).flat().some((entry) => entry && bare(entry.address) === name);
}
