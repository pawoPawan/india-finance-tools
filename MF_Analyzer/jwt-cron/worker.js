/**
 * JWT + SAL Cron Worker — refreshes Morningstar tokens hourly and stores in KV.
 * - JWT: scraped from ECFundscreener page hfApiToken hidden field
 * - SAL token: scraped from fund overview page <meta name="accessToken">
 */

const SCREENER_PAGE = 'https://www.morningstar.in/tools/ECFundscreener.aspx';
const SAL_FUND_PAGE = 'https://www.morningstar.in/mutualfunds/F00001GP7E/360-one-balanced-hybrid-fund-regular-growth/overview.aspx';
const JWT_TTL_SEC   = 4 * 60 * 60;   // 4 hours KV TTL (cron runs every hour)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export default {
  // Cron trigger: runs every hour
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshJWT(env), refreshSALToken(env)]));
  },

  // HTTP endpoint for manual trigger or health check
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/refresh') {
      try {
        const [jwt, sal] = await Promise.all([refreshJWT(env), refreshSALToken(env)]);
        return new Response(JSON.stringify({ ok: true, jwtLength: jwt.length, salLength: sal.length }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    const [jwt, sal] = await Promise.all([
      env.MF_CACHE.get('jwt', 'json'),
      env.MF_CACHE.get('sal_token', 'json'),
    ]);
    return new Response(JSON.stringify({
      ok: true,
      jwt:  { hasCached: !!jwt,  age: jwt  ? Math.round((Date.now() - jwt.ts)  / 1000) + 's' : null },
      sal:  { hasCached: !!sal,  age: sal  ? Math.round((Date.now() - sal.ts)  / 1000) + 's' : null },
    }), { headers: { 'Content-Type': 'application/json' } });
  },
};

async function refreshJWT(env) {
  const html = await fetch(SCREENER_PAGE, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
  }).then(r => r.text());

  const m = html.match(/id="hfApiToken"[^>]+value="([^"]+)"/);
  if (!m || !m[1]) throw new Error('hfApiToken not found in screener HTML');

  const payload = { token: m[1], ts: Date.now() };
  await env.MF_CACHE.put('jwt', JSON.stringify(payload), { expirationTtl: JWT_TTL_SEC });
  return m[1];
}

async function refreshSALToken(env) {
  const html = await fetch(SAL_FUND_PAGE, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
  }).then(r => r.text());

  const mAccess   = html.match(/name="accessToken"\s+content="([^"]+)"/);
  const mRealtime = html.match(/name="realTimeToken"\s+content="([^"]+)"/);
  if (!mAccess || !mAccess[1]) throw new Error('accessToken meta not found in fund page HTML');

  const payload = { token: mAccess[1], realtime: mRealtime?.[1] || '', ts: Date.now() };
  await env.MF_CACHE.put('sal_token', JSON.stringify(payload), { expirationTtl: JWT_TTL_SEC });
  return mAccess[1];
}
