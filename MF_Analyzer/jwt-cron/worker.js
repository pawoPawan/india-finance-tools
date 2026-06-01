/**
 * JWT Cron Worker — refreshes Morningstar JWT daily and stores in KV.
 * Cloudflare Workers can fetch morningstar.in HTML (not WAF-blocked).
 * The JWT is then served to browsers via the Pages proxy /api/jwt endpoint.
 */

const SCREENER_PAGE = 'https://www.morningstar.in/tools/ECFundscreener.aspx';
const JWT_KEY       = 'jwt';
const JWT_TTL_SEC   = 4 * 60 * 60;   // 4 hours KV TTL (cron runs every hour)

export default {
  // Cron trigger: runs every hour
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshJWT(env));
  },

  // HTTP endpoint for manual trigger or health check
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/refresh') {
      try {
        const token = await refreshJWT(env);
        return new Response(JSON.stringify({ ok: true, tokenLength: token.length }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    const cached = await env.MF_CACHE.get(JWT_KEY, 'json');
    return new Response(JSON.stringify({
      ok: true,
      hasCached: !!cached,
      age: cached ? Math.round((Date.now() - cached.ts) / 1000) + 's' : null,
    }), { headers: { 'Content-Type': 'application/json' } });
  },
};

async function refreshJWT(env) {
  const html = await fetch(SCREENER_PAGE, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  }).then(r => r.text());

  const m = html.match(/id="hfApiToken"[^>]+value="([^"]+)"/);
  if (!m || !m[1]) throw new Error('hfApiToken not found in screener HTML');

  const payload = { token: m[1], ts: Date.now() };
  await env.MF_CACHE.put(JWT_KEY, JSON.stringify(payload), { expirationTtl: JWT_TTL_SEC });
  return m[1];
}
