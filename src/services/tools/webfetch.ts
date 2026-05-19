import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import dns from 'dns';
import { env } from '../../config/env.js';
import { getRedisClient } from '../redis.js';
import { logger } from '../../utils/logger.js';
import type { Redis } from 'ioredis';

interface WebfetchDeps {
  redisClient?: Redis;
  botId: string;
  userId: string;
}

// ── In-process DNS cache ────────────────────────────────────────────────────

const dnsCache = new Map<string, { address: string; expiresAt: number }>();
const DNS_CACHE_TTL_MS = 30_000;

async function resolveHostname(hostname: string): Promise<string> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.address;
  }
  const result = await dns.promises.lookup(hostname, { family: 4 });
  dnsCache.set(hostname, { address: result.address, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
  return result.address;
}

// ── Lua script for atomic rate-limit INCR + conditional PEXPIRE ────────────

const RATE_LIMIT_LUA = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

/**
 * Returns true if the IP address falls within a private or reserved range.
 * Covers loopback, link-local (AWS IMDS), RFC-1918 private ranges,
 * IPv4-mapped IPv6, and IPv6 unique-local (fc00::/7).
 */
export function isPrivateIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1') return true;

  // IPv6 link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith('::ffff:') || ip.startsWith('::FFFF:')) {
    return isPrivateIp(ip.slice(7)); // recurse with IPv4 portion
  }

  // IPv6 unique local (fc00::/7)
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  // Parse IPv4
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const a = parts[0]!;
  const b = parts[1]!;

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local (AWS IMDS, etc.)
  if (a === 169 && b === 254) return true;

  return false;
}

export function createWebfetchTool(deps: WebfetchDeps) {
  const { botId, userId } = deps;
  const redisClient = deps.redisClient ?? getRedisClient();

  const allowlist = env.WEBFETCH_DOMAIN_ALLOWLIST
    .split(',')
    .map((d) => d.trim())
    .filter((d): d is string => d.length > 0);

  return tool(
    async (input) => {
      logger.debug({ botId, userId }, 'web_fetch tool: invoked');
      try {
        let hostname: string;
        try {
          hostname = new URL(input.url).hostname;
        } catch {
          return 'Invalid URL.';
        }

        // SSRF protection — deny-first: block private/reserved IPs
        if (hostname === 'localhost') {
          return 'URL not allowed: private or reserved address.';
        }

        let resolvedIp: string;
        try {
          resolvedIp = await resolveHostname(hostname);
        } catch {
          return 'URL not allowed: hostname could not be resolved.';
        }

        if (isPrivateIp(resolvedIp)) {
          return 'URL not allowed: private or reserved address.';
        }

        // Domain allowlist check (additional restriction after SSRF block)
        if (allowlist.length > 0) {
          if (!allowlist.includes(hostname)) {
            return 'Domain not allowed.';
          }
        }

        // Rate limiting: atomic INCR + conditional PEXPIRE via Lua script
        const rateLimitKey = `webfetch:ratelimit:${botId}:${userId}`;
        const count = await redisClient.eval(RATE_LIMIT_LUA, 1, rateLimitKey, String(env.WEBFETCH_RATE_LIMIT_WINDOW_MS)) as number;
        if (count > env.WEBFETCH_RATE_LIMIT_MAX) {
          return 'Rate limit exceeded. Try again later.';
        }

        // NOTE: DNS TOCTOU — the IP was validated above but Node's fetch performs its
        // own DNS resolution. `redirect: 'error'` mitigates redirect-based rebinding.
        // A full fix would require a custom undici dispatcher with connect-hook re-validation.
        const response = await fetch(input.url, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });

        if (!response.ok) {
          return `Fetch failed: HTTP ${response.status}`;
        }

        let text = await response.text();

        // Limit to 50000 chars
        text = text.slice(0, 50000);

        // Strip HTML tags
        text = text.replace(/<[^>]+>/g, '');

        // Collapse whitespace
        text = text.replace(/\s+/g, ' ').trim();

        return text;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    {
      name: 'web_fetch',
      description: 'Fetch and read the content of a web page.',
      schema: z.object({
        url: z.string().url(),
      }),
    },
  );
}
