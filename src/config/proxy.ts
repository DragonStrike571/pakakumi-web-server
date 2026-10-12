import { isIP } from "node:net";

/** Trust only the known reverse proxy; remote clients cannot supply their own IP. */
export function resolveProxyTrust(env: NodeJS.ProcessEnv = process.env): false | number | string[] {
  const addresses = env.TRUST_PROXY_ADDRESSES?.trim();
  if (addresses === "none") return false;
  if (addresses !== undefined) {
    const entries = addresses.split(",").map(value => value.trim());
    for (const entry of entries) {
      if (entry === "loopback") continue;
      const [address, prefix, extra] = entry.split("/");
      const family = isIP(address);
      if (!family || extra !== undefined || prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))) {
        throw new Error("TRUST_PROXY_ADDRESSES must contain loopback, IP addresses or CIDRs; use none for direct access");
      }
    }
    return entries;
  }
  // Compatibility for existing deployments. Explicit addresses take precedence.
  if (env.TRUST_PROXY_HOPS !== undefined) {
    if (!/^\d+$/.test(env.TRUST_PROXY_HOPS.trim()) || Number(env.TRUST_PROXY_HOPS) > 5) throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
    return Number(env.TRUST_PROXY_HOPS) || false;
  }
  return ["loopback"];
}
