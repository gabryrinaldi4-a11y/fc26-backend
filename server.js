var express = require('express');
var cors = require('cors');
var fetch = require('node-fetch');

var app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─────────────────────────────────────────────
// PRICE STORAGE — populated by Chrome Extension
// ─────────────────────────────────────────────
var priceDb = {};
// Format: priceDb["158023"] = { ps: 245000, xbox: 210000, pc: 198000, updatedAt: 123456, isReal: true, name: "Messi" }

var stats = {
  totalReceived: 0,
  lastUpdateTime: 0,
  updatesCount: 0,
};

// ─────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────

// Health check
app.get('/api/health', function(req, res) {
  res.json({
    status: 'ok',
    cached: Object.keys(priceDb).length,
    uptime: Math.floor(process.uptime()),
    totalReceived: stats.totalReceived,
    lastUpdateTime: stats.lastUpdateTime,
    updatesCount: stats.updatesCount,
  });
});

// ─── Receive prices from Chrome Extension ───
app.post('/api/update-prices', function(req, res) {
  var players = req.body.players;
  if (!players || !Array.isArray(players)) {
    return res.status(400).json({ error: 'players array required' });
  }

  var saved = 0;
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (p.futbinId) {
      priceDb[p.futbinId] = {
        ps: p.pricePs || 0,
        xbox: p.priceXbox || 0,
        pc: p.pricePc || 0,
        updatedAt: p.updatedAt || Date.now(),
        isReal: true,
        name: p.name || '',
        ovr: p.ovr || 0,
        cardType: p.cardType || '',
        club: p.club || '',
        league: p.league || '',
        nation: p.nation || '',
      };
      saved++;
    }
  }

  stats.totalReceived += saved;
  stats.lastUpdateTime = Date.now();
  stats.updatesCount++;

  console.log('[update] Received ' + saved + ' prices. Total in DB: ' + Object.keys(priceDb).length);

  res.json({ ok: true, saved: saved, totalInDb: Object.keys(priceDb).length });
});

// ─── Get all prices ───
app.get('/api/prices/all', function(req, res) {
  res.json(priceDb);
});

// ─── Get single price by FUTBIN ID ───
app.get('/api/price/:id', function(req, res) {
  var id = req.params.id;
  var data = priceDb[id];

  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: 'Price not found for ID ' + id, isReal: false });
  }
});

// ─── Batch prices by IDs ───
app.post('/api/prices/batch', function(req, res) {
  var ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Need ids array' });
  }

  var results = {};
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i]);
    if (priceDb[id]) {
      results[id] = priceDb[id];
    }
  }

  res.json(results);
});

// ─── Search prices by name ───
app.get('/api/search', function(req, res) {
  var name = (req.query.name || '').toString().trim().toLowerCase();
  if (!name) {
    return res.status(400).json({ error: 'Need name param' });
  }

  var results = [];
  var keys = Object.keys(priceDb);
  for (var i = 0; i < keys.length; i++) {
    var entry = priceDb[keys[i]];
    if (entry.name && entry.name.toLowerCase().indexOf(name) >= 0) {
      results.push({
        futbinId: keys[i],
        name: entry.name,
        ps: entry.ps,
        xbox: entry.xbox,
        pc: entry.pc,
        ovr: entry.ovr,
        cardType: entry.cardType,
        updatedAt: entry.updatedAt,
      });
    }
    if (results.length >= 20) break;
  }

  res.json({ players: results, query: name, count: results.length });
});

// ─── Stats ───
app.get('/api/stats', function(req, res) {
  var totalPlayers = Object.keys(priceDb).length;
  var withPsPrice = 0;
  var withXboxPrice = 0;
  var withPcPrice = 0;
  var oldest = Date.now();
  var newest = 0;

  var keys = Object.keys(priceDb);
  for (var i = 0; i < keys.length; i++) {
    var entry = priceDb[keys[i]];
    if (entry.ps > 0) withPsPrice++;
    if (entry.xbox > 0) withXboxPrice++;
    if (entry.pc > 0) withPcPrice++;
    if (entry.updatedAt < oldest) oldest = entry.updatedAt;
    if (entry.updatedAt > newest) newest = entry.updatedAt;
  }

  res.json({
    totalPlayers: totalPlayers,
    withPsPrice: withPsPrice,
    withXboxPrice: withXboxPrice,
    withPcPrice: withPcPrice,
    oldestUpdate: oldest < Date.now() ? oldest : null,
    newestUpdate: newest > 0 ? newest : null,
    totalReceived: stats.totalReceived,
    updatesCount: stats.updatesCount,
    lastUpdateTime: stats.lastUpdateTime,
  });
});

// Root
app.get('/', function(req, res) {
  res.json({
    name: 'FC26 Market Proxy',
    version: '3.0.0',
    source: 'Chrome Extension + FUTBIN',
    playersInDb: Object.keys(priceDb).length,
    endpoints: {
      health: 'GET /api/health',
      price: 'GET /api/price/:futbinId',
      batch: 'POST /api/prices/batch { ids: [...] }',
      search: 'GET /api/search?name=Mbappe',
      all: 'GET /api/prices/all',
      update: 'POST /api/update-prices { players: [...] }',
      stats: 'GET /api/stats',
    },
  });
});

// Start
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('FC26 Market Proxy v3.0 on port ' + PORT);
  console.log('Waiting for Chrome Extension to send prices...');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/price/:id');
  console.log('  POST /api/prices/batch');
  console.log('  GET  /api/search?name=...');
  console.log('  GET  /api/prices/all');
  console.log('  POST /api/update-prices');
  console.log('  GET  /api/stats');
});
