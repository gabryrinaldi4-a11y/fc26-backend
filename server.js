// ─────────────────────────────────────────────
// FC26 Market Proxy — CommonJS, node-fetch v2
// ─────────────────────────────────────────────
var express = require('express');
var cors = require('cors');
var fetch = require('node-fetch');
var tough = require('tough-cookie');
var makeFetchCookie = require('fetch-cookie');

var PORT = process.env.PORT || 3001;
var CACHE_TTL = 10 * 60 * 1000;
var SESSION_TTL = 30 * 60 * 1000;
var FUTBIN_PRICE = 'https://www.futbin.com/25/playerPrices';
var FUTBIN_PLAYERS = 'https://www.futbin.com/25/players';
var FUTBIN_HOME = 'https://www.futbin.com/';

// ─────────────────────────────────────────────
// COOKIE JAR
// ─────────────────────────────────────────────
var jar = new tough.CookieJar();
var fetchWithCookies = makeFetchCookie(fetch, jar);

// ─────────────────────────────────────────────
// USER AGENTS
// ─────────────────────────────────────────────
var UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function pickUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

function makeHeaders() {
  return {
    'User-Agent': pickUA(),
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
// SESSION
// ─────────────────────────────────────────────
var sessionOk = false;
var sessionTime = 0;

function initSession() {
  console.log('[session] Visiting FUTBIN homepage...');
  return fetchWithCookies(FUTBIN_HOME, {
    headers: makeHeaders(),
    redirect: 'follow',
  })
    .then(function () {
      sessionOk = true;
      sessionTime = Date.now();
      console.log('[session] ✅ Session ready');
    })
    .catch(function (err) {
      console.error('[session] ❌ Failed:', err.message);
      sessionOk = false;
    });
}

function ensureSession() {
  if (!sessionOk || Date.now() - sessionTime > SESSION_TTL) {
    return initSession();
  }
  return Promise.resolve();
}

// ─────────────────────────────────────────────
// FUTBIN FETCH with retry on 403
// ─────────────────────────────────────────────
function futbinFetch(url) {
  return ensureSession()
    .then(function () {
      return fetchWithCookies(url, { headers: makeHeaders(), redirect: 'follow' });
    })
    .then(function (res) {
      if (res.status === 403) {
        console.log('[fetch] 403 — renewing session and retrying...');
        return initSession().then(function () {
          return fetchWithCookies(url, { headers: makeHeaders(), redirect: 'follow' });
        });
      }
      return res;
    });
}

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────
var priceCache = {};
var searchCache = {};

function cGet(cache, key) {
  var e = cache[key];
  if (!e) return null;
  var stale = Date.now() - e.ts > CACHE_TTL;
  return { data: e.data, stale: stale };
}

function cSet(cache, key, data) {
  cache[key] = { data: data, ts: Date.now() };
}

// ─────────────────────────────────────────────
// PARSE PRICE
// ─────────────────────────────────────────────
function parsePrice(raw) {
  if (!raw || raw === '0' || raw === 'N/A' || raw === '---') return 0;
  var s = String(raw).replace(/,/g, '').trim();
  if (s.toUpperCase().endsWith('K')) return Math.round(parseFloat(s) * 1000);
  if (s.toUpperCase().endsWith('M')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s, 10) || 0;
}

// ─────────────────────────────────────────────
// FETCH SINGLE PRICE
// ─────────────────────────────────────────────
function fetchPrice(id) {
  var url = FUTBIN_PRICE + '?player=' + id;
  return futbinFetch(url).then(function (res) {
    if (!res.ok) throw new Error('FUTBIN ' + res.status + ' for ' + id);
    return res.json();
  }).then(function (json) {
    var entry = json[String(id)] || json[Object.keys(json)[0]];
    if (!entry || !entry.prices) throw new Error('No prices for ' + id);
    return {
      ps: parsePrice(entry.prices.ps ? entry.prices.ps.LCPrice : '0'),
      xbox: parsePrice(entry.prices.xbox ? entry.prices.xbox.LCPrice : '0'),
      pc: parsePrice(entry.prices.pc ? entry.prices.pc.LCPrice : '0'),
      ps_bin: parsePrice(entry.prices.ps ? entry.prices.ps.BINPrice : '0'),
      xbox_bin: parsePrice(entry.prices.xbox ? entry.prices.xbox.BINPrice : '0'),
      pc_bin: parsePrice(entry.prices.pc ? entry.prices.pc.BINPrice : '0'),
      updatedAt: Date.now(),
      futbinId: String(id),
      isReal: true,
    };
  });
}

// ─────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────
var app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

var rpm = 0;
setInterval(function () { rpm = 0; }, 60000);
var MAX_RPM = 60;

function rateOk(res) {
  if (rpm >= MAX_RPM) {
    res.status(429).json({ error: 'Rate limit' });
    return false;
  }
  rpm++;
  return true;
}

// Health
app.get('/api/health', function (_req, res) {
  res.json({
    status: 'ok',
    session: sessionOk,
    cached: Object.keys(priceCache).length,
    uptime: Math.floor(process.uptime()),
    rpm: rpm,
  });
});

// Single price
app.get('/api/price/:id', function (req, res) {
  var id = req.params.id;
  var c = cGet(priceCache, id);
  if (c && !c.stale) return res.json(c.data);
  if (!rateOk(res)) return;

  fetchPrice(id)
    .then(function (data) {
      cSet(priceCache, id, data);
      res.json(data);
    })
    .catch(function (err) {
      console.error('[price] ' + err.message);
      if (c) return res.json(Object.assign({}, c.data, { stale: true }));
      res.status(502).json({ error: err.message });
    });
});

// Batch prices
app.post('/api/prices/batch', function (req, res) {
  var ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Need ids array' });
  }

  var list = ids.slice(0, 100);
  var results = {};
  var uncached = [];

  list.forEach(function (id) {
    var c = cGet(priceCache, String(id));
    if (c && !c.stale) {
      results[id] = c.data;
    } else {
      uncached.push(String(id));
    }
  });

  var CHUNK = 5;
  var chunks = [];
  for (var i = 0; i < uncached.length; i += CHUNK) {
    chunks.push(uncached.slice(i, i + CHUNK));
  }

  function processChunk(idx) {
    if (idx >= chunks.length) return Promise.resolve();
    var chunk = chunks[idx];

    return Promise.all(
      chunk.map(function (id) {
        if (rpm >= MAX_RPM) {
          var s = cGet(priceCache, id);
          if (s) results[id] = Object.assign({}, s.data, { stale: true });
          return Promise.resolve();
        }
        rpm++;
        return fetchPrice(id)
          .then(function (data) {
            cSet(priceCache, id, data);
            results[id] = data;
          })
          .catch(function (err) {
            console.error('[batch] ' + id + ': ' + err.message);
            var s = cGet(priceCache, id);
            if (s) results[id] = Object.assign({}, s.data, { stale: true });
          });
      })
    ).then(function () {
      if (idx + 1 < chunks.length) {
        return new Promise(function (r) { setTimeout(r, 400); })
          .then(function () { return processChunk(idx + 1); });
      }
    });
  }

  processChunk(0).then(function () {
    res.json(results);
  });
});

// Search
app.get('/api/search', function (req, res) {
  var name = (req.query.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Need name param' });

  var key = name.toLowerCase();
  var c = cGet(searchCache, key);
  if (c && !c.stale) return res.json(c.data);
  if (!rateOk(res)) return;

  var url = FUTBIN_PLAYERS + '?search=' + encodeURIComponent(name);
  futbinFetch(url)
    .then(function (response) {
      if (!response.ok) throw new Error('FUTBIN search ' + response.status);
      return response.text();
    })
    .then(function (text) {
      var players = [];
      try {
        var json = JSON.parse(text);
        if (Array.isArray(json)) {
          players = json.map(function (p) {
            return {
              id: String(p.id),
              name: p.name || p.common_name || '',
              rating: p.rating || p.ovr || 0,
              position: p.position || '',
              club: p.club || '',
              nation: p.nation || '',
            };
          });
        }
      } catch (_e) {
        var regex = /\/(?:25|26)\/player\/(\d+)\/([^"]+)/g;
        var match;
        while ((match = regex.exec(text)) !== null) {
          players.push({
            id: match[1],
            name: match[2].replace(/-/g, ' '),
            rating: 0, position: '', club: '', nation: '',
          });
        }
      }
      var result = { players: players, query: name, count: players.length };
      cSet(searchCache, key, result);
      res.json(result);
    })
    .catch(function (err) {
      console.error('[search] ' + err.message);
      if (c) return res.json(Object.assign({}, c.data, { stale: true }));
      res.status(502).json({ error: err.message });
    });
});

// Players list
app.get('/api/players', function (req, res) {
  var page = req.query.page || 1;
  var sort = req.query.sort || 'Overall';
  var order = req.query.order || 'desc';
  var key = 'p_' + page + '_' + sort + '_' + order;

  var c = cGet(searchCache, key);
  if (c && !c.stale) return res.json(c.data);
  if (!rateOk(res)) return;

  var url = FUTBIN_PLAYERS + '?page=' + page + '&sort=' + sort + '&order=' + order + '&version=all_versions';
  futbinFetch(url)
    .then(function (response) {
      if (!response.ok) throw new Error('FUTBIN players ' + response.status);
      return response.text();
    })
    .then(function (text) {
      var players = [];
      try {
        var json = JSON.parse(text);
        if (Array.isArray(json)) {
          players = json.map(function (p) {
            return {
              id: String(p.id),
              name: p.name || p.common_name || '',
              rating: p.rating || p.ovr || 0,
              position: p.position || '',
              club: p.club || '',
              nation: p.nation || '',
            };
          });
        }
      } catch (_e) {
        var regex = /\/(?:25|26)\/player\/(\d+)\/([^"]+)/g;
        var match;
        while ((match = regex.exec(text)) !== null) {
          players.push({
            id: match[1],
            name: match[2].replace(/-/g, ' '),
            rating: 0, position: '', club: '', nation: '',
          });
        }
      }
      cSet(searchCache, key, players);
      res.json(players);
    })
    .catch(function (err) {
      console.error('[players] ' + err.message);
      if (c) return res.json(c.data);
      res.status(502).json({ error: err.message });
    });
});

// Root
app.get('/', function (_req, res) {
  res.json({
    name: 'FC26 Market Proxy',
    version: '1.1.0',
    session: sessionOk,
    endpoints: {
      health: 'GET /api/health',
      price: 'GET /api/price/:id',
      batch: 'POST /api/prices/batch { ids: [...] }',
      search: 'GET /api/search?name=Mbappé',
      players: 'GET /api/players?page=1',
    },
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
initSession().then(function () {
  app.listen(PORT, function () {
    console.log('');
    console.log('=== FC26 Market Proxy v1.1 ===');
    console.log('Port:    ' + PORT);
    console.log('Session: ' + (sessionOk ? 'OK' : 'FAILED'));
    console.log('');
    console.log('GET  /api/health');
    console.log('GET  /api/price/:id');
    console.log('POST /api/prices/batch');
    console.log('GET  /api/search?name=...');
    console.log('GET  /api/players?page=1');
    console.log('=============================');
    console.log('');
  });
});
