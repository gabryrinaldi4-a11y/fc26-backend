const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuti
const FUTBIN_PRICE_URL = 'https://www.futbin.com/25/playerPrices';
const FUTBIN_PLAYERS_URL = 'https://www.futbin.com/25/players';

// Headers che simulano Chrome reale — FUTBIN blocca i bot senza questi
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.futbin.com/',
  Origin: 'https://www.futbin.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-CH-UA': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────
const priceCache = new Map();   // futbinId → { data, ts }
const searchCache = new Map();  // nameLower → { data, ts }

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    // Scaduto — ma lo teniamo come "stale" fallback
    return { data: entry.data, stale: true };
  }
  return { data: entry.data, stale: false };
}

function cacheSet(map, key, data) {
  map.set(key, { data, ts: Date.now() });
}

// ─────────────────────────────────────────────
// PARSE PREZZO FUTBIN
// ─────────────────────────────────────────────
function parsePrice(raw) {
  if (!raw || raw === '0' || raw === 'N/A' || raw === '---') return 0;
  let s = String(raw).replace(/,/g, '').trim();
  if (s.toUpperCase().endsWith('K')) return Math.round(parseFloat(s) * 1000);
  if (s.toUpperCase().endsWith('M')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s, 10) || 0;
}

// ─────────────────────────────────────────────
// FETCH SINGOLO PREZZO DA FUTBIN
// ─────────────────────────────────────────────
async function fetchPriceFromFutbin(futbinId) {
  const url = `${FUTBIN_PRICE_URL}?player=${futbinId}`;
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    timeout: 12000,
  });

  if (!res.ok) {
    throw new Error(`FUTBIN ${res.status} per player ${futbinId}`);
  }

  const json = await res.json();
  const entry = json[String(futbinId)] || json[Object.keys(json)[0]];

  if (!entry || !entry.prices) {
    throw new Error(`Nessun prezzo nella risposta per ${futbinId}`);
  }

  return {
    ps:   parsePrice(entry.prices.ps?.LCPrice),
    xbox: parsePrice(entry.prices.xbox?.LCPrice),
    pc:   parsePrice(entry.prices.pc?.LCPrice),
    // Anche i prezzi BIN (Buy-It-Now) se presenti
    ps_bin:   parsePrice(entry.prices.ps?.BINPrice),
    xbox_bin: parsePrice(entry.prices.xbox?.BINPrice),
    pc_bin:   parsePrice(entry.prices.pc?.BINPrice),
    updatedAt: Date.now(),
    futbinId: String(futbinId),
    isReal: true,
  };
}

// ─────────────────────────────────────────────
// APP EXPRESS
// ─────────────────────────────────────────────
const app = express();

// CORS aperto a qualsiasi origine
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// Rate limiting semplice per non abusare di FUTBIN
let requestsThisMinute = 0;
setInterval(() => { requestsThisMinute = 0; }, 60000);
const MAX_REQUESTS_PER_MINUTE = 60;

function rateLimitCheck(res) {
  if (requestsThisMinute >= MAX_REQUESTS_PER_MINUTE) {
    res.status(429).json({ error: 'Troppi richieste, riprova tra un minuto' });
    return false;
  }
  requestsThisMinute++;
  return true;
}

// ─────────────────────────────────────────────
// ENDPOINT: Health check
// ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    cachedPrices: priceCache.size,
    cachedSearches: searchCache.size,
    uptime: Math.floor(process.uptime()),
    requestsThisMinute,
  });
});

// ─────────────────────────────────────────────
// ENDPOINT: GET /api/price/:id
// Prezzo singolo per ID FUTBIN
// ─────────────────────────────────────────────
app.get('/api/price/:id', async (req, res) => {
  const futbinId = req.params.id;

  // 1. Cache fresca?
  const cached = cacheGet(priceCache, futbinId);
  if (cached && !cached.stale) {
    return res.json(cached.data);
  }

  // 2. Rate limit
  if (!rateLimitCheck(res)) return;

  // 3. Fetch da FUTBIN
  try {
    const data = await fetchPriceFromFutbin(futbinId);
    cacheSet(priceCache, futbinId, data);
    return res.json(data);
  } catch (err) {
    console.error(`[price] ${err.message}`);
    // 4. Fallback su cache stale
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }
    return res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: POST /api/prices/batch
// Body: { "ids": ["158023", "231747", ...] }
// Ritorna: { "158023": { ps, xbox, pc, ... }, ... }
// ─────────────────────────────────────────────
app.post('/api/prices/batch', async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Serve un array "ids" nel body' });
  }

  // Limita a 100 per richiesta
  const toFetch = ids.slice(0, 100);
  const results = {};

  // 1. Prendi dalla cache quello che c'è
  const uncached = [];
  for (const id of toFetch) {
    const cached = cacheGet(priceCache, String(id));
    if (cached && !cached.stale) {
      results[id] = cached.data;
    } else {
      uncached.push(String(id));
    }
  }

  // 2. Fetch i mancanti in chunk da 5
  const CHUNK = 5;
  for (let i = 0; i < uncached.length; i += CHUNK) {
    const chunk = uncached.slice(i, i + CHUNK);

    await Promise.all(
      chunk.map(async (id) => {
        if (requestsThisMinute >= MAX_REQUESTS_PER_MINUTE) {
          // Rate limited — usa stale se c'è
          const stale = cacheGet(priceCache, id);
          if (stale) results[id] = { ...stale.data, stale: true };
          return;
        }
        requestsThisMinute++;

        try {
          const data = await fetchPriceFromFutbin(id);
          cacheSet(priceCache, id, data);
          results[id] = data;
        } catch (err) {
          console.error(`[batch] ${id}: ${err.message}`);
          // Fallback stale
          const stale = cacheGet(priceCache, id);
          if (stale) results[id] = { ...stale.data, stale: true };
        }
      })
    );

    // Pausa tra chunk per non triggerare il rate limit di FUTBIN
    if (i + CHUNK < uncached.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  res.json(results);
});

// ─────────────────────────────────────────────
// ENDPOINT: GET /api/search?name=NOME
// Cerca giocatore su FUTBIN e ritorna ID
// ─────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const name = (req.query.name || '').toString().trim();

  if (!name) {
    return res.status(400).json({ error: 'Parametro "name" richiesto' });
  }

  const nameLower = name.toLowerCase();

  // 1. Cache
  const cached = cacheGet(searchCache, nameLower);
  if (cached && !cached.stale) {
    return res.json(cached.data);
  }

  // 2. Rate limit
  if (!rateLimitCheck(res)) return;

  // 3. Fetch da FUTBIN
  try {
    const url = `${FUTBIN_PLAYERS_URL}?search=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
    });

    if (!response.ok) {
      throw new Error(`FUTBIN search ${response.status}`);
    }

    const text = await response.text();

    // FUTBIN può rispondere JSON o HTML
    let players = [];
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        players = json.map((p) => ({
          id: String(p.id),
          name: p.name || p.common_name || '',
          rating: p.rating || p.ovr || 0,
          position: p.position || '',
          club: p.club || '',
          nation: p.nation || '',
        }));
      }
    } catch {
      // Prova parsing HTML per estrarre ID
      const regex = /\/26\/player\/(\d+)\/([^"]+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        players.push({
          id: match[1],
          name: match[2].replace(/-/g, ' '),
          rating: 0,
          position: '',
          club: '',
          nation: '',
        });
      }
      // Fallback regex per /25/
      if (players.length === 0) {
        const regex25 = /\/25\/player\/(\d+)\/([^"]+)/g;
        while ((match = regex25.exec(text)) !== null) {
          players.push({
            id: match[1],
            name: match[2].replace(/-/g, ' '),
            rating: 0,
            position: '',
            club: '',
            nation: '',
          });
        }
      }
    }

    const result = { players, query: name, count: players.length };
    cacheSet(searchCache, nameLower, result);
    return res.json(result);
  } catch (err) {
    console.error(`[search] ${err.message}`);
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }
    return res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: GET /api/players?page=1&sort=Overall&order=desc
// Lista giocatori FUTBIN per costruire mappa nome→ID
// ─────────────────────────────────────────────
app.get('/api/players', async (req, res) => {
  const page = req.query.page || 1;
  const sort = req.query.sort || 'Overall';
  const order = req.query.order || 'desc';

  const cacheKey = `players_${page}_${sort}_${order}`;
  const cached = cacheGet(searchCache, cacheKey);
  if (cached && !cached.stale) {
    return res.json(cached.data);
  }

  if (!rateLimitCheck(res)) return;

  try {
    const url = `${FUTBIN_PLAYERS_URL}?page=${page}&sort=${sort}&order=${order}&version=all_versions`;
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
    });

    if (!response.ok) {
      throw new Error(`FUTBIN players page ${response.status}`);
    }

    const text = await response.text();

    let players = [];
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        players = json.map((p) => ({
          id: String(p.id),
          name: p.name || p.common_name || '',
          rating: p.rating || p.ovr || 0,
          position: p.position || '',
          club: p.club || '',
          nation: p.nation || '',
        }));
      }
    } catch {
      // HTML fallback
      const regex = /\/(?:25|26)\/player\/(\d+)\/([^"]+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        players.push({
          id: match[1],
          name: match[2].replace(/-/g, ' '),
          rating: 0,
          position: '',
          club: '',
          nation: '',
        });
      }
    }

    cacheSet(searchCache, cacheKey, players);
    return res.json(players);
  } catch (err) {
    console.error(`[players] ${err.message}`);
    if (cached) {
      return res.json(cached.data);
    }
    return res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// CATCH-ALL
// ─────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'FC26 Market Proxy',
    version: '1.0.0',
    endpoints: {
      health: 'GET /api/health',
      price: 'GET /api/price/:futbinId',
      batch: 'POST /api/prices/batch  body: { ids: ["158023", ...] }',
      search: 'GET /api/search?name=Mbappé',
      players: 'GET /api/players?page=1&sort=Overall&order=desc',
    },
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   FC26 Market Proxy — FUTBIN Price Server    ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Porta: ${PORT}                                  ║`);
  console.log('║                                              ║');
  console.log('║  Endpoints:                                  ║');
  console.log('║  GET  /api/health                            ║');
  console.log('║  GET  /api/price/:id                         ║');
  console.log('║  POST /api/prices/batch                      ║');
  console.log('║  GET  /api/search?name=...                   ║');
  console.log('║  GET  /api/players?page=1                    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});