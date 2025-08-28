#!/usr/bin/env node
// Simple CLI to test AristonClient independently (uses .env if present)
const fs = require('fs');
const path = require('path');
const { AristonClient } = require('../src/client');

// Lightweight .env loader
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let [, k, v] = m;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
} catch {}

(async () => {
  try {
  const cacheDir = process.env.ARISTON_CACHE_DIR || process.cwd();
  const client = new AristonClient({ cacheDir, log: console.log });
    await client.login();
    const gw = process.env.ARISTON_PLANT;
    if (!gw) {
      const devices = await client.discoverVelis();
      console.log(JSON.stringify(devices, null, 2));
      if (!devices.length) return;
      const first = devices[0].gw || devices[0].gateway || devices[0].id || devices[0].plantId;
      const best = await client.getBestVelisPlantData(first);
      console.log(JSON.stringify({ plant: first, variant: best.kind, fields: best.fields, raw: best.data }, null, 2));
    } else {
      const best = await client.getBestVelisPlantData(gw);
      console.log(JSON.stringify({ plant: gw, variant: best.kind, fields: best.fields, raw: best.data }, null, 2));
    }
  } catch (e) {
    console.error('Error:', e?.message || e);
    process.exit(1);
  }
})();
