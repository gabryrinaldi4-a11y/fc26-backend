var express = require('express');
var cors = require('cors');
var fetch = require('node-fetch');

var app = express();
app.use(cors());
app.use(express.json());

var cache = {};
var CACHE_TTL = 600000; // 10 minuti

var HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://fut.gg/',
};

function extractPrice(data, id) {
  if (!data) return 0;
  // fut.gg può avere formati diversi, proviamo tutti
  if (data[id] && data[id].price) return data[id].price;
  if (data[id] && data[id].lowest_bin) return data[id].lowest_bin;
  if (data.prices && data.prices[id]) return data.prices[id];
  if (data.data && Array.isArray(data.data)) {
    for (var i = 0; i < data.data.length; i++) {
      var item = data.data[i];
      if (String(item.player_id) === String(id) || String(item.id) === String(id)) {
        return item.price || item.lowest_bin || item.lowest_price || 0;
      }
    }
  }
  if (data.data && data.data[id]) {
    var d = data.data[id];
    return d.price || d.lowest_bin || d.lowest_price || 0;
  }
  var keys = Object.keys(data);
  for (var j = 0; j < keys.length; j++) {
    var val = data[keys[j]];
    if (val && typeof val === 'object' && (val.price || val.lowest_bin)) {
      return val.price || val.lowest_bin || 0;
    }
  }
  return 0;
}

function fetchPlatformPrice(id, platform) {
  var url = 'https://fut.gg/api/fut/player-prices/?player_ids=' + id + '&platform=' + platform;
  return fetch(url, { headers: HEADERS })
    .then(function(r) {
      if (!r.ok) return null;
      return r.json();
    })
    .then(function(data) {
      if (!data) return 0;
      return extractPrice(data, id);
    })
    .catch(function() {
      return 0;
    });
}

// Health check
app.get('/api/health', function(req, res) {
  res.json({
    status: 'ok',
    cached: Object.keys(cache).length,
    uptime: Math.floor(process.uptime()),
  });
});

// Prezzo singolo
app.get('/api/price/:id', function(req, res) {
  var id = req.params.id;

  if (cache[id] && Date.now() - cache[id].updatedAt < CACHE_TTL) {
    return res.json(cache[id]);
  }

  Promise.all([
    fetchPlatformPrice(id, 'ps4'),
    fetchPlatformPrice(id, 'xboxone'),
    fetchPlatformPrice(id, 'pc'),
  ])
    .then(function(prices) {
      var result = {
        ps: prices[0] || 0,
        xbox: prices[1] || 0,
        pc: prices[2] || 0,
        updatedAt: Date.now(),
        isReal: (prices[0] > 0 || prices[1] > 0 || prices[2] > 0),
      };
      if (result.isReal) {
        cache[id] = result;
      }
      res.json(result);
    })
    .catch(function(err) {
      if (cache[id]) {
        return res.json(cache[id]);
      }
      res.status(500).json({ error: err.message });
    });
});

// Batch prezzi
app.post('/api/prices/batch', function(req, res) {
  var ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Need ids array' });
  }

  var list = ids.slice(0, 50);
  var results = {};
  var toFetch = [];

  for (var i = 0; i < list.length; i++) {
    var id = String(list[i]);
    if (cache[id] && Date.now() - cache[id].updatedAt < CACHE_TTL) {
      results[id] = cache[id];
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) {
    return res.json(results);
  }

  // Fetch a gruppi di 5
  var chunks = [];
  for (var j = 0; j < toFetch.length; j += 5) {
    chunks.push(toFetch.slice(j, j + 5));
  }

  function doChunk(idx) {
    if (idx >= chunks.length) {
      return Promise.resolve();
    }

    var promises = chunks[idx].map(function(id) {
      return Promise.all([
        fetchPlatformPrice(id, 'ps4'),
        fetchPlatformPrice(id, 'xboxone'),
        fetchPlatformPrice(id, 'pc'),
      ]).then(function(prices) {
        var result = {
          ps: prices[0] || 0,
          xbox: prices[1] || 0,
          pc: prices[2] || 0,
          updatedAt: Date.now(),
          isReal: (prices[0] > 0 || prices[1] > 0 || prices[2] > 0),
        };
        if (result.isReal) {
          cache[id] = result;
        }
        results[id] = result;
      }).catch(function() {
        if (cache[id]) results[id] = cache[id];
      });
    });

    return Promise.all(promises).then(function() {
      if (idx + 1 < chunks.length) {
        return new Promise(function(resolve) {
          setTimeout(resolve, 300);
        }).then(function() {
          return doChunk(idx + 1);
        });
      }
    });
  }

  doChunk(0).then(function() {
    res.json(results);
  });
});

// Cerca giocatore per nome su fut.gg
app.get('/api/search', function(req, res) {
  var name = (req.query.name || '').toString().trim();
  if (!name) {
    return res.status(400).json({ error: 'Need name param' });
  }

  var url = 'https://fut.gg/api/fut/players/?search=' + encodeURIComponent(name);
  fetch(url, { headers: HEADERS })
    .then(function(r) {
      if (!r.ok) throw new Error('fut.gg search ' + r.status);
      return r.json();
    })
    .then(function(data) {
      var players = [];
      var items = data.data || data.results || data;
      if (Array.isArray(items)) {
        for (var i = 0; i < Math.min(items.length, 20); i++) {
          var p = items[i];
          players.push({
            id: String(p.id || p.player_id || p.ea_id || ''),
            name: p.name || p.common_name || p.known_as || '',
            rating: p.rating || p.overall || p.ovr || 0,
            position: p.position || '',
            club: p.club || p.team || '',
            nation: p.nation || p.nationality || '',
          });
        }
      }
      res.json({ players: players, query: name, count: players.length });
    })
    .catch(function(err) {
      res.status(502).json({ error: err.message });
    });
});

// Root
app.get('/', function(req, res) {
  res.json({
    name: 'FC26 Market Proxy',
    version: '2.0.0',
    source: 'fut.gg',
    endpoints: {
      health: 'GET /api/health',
      price: 'GET /api/price/:id',
      batch: 'POST /api/prices/batch { ids: [...] }',
      search: 'GET /api/search?name=Mbappé',
    },
  });
});

// Start
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('FC26 Market Proxy v2.0 on port ' + PORT);
  console.log('Source: fut.gg');
  console.log('GET  /api/health');
  console.log('GET  /api/price/:id');
  console.log('POST /api/prices/batch');
  console.log('GET  /api/search?name=...');
});
