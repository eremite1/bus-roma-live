// "Ponte" per Cloudflare Workers (gratuito).
// Il sito di Roma Mobilità non permette alle pagine web di leggere direttamente
// i dati GPS dei bus. Questo piccolo programma li scarica e li ripassa alla mappa.
//
// Indirizzi utilizzabili una volta pubblicato:
//   https://<nome-del-tuo-worker>.workers.dev/vehicles   -> posizioni GPS dei mezzi
//   https://<nome-del-tuo-worker>.workers.dev/trips      -> previsioni di arrivo
//   https://<nome-del-tuo-worker>.workers.dev/alerts     -> avvisi

const FEEDS = {
  vehicles: 'https://romamobilita.it/sites/default/files/rome_gtfs_rt_vehicle_positions.pb',
  trips: 'https://romamobilita.it/sites/default/files/rome_gtfs_rt_trip_updates.pb',
  alerts: 'https://romamobilita.it/sites/default/files/rome_gtfs_rt_alerts.pb',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Upstream-Status, X-Fetched-At',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/+|\/+$/g, '') || 'vehicles';
    const upstream = FEEDS[name];
    if (!upstream) {
      return new Response('Usa /vehicles, /trips oppure /alerts', { status: 404, headers: CORS });
    }

    // Piccola memoria di 10 secondi: se molte persone aprono la mappa insieme,
    // Roma Mobilità riceve comunque al massimo una richiesta ogni 10 secondi.
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/' + name);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let res;
    try {
      res = await fetch(upstream, {
        headers: { 'User-Agent': 'bus-roma-live (progetto personale non commerciale)' },
        cf: { cacheTtl: 0 },
      });
    } catch (e) {
      return new Response('Roma Mobilità non raggiungibile: ' + e, { status: 502, headers: CORS });
    }
    if (!res.ok) {
      return new Response('Roma Mobilità ha risposto ' + res.status, {
        status: 502,
        headers: { ...CORS, 'X-Upstream-Status': String(res.status) },
      });
    }

    const body = await res.arrayBuffer();
    const out = new Response(body, {
      headers: {
        ...CORS,
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'public, max-age=10',
        'X-Fetched-At': new Date().toISOString(),
      },
    });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  },
};
