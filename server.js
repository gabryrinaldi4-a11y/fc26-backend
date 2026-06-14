const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const tough = require('tough-cookie');
const fetchCookie = require('fetch-cookie');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FUTBIN_PRICE_URL = 'https://www.futbin.com/25/playerPrices';
const FUTBIN_PLAYERS_URL = 'https://www.futbin.com/25/players';
const FUTBIN_HOME = 'https://www.futbin.com/';

// ─────────────────────────────────────────────
// COOKIE JAR — mantiene i cookie di sessione FUTBIN
// ─────────────────────────────────────────────
const cookieJar = new tough.CookieJar();
const fetchWithCookies = fetchCookie(fetch, cookieJar);

// ─────────────────────────────────────────────
// USER-AGENT ROTATION
// ─────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Headers freschi per ogni richiesta (UA diverso ogni volta)
function getBrowserHeaders() {
  return {
    'User-Agent': getRandomUA(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,it;q=0.8,fr;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': 'https://www.futbin.com/',
    'Origin': 'https://www.futbin.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
}

// ─────────────────────────────────────────────
// SESSIONE FUTBIN — visita la homepage per prendere cookie
// ─────────────────────────────────────────────
let sessionReady = false;
let sessionInitTime = 0;
const SESSION_MAX_AGE = 30 * 60 * 1000; // rinnova sessione ogni 30 min

async function initSession() {
  try {
    console.log('[session] Inizializzazione sessione FUTBIN...');
    await fetchWithCookies(FUTBIN_HOME, {
      headers: getBrowserHeaders(),
      redirect: 'follow',
      timeout: 15000,
    });
    sessionReady = true;
    sessionInitTime = Date.now();
    const cookies = cookieJar.getCookieStringSync(FUTBIN_HOME);
    console.log(`[session] ✅ Sessione FUTBIN inizializzata (cookies: ${cookies ? 'sì' : 'no'})`);
  } catch (err) {
    console.error('[session] ❌ Errore init sessione:', err.message);
    sessionReady = false;
  }
}

// Rinnova la sessione se scaduta
async function ensureSession() {
  if (!sessionReady || Date.now() - sessionInitTime > SESSION_MAX_AGE) {
    await initSession();
  }
}

// ─────────────────────────────────────────────
// FETCH WRAPPER — usa cookie jar + headers rotanti
// ─────────────────────────────────────────────
async function futbinFetch(url) {
  await ensureSession();

  const res = await fetchWithCookies(url, {
    headers: getBrowserHeaders(),
    redirect: 'follow',
    timeout: 12000,
  });

  // Se 403, rinnova sessione e riprova una volta
  if (res.status === 403) {
    console.log('[fetch] 403 ricevuto, rinnovo sessione e riprovo...');
    await initSession();

    const retry = await fetchWithCookies(url, {
      headers: getBrowserHeaders(),
      redirect: 'follow',
      timeout: 12000,
    });

    return retry;
  }

  return res;
}

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────
const priceCache = new Map();
const searchCache = new Map();

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    return { data: entry.data, stale: true };
  }
  return { data: entry.data, stale: false };
}

function cacheSet(map, key, data) {
  map.set(key, { data, ts: Date.now() });
}

// ─────────────────────────────────────────────
// PARSE PREZZO
// ─────────────────────────────────────────────
function parsePrice(raw) {
  if (!raw || raw === '0' || raw === 'N/A' || raw === '---') return 0;
  let s = String(raw).replace(/,/g, '').trim();
  if (s.toUpperCase().endsWith('K')) return Math.round(parseFloat(s) * 1000);
  if (s.toUpperCase().endsWith('M')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s, 10) || 0;
}

// ─────────────────────────────────────────────
// FETCH PREZZO SINGOLO
// ─────────────────────────────────────────────
async function fetchPriceFromFutbin(futbinId) {
  const url = `${FUTBIN_PRICE_URL}?player=${futbinId}`;
  const res = await futbinFetch(url);

  if (!res.ok) {
    throw new Error(`FUTBIN ${res.status} per player ${futbinId}`);
  }

  const json = await res.json();
  const entry = json[String(futbinId)] || json[Object.keys(json)[0]];

  if (!entry || !entry.prices) {
    throw new Error(`Nessun prezzo nella risposta per ${futbinId}`);
  }

  return {
    ps: parsePrice(entry.prices.ps?.LCPrice),
    xbox: parsePrice(entry.prices.xbox?.LCPrice),
    pc: parsePrice(entry.prices.pc?.LCPrice),
    ps_bin: parsePrice(entry.prices.ps?.BINPrice),
    xbox_bin: parsePrice(entry.prices.xbox?.BINPrice),
    pc_bin: parsePrice(entry.prices.pc?.BINPrice),
    updatedAt: Date.now(),
    futbinId: String(futbinId),
    isReal: true,
  };
}

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// Rate limit
let requestsThisMinute = 0;
setInterval(() => { requestsThisMinute = 0; }, 60000);
const MAX_RPM = 60;

function checkRate(res) {
  if (requestsThisMinute >= MAX_RPM) {
    res.status(429).json({ error: 'Rate limit: riprova tra un minuto' });
    return false;
  }
  requestsThisMinute++;
  return true;
}

// ─────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    session: sessionReady,
    cachedPrices: priceCache.size,
    cachedSearches: searchCache.size,
    uptime: Math.floor(process.uptime()),
    rpm: requestsThisMinute,
  });
});

// Prezzo singolo
app.get('/api/price/:id', async (req, res) => {
  const id = req.params.id;

  const cached = cacheGet(priceCache, id);
  if (cached && !cached.stale) return res.json(cached.data);

  if (!checkRate(res)) return;

  try {
    const data = await fetchPriceFromFutbin(id);
    cacheSet(priceCache, id, data);
    return res.json(data);
  } catch (err) {
    console.error(`[price] ${err.message}`);
    if (cached) return res.json({ ...cached.data, stale: true });
    return res.status(502).json({ error: err.message });
  }
});

// Batch prezzi
app.post('/api/prices/batch', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Serve array "ids"' });
  }

  const toFetch = ids.slice(0, 100);
  const results = {};

  const uncached = [];
  for (const id of toFetch) {
    const cached = cacheGet(priceCache, String(id));
    if (cached && !cached.stale) {
      results[id] = cached.data;
    } else {
      uncached.push(String(id));
    }
  }

  const CHUNK = 5;
  for (let i = 0; i < uncached.length; i += CHUNK) {
    const chunk = uncached.slice(i, i + CHUNK);

    await Promise.all(
      chunk.map(async (id) => {
        if (requestsThisMinute >= MAX_RPM) {
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
          const stale = cacheGet(priceCache, id);
          if (stale) results[id] = { ...stale.data, stale: true };
        }
      })
    );

    if (i + CHUNK < uncached.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  res.json(results);
});

// Cerca giocatore per nome
app.get('/api/search', async (req, res) => {
  const name = (req.query.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Parametro "name" richiesto' });

  const nameLower = name.toLowerCase();
  const cached = cacheGet(searchCache, nameLower);
  if (cached && !cached.stale) return res.json(cached.data);

  if (!checkRate(res)) return;

  try {
    const url = `${FUTBIN_PLAYERS_URL}?search=${encodeURIComponent(name)}`;
    const response = await futbinFetch(url);

    if (!response.ok) throw new Error(`FUTBIN search ${response.status}`);

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
      const regex = /\/(?:25|26)\/player\/(\d+)\/([^"]+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        players.push({
          id: match[1],
          name: match[2].replace(/-/g, ' '),
          rating: 0, position: '', club: '', nation: '',
        });
      }
    }

    const result = { players, query: name, count: players.length };
    cacheSet(searchCache, nameLower, result);
    return res.json(result);
  } catch (err) {
    console.error(`[search] ${err.message}`);
    if (cached) return res.json({ ...cached.data, stale: true });
    return res.status(502).json({ error: err.message });
  }
});

// Lista giocatori per pagina
app.get('/api/players', async (req, res) => {
  const page = req.query.page || 1;
  const sort = req.query.sort || 'Overall';
  const order = req.query.order || 'desc';

  const cacheKey = `players_${page}_${sort}_${order}`;
  const cached = cacheGet(searchCache, cacheKey);
  if (cached && !cached.stale) return res.json(cached.data);

  if (!checkRate(res)) return;

  try {
    const url = `${FUTBIN_PLAYERS_URL}?page=${page}&sort=${sort}&order=${order}&version=all_versions`;
    const response = await futbinFetch(url);

    if (!response.ok) throw new Error(`FUTBIN players ${response.status}`);

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
      const regex = /\/(?:25|26)\/player\/(\d+)\/([^"]+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        players.push({
          id: match[1],
          name: match[2].replace(/-/g, ' '),
          rating: 0, position: '', club: '', nation: '',
        });
      }
    }

    cacheSet(searchCache, cacheKey, players);
    return res.json(players);
  } catch (err) {
    console.error(`[players] ${err.message}`);
    if (cached) return res.json(cached.data);
    return res.status(502).json({ error: err.message });
  }
});

// Root info
app.get('/', (_req, res) => {
  res.json({
    name: 'FC26 Market Proxy',
    version: '1.1.0',
    session: sessionReady,
    endpoints: {
      health: 'GET /api/health',
      price: 'GET /api/price/:futbinId',
      batch: 'POST /api/prices/batch { ids: [...] }',
      search: 'GET /api/search?name=Mbappé',
      players: 'GET /api/players?page=1&sort=Overall&order=desc',
    },
  });
});

// ─────────────────────────────────────────────
// START — inizializza sessione poi avvia server
// ─────────────────────────────────────────────
(async () => {
  await initSession();

  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   FC26 Market Proxy v1.1 — Cookie + UA Rot   ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Porta:    ${String(PORT).padEnd(33)}║`);
    console.log(`║  Sessione: ${(sessionReady ? '✅ Attiva' : '❌ Fallita').padEnd(33)}║`);
    console.log('║                                              ║');
    console.log('║  GET  /api/health                            ║');
    console.log('║  GET  /api/price/:id                         ║');
    console.log('║  POST /api/prices/batch                      ║');
    console.log('║  GET  /api/search?name=...                   ║');
    console.log('║  GET  /api/players?page=1                    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  });
})();
