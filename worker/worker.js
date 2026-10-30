// "Ponte" per Cloudflare Workers (gratuito).
// Il sito di Roma Mobilità non permette alle pagine web di leggere direttamente
// i dati GPS dei bus. Questo piccolo programma li scarica e li ripassa alla mappa.
//
// Indirizzi utilizzabili una volta pubblicato:
//   https://<nome-del-tuo-worker>.workers.dev/vehicles   -> posizioni GPS dei mezzi
//   https://<nome-del-tuo-worker>.workers.dev/trips      -> previsioni di arrivo
//   https://<nome-del-tuo-worker>.workers.dev/alerts     -> avvisi

// Indirizzi ufficiali da https://romamobilita.it/sistemi-e-tecnologie/open-data/
// (il secondo di ogni lista è un vecchio indirizzo, usato solo se il primo non risponde)
const FEEDS = {
  vehicles: [
    'https://romamobilita.it/sites/default/files/rome_rtgtfs_vehicle_positions_feed.pb',
    'https://romamobilita.it/sites/default/files/rome_gtfs_rt_vehicle_positions.pb',
  ],
  trips: [
    'https://romamobilita.it/sites/default/files/rome_rtgtfs_trip_updates_feed.pb',
    'https://romamobilita.it/sites/default/files/rome_gtfs_rt_trip_updates.pb',
  ],
  alerts: [
    'https://romamobilita.it/sites/default/files/rome_rtgtfs_service_alerts_feed.pb',
    'https://romamobilita.it/sites/default/files/rome_gtfs_rt_alerts.pb',
  ],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-Upstream-Status, X-Fetched-At',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/+|\/+$/g, '') || 'vehicles';
    if (name === 'deviazione') return deviazione(request, env);
    if (!FEEDS[name]) {
      return new Response('Usa /vehicles, /trips, /alerts oppure /deviazione', { status: 404, headers: CORS });
    }

    // Piccola memoria di 10 secondi: se molte persone aprono la mappa insieme,
    // Roma Mobilità riceve comunque al massimo una richiesta ogni 10 secondi.
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/' + name);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let res = null, lastError = '';
    for (const upstream of FEEDS[name]) {
      try {
        const r = await fetch(upstream, {
          headers: { 'User-Agent': 'bus-roma-live (progetto personale non commerciale)' },
          cf: { cacheTtl: 0 },
        });
        if (r.ok) { res = r; break; }
        lastError = 'Roma Mobilità ha risposto ' + r.status;
      } catch (e) {
        lastError = 'Roma Mobilità non raggiungibile: ' + e;
      }
    }
    if (!res) return new Response(lastError, { status: 502, headers: CORS });

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

// ---------------------------------------------------------------------------
// LETTURA DEI MESSAGGI DI DEVIAZIONE (foto del display di bordo o testo)
// Un'intelligenza artificiale legge il messaggio e lo trasforma in un elenco
// ordinato di strade e svolte. La chiave dell'AI resta qui, segreta, su Cloudflare:
//   ANTHROPIC_API_KEY  (Claude)  oppure  GEMINI_API_KEY  (Google Gemini)
// ---------------------------------------------------------------------------

// Solo la tua mappa può usare questa funzione (evita che altri consumino il tuo credito AI)
const ALLOWED_ORIGINS = ['https://eremite1.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];

const PROMPT = `Sei un esperto della viabilità di Roma e aiuti un autista di autobus ATAC.
Ti viene dato un messaggio di DEVIAZIONE (foto del display di bordo AVM, foglio stampato, oppure testo).
Il messaggio è scritto a mano da un operatore, senza formato fisso, spesso abbreviato:
"dx" = destra, "sx" = sinistra, "prox"/"pros." = prosegui, "capol." = capolinea, "p.zza"/"p.za" = piazza, "v." = via, "l.go" = largo, "c.so" = corso, "lgt"/"lungot." = lungotevere, "v.le" = viale.
I nomi delle strade possono essere incompleti ("cavour", "cola di rienzo") e ci possono essere soprannomi romani
(es. "Palazzaccio" = Palazzo di Giustizia su Piazza Cavour; "Piramide" = Piazzale Ostiense; "Muro Torto" = Viale del Muro Torto).

Compito:
1. Trascrivi fedelmente il testo del messaggio.
2. Ricostruisci il percorso di deviazione come sequenza ORDINATA di strade da percorrere, usando i NOMI UFFICIALI COMPLETI
   come compaiono su OpenStreetMap (es. "Via Cola di Rienzo", "Piazza Cavour", "Lungotevere dei Mellini").
   Se il tipo di strada non è scritto (via/piazza/viale...), deducilo dal contesto e dalle strade vicine.
3. Indica dove inizia la deviazione (la strada del percorso normale dove si lascia la linea) e come finisce.

Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa struttura:
{
  "testo": "trascrizione del messaggio",
  "linea": "numero di linea se scritto, altrimenti null",
  "motivo": "incidente / ingombro / lavori / voragine / manifestazione / ... oppure null",
  "inizio": "strada (nome completo) dove inizia la deviazione",
  "passi": [
    { "azione": "prosegui | destra | sinistra | dritto | giro | inversione", "strada": "nome completo della strada", "nota": "eventuale dettaglio, es. 'giro intorno al Palazzo di Giustizia'" }
  ],
  "fine": { "tipo": "riprende_percorso | capolinea | altro", "strada": "strada dove si riprende il percorso o dove si termina, oppure null", "nota": "" },
  "dubbi": ["punti poco chiari o letture incerte da far controllare all'autista"]
}`;

async function deviazione(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cors = { ...CORS, 'Access-Control-Allow-Origin': origin || '*', 'Content-Type': 'application/json' };
  const fail = (status, msg) => new Response(JSON.stringify({ errore: msg }), { status, headers: cors });
  if (request.method !== 'POST') return fail(405, 'Usa POST');
  if (!ALLOWED_ORIGINS.includes(origin)) return fail(403, 'Origine non autorizzata');
  if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
    return fail(501, 'Manca la chiave AI: su Cloudflare aggiungi ANTHROPIC_API_KEY oppure GEMINI_API_KEY (vedi README)');
  }

  let body;
  try { body = await request.json(); } catch (e) { return fail(400, 'Richiesta non valida'); }
  const { image, mediaType = 'image/jpeg', text = '', linea = '' } = body || {};
  if (!image && !text.trim()) return fail(400, 'Manca la foto o il testo');
  if (image && image.length > 6_000_000) return fail(413, 'Foto troppo grande');

  const extra = [
    linea ? `L'autista sta facendo la linea ${linea}.` : '',
    text.trim() ? `Testo del messaggio (scritto o incollato dall'autista):\n${text.trim()}` : '',
    image ? 'Il messaggio è nella foto allegata.' : '',
  ].filter(Boolean).join('\n\n');

  try {
    const raw = env.ANTHROPIC_API_KEY
      ? await askClaude(env, PROMPT + '\n\n' + extra, image, mediaType)
      : await askGemini(env, PROMPT + '\n\n' + extra, image, mediaType);
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return new Response(JSON.stringify(json), { headers: cors });
  } catch (e) {
    return fail(502, 'Lettura non riuscita: ' + (e.message || e));
  }
}

async function askClaude(env, prompt, image, mediaType) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } });
  content.push({ type: 'text', text: prompt });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Claude ha risposto ' + res.status);
  return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

async function askGemini(env, prompt, image, mediaType) {
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: mediaType, data: image } });
  parts.push({ text: prompt });
  const model = env.AI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Gemini ha risposto ' + res.status);
  return data.candidates[0].content.parts.map((p) => p.text || '').join('');
}
