#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { AristonClient } from '../client';

// Lightweight .env loader
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, k, vRaw] = m as any;
      let v = vRaw;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) v = v.slice(1, -1);
      if (!(k in process.env)) (process.env as any)[k] = v;
    }
  }
} catch {}

(async () => {
  try {
    const cacheDir = process.env.ARISTON_CACHE_DIR || process.cwd();
    const client = new AristonClient({ cacheDir, log: console });
    await client.login();
    const gw = process.env.ARISTON_PLANT;
    if (!gw) {
      const devices = await client.discoverVelis();
      console.log(JSON.stringify(devices, null, 2));
      if (!devices.length) return;
      const d: any = devices[0];
      const first = d.gw || d.gateway || d.id || d.plantId;
      const best = await client.getBestVelisPlantData(first);
      console.log(JSON.stringify({ plant: first, variant: best.kind, fields: best.fields, raw: best.data }, null, 2));
    } else {
      const best = await client.getBestVelisPlantData(gw);
      console.log(JSON.stringify({ plant: gw, variant: best.kind, fields: best.fields, raw: best.data }, null, 2));
    }
  } catch (e: any) {
    console.error('Error:', e?.message || e);
    process.exit(1);
  }
})();
