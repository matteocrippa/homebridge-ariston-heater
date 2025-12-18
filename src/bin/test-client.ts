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
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith('\'') && v.endsWith('\''))
      )
        v = v.slice(1, -1);
      if (!(k in process.env)) (process.env as any)[k] = v;
    }
  }
} catch {}

(async () => {
  try {
    const cacheDir = process.env.ARISTON_CACHE_DIR || process.cwd();
    const client = new AristonClient({ cacheDir, log: console, debug: true });

    // Login
    await client.login();
    console.log('Login successful\n');

    // Get plant ID
    let plantId: string | null = process.env.ARISTON_PLANT || null;
    if (!plantId) {
      plantId = await client.discoverPlantId();
      if (!plantId) {
        console.error('No devices found');
        process.exit(1);
      }
      console.log(`Discovered plant: ${plantId}\n`);
    }

    // Discover variant
    const variant = await client.discoverVariant(plantId);
    console.log(`Using variant: ${variant}\n`);

    // Get plant data
    const data = await client.getPlantData(plantId, variant);
    if (data) {
      console.log('Plant Data:');
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('No data returned');
    }
  } catch (e: any) {
    console.error('Error:', e?.message || e);
    process.exit(1);
  }
})();
