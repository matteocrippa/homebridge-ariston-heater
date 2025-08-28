const axios = require('axios');
const { VariantStorage } = require('./storage');

class AristonClient {
  constructor({ baseURL, userAgent, username, password, log = console, debug = false, cacheDir } = {}) {
    this.baseURL = baseURL || process.env.ARISTON_API || 'https://www.ariston-net.remotethermo.com/api/v2/';
    this.userAgent = userAgent || process.env.ARISTON_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';
    this.username = username || process.env.ARISTON_USER;
    this.password = password || process.env.ARISTON_PASS;
    this.log = log;
    this.debug = !!debug || process.env.ARISTON_DEBUG === '1' || process.env.DEBUG === '1';

  this.http = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/json' },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    this.token = null;
  this.storage = new VariantStorage(cacheDir, log);
  }

  async login() {
    const body = {
      usr: this.username,
      pwd: this.password,
      imp: false,
      notTrack: true,
      appInfo: { os: 2, appVer: '5.6.7772.40151', appId: 'com.remotethermo.aristonnet' },
    };
    const res = await this.http.post('accounts/login', body);
    if (this.debug) this.log(`[login] status=${res.status}`);
    if (res.status !== 200 || !res.data?.token) throw new Error(`Login failed (${res.status})`);
    this.token = res.data.token;
    return this.token;
  }

  async discoverVelis() {
    const headers = { 'ar.authToken': this.token };
    const paths = ['velis/medPlants', 'velis/plants'];
    for (const p of paths) {
      const res = await this.http.get(p, { headers });
      if (this.debug) this.log(`[GET ${p}] status=${res.status}`);
      if (res.status === 200 && Array.isArray(res.data) && res.data.length) return res.data;
    }
    return [];
  }

  extractFields(raw) {
    const get = (o, ks) => ks.find((k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) && o[ks.find((k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null)];
    const currentTemp = get(raw, ['temp', 'wtrTemp', 'currentTemp', 'currTemp', 'tCur']);
    const targetTemp = get(raw, ['procReqTemp', 'reqTemp', 'targetTemp', 'tSet']);
    const powerState = get(raw, ['on', 'power', 'pwr']);
    return { currentTemp, targetTemp, powerState };
  }

  async getBestVelisPlantData(plantId) {
    // If we have a cached variant, try it first for speed
    const cached = this.storage.getVariant(plantId)?.variant;
    const headers = { 'ar.authToken': this.token };
    if (cached) {
      try {
        const url = `velis/${cached}/${encodeURIComponent(plantId)}`;
        const res = await this.http.get(url, { headers });
        if (this.debug) this.log(`[GET ${url}] status=${res.status} (cached)`);
        if (res.status === 200 && res.data && Object.keys(res.data).length) {
          const fields = this.extractFields(res.data);
          return { kind: cached, data: res.data, fields, score: 99 };
        }
      } catch {}
    }
    const variants = ['sePlantData', 'medPlantData', 'slpPlantData', 'onePlantData', 'evoPlantData'];
    const scoreCandidate = (fields) => {
      const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
      const gt0 = (v) => isNum(v) && v > 0 && v < 100;
      let score = 0;
      if (gt0(fields.currentTemp)) score += 3;
      if (gt0(fields.targetTemp)) score += 2;
      if (typeof fields.powerState === 'boolean') score += 1;
      const bothZeroOrNull = (!isNum(fields.currentTemp) || fields.currentTemp === 0) && (!isNum(fields.targetTemp) || fields.targetTemp === 0);
      if (bothZeroOrNull && fields.powerState === false) score = 0;
      return score;
    };

    const candidates = [];
    for (const v of variants) {
      const url = `velis/${v}/${encodeURIComponent(plantId)}`;
      const res = await this.http.get(url, { headers });
      if (this.debug) this.log(`[GET ${url}] status=${res.status}`);
      if (res.status === 200 && res.data && Object.keys(res.data).length) {
        const fields = this.extractFields(res.data);
        const score = scoreCandidate(fields);
        candidates.push({ kind: v, data: res.data, score, fields });
      }
    }
  if (!candidates.length) throw new Error('No plant data');
  candidates.sort((a, b) => b.score - a.score || variants.indexOf(a.kind) - variants.indexOf(b.kind));
  const best = candidates[0];
  // Persist the winning variant for this plant
  this.storage.setVariant(plantId, best.kind);
  return best;
  }

  async setTemperature(variantKind, plantId, oldTemp, newTemp, eco = false) {
    const headers = { 'ar.authToken': this.token };
    const url = `velis/${variantKind}/${encodeURIComponent(plantId)}/temperature`;
    const body = { eco: !!eco, old: oldTemp, new: newTemp };
    const res = await this.http.post(url, body, { headers });
    if (this.debug) this.log(`[POST ${url}] status=${res.status}`);
    if (res.status !== 200) throw new Error(`Set temperature failed (${res.status})`);
  }

  async setPower(variantKind, plantId, on) {
    const headers = { 'ar.authToken': this.token };
    const url = `velis/${variantKind}/${encodeURIComponent(plantId)}/switch`;
    const res = await this.http.post(url, !!on, { headers });
    if (this.debug) this.log(`[POST ${url}] status=${res.status}`);
    if (res.status !== 200) throw new Error(`Set power failed (${res.status})`);
  }
}

module.exports = { AristonClient };
