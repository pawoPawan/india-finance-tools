/**
 * MF Analyzer — Cloudflare Pages Worker
 * - CORS proxy for Morningstar SAL API (holdings, etc.)
 * - /api/jwt  : returns cached Morningstar JWT from KV (refreshes if stale)
 * - /health   : health check
 *
 * KV binding: MF_CACHE (set in Cloudflare dashboard or wrangler.toml)
 */

const SCREENER_PAGE = 'https://www.morningstar.in/tools/ECFundscreener.aspx';

const ALLOWED_DOMAINS = [
  'morningstar.com', 'morningstar.in',
  'apac-api.morningstar.com', 'us-api.morningstar.com', 'www.morningstar.in',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === '/health')
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });

    // ── JWT endpoint — cached in KV, auto-refreshes if stale ─────────────────
    if (url.pathname === '/api/jwt') {
      try {
        let payload = env?.MF_CACHE ? await env.MF_CACHE.get('jwt', 'json') : null;
        const age = payload ? Date.now() - payload.ts : Infinity;

        if (!payload || age > 55 * 60 * 1000) {   // refresh if >55 min old
          const html = await fetch(SCREENER_PAGE, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml',
            },
          }).then(r => r.text());

          const m = html.match(/id="hfApiToken"[^>]+value="([^"]+)"/);
          if (m?.[1]) {
            payload = { token: m[1], ts: Date.now() };
            if (env?.MF_CACHE)
              await env.MF_CACHE.put('jwt', JSON.stringify(payload), { expirationTtl: 14400 });
          }
        }

        if (!payload?.token)
          return new Response(JSON.stringify({ error: 'JWT unavailable' }), {
            status: 503, headers: { 'Content-Type': 'application/json', ...CORS },
          });

        return new Response(JSON.stringify({ token: payload.token, ts: payload.ts }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
    }

    // ── CORS proxy ────────────────────────────────────────────────────────────
    const targetEncoded = url.searchParams.get('url');
    if (!targetEncoded)
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      });

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(targetEncoded);
      new URL(targetUrl);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid target URL' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    const targetHost = new URL(targetUrl).hostname;
    if (!ALLOWED_DOMAINS.some(d => targetHost === d || targetHost.endsWith('.' + d)))
      return new Response(JSON.stringify({ error: `Domain not allowed: ${targetHost}` }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
      });

    const skipHeaders = new Set([
      'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
      'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'cdn-loop',
    ]);
    const fwdHeaders = {};
    for (const [k, v] of request.headers)
      if (!skipHeaders.has(k.toLowerCase()) && !k.startsWith('cf-')) fwdHeaders[k] = v;

    // Inject Morningstar origin headers — browsers strip these on cross-origin fetch
    fwdHeaders['Origin']  = 'https://www.morningstar.in';
    fwdHeaders['Referer'] = 'https://www.morningstar.in/';

    try {
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.body;
      const resp = await fetch(targetUrl, { method: request.method, headers: fwdHeaders, body, redirect: 'follow' });

      const outHeaders = { ...CORS };
      for (const [k, v] of resp.headers) {
        const kl = k.toLowerCase();
        if (!kl.startsWith('access-control-') && kl !== 'x-frame-options') outHeaders[k] = v;
      }
      return new Response(resp.body, { status: resp.status, headers: outHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: `Proxy fetch error: ${e.message}` }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },
};
