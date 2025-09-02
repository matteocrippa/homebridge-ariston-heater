import axios, { AxiosInstance } from 'axios';
import { VariantStorage } from './storage';

export interface AristonClientOpts {
  baseURL?: string;
  userAgent?: string;
  username?: string;
  password?: string;
  log?: Console;
  debug?: boolean;
  cacheDir?: string;
}

export interface PlantBest {
  kind: string;
  data: any;
  fields: {
    currentTemp?: number;
    targetTemp?: number;
    powerState?: boolean;
    antiLeg?: boolean;
    heatReq?: boolean;
    avShw?: number;
  };
  score: number;
}

export class RateLimitError extends Error {
  retryAfter?: number;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class AristonClient {
  private http: AxiosInstance;
  private token: string | null = null;
  private storage: VariantStorage;
  private baseURL: string;
  private userAgent: string;
  private username?: string;
  private password?: string;
  private log: Console;
  private debug: boolean;

  constructor({ baseURL, userAgent, username, password, log = console, debug = false, cacheDir }: AristonClientOpts = {}) {
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
      // Accept up to 599 so axios doesn’t throw on 5xx; we’ll handle status checks explicitly.
      validateStatus: (s) => s >= 200 && s < 600,
    });
    this.storage = new VariantStorage(cacheDir, log);
  }

  private parseRetryAfter(v: any): number | undefined {
    if (!v) return undefined;
    // Retry-After can be seconds or HTTP-date
    const s = String(v);
    const asNum = Number(s);
    if (Number.isFinite(asNum) && asNum > 0) return Math.min(600, Math.max(1, Math.floor(asNum))); // cap to 10 minutes
    const d = Date.parse(s);
    if (!Number.isNaN(d)) {
      const secs = Math.ceil((d - Date.now()) / 1000);
      return secs > 0 ? Math.min(600, secs) : 1;
    }
    return undefined;
  }

  private async doGet(path: string, headers: Record<string, any>) {
    const res = await this.http.get(path, { headers });
    if (this.debug) this.log.log(`[GET ${path}] status=${res.status}`);
    if (res.status === 429) {
      const ra = this.parseRetryAfter((res.headers as any)?.['retry-after']);
      throw new RateLimitError('Rate limited', ra);
    }
    return res;
  }

  async login(): Promise<string> {
    const body = {
      usr: this.username,
      pwd: this.password,
      imp: false,
      notTrack: true,
      appInfo: { os: 2, appVer: '5.6.7772.40151', appId: 'com.remotethermo.aristonnet' },
    };
    const res = await this.http.post('accounts/login', body);
  if (this.debug) this.log.log(`[login] status=${res.status}`);
    if (res.status !== 200 || !(res.data && (res.data as any).token)) throw new Error(`Login failed (${res.status})`);
    const token = (res.data as any).token as string;
    this.token = token;
    return token;
  }

  async discoverVelis(): Promise<any[]> {
    const headers = { 'ar.authToken': this.token as string };
    const paths = ['velis/medPlants', 'velis/plants'];
    for (const p of paths) {
      try {
        const res = await this.doGet(p, headers);
        if (res.status === 200 && Array.isArray(res.data) && res.data.length) return res.data as any[];
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
      }
    }
    return [];
  }

  private extractFields(raw: any) {
    const get = (o: any, ks: string[]) => {
      const k = ks.find((key) => o && Object.prototype.hasOwnProperty.call(o, key) && o[key] != null);
      return k ? o[k] : undefined;
    };
    const currentTemp = get(raw, ['temp', 'wtrTemp', 'currentTemp', 'currTemp', 'tCur']);
    const targetTemp = get(raw, ['procReqTemp', 'reqTemp', 'targetTemp', 'tSet']);
    const powerState = get(raw, ['on', 'power', 'pwr']);
    const antiLeg = get(raw, ['antiLeg', 'antiLegionella', 'antiLegionellaActive']);
    const heatReq = get(raw, ['heatReq', 'heatingReq', 'heatingRequest']);
    const avShw = get(raw, ['avShw', 'availableShowers', 'avShow']);
    return { currentTemp, targetTemp, powerState, antiLeg, heatReq, avShw } as {
      currentTemp?: number;
      targetTemp?: number;
      powerState?: boolean;
      antiLeg?: boolean;
      heatReq?: boolean;
      avShw?: number;
    };
  }

  async getBestVelisPlantData(plantId: string): Promise<PlantBest> {
    const headers = { 'ar.authToken': this.token as string };
    const cached = this.storage.getVariant(plantId)?.variant;
    if (cached) {
      try {
        const url = `velis/${cached}/${encodeURIComponent(plantId)}`;
        const res = await this.doGet(url, headers);
        if (this.debug) this.log.log(`[GET ${url}] status=${res.status} (cached)`);
        if (res.status === 200 && res.data && Object.keys(res.data as any).length) {
          const fields = this.extractFields(res.data);
          return { kind: cached, data: res.data, fields, score: 99 };
        }
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
      }
    }

    const variants = ['sePlantData', 'medPlantData', 'slpPlantData', 'onePlantData', 'evoPlantData'];
    const isNum = (v: any) => typeof v === 'number' && Number.isFinite(v);
    const gt0 = (v: any) => isNum(v) && v > 0 && v < 100;
    const scoreCandidate = (f: { currentTemp?: number; targetTemp?: number; powerState?: boolean }) => {
      let score = 0;
      if (gt0(f.currentTemp)) score += 3;
      if (gt0(f.targetTemp)) score += 2;
      if (typeof f.powerState === 'boolean') score += 1;
      const bothZeroOrNull = (!isNum(f.currentTemp) || f.currentTemp === 0) && (!isNum(f.targetTemp) || f.targetTemp === 0);
      if (bothZeroOrNull && f.powerState === false) score = 0;
      return score;
    };

    const candidates: PlantBest[] = [] as any;
    let saw429 = false;
    let maxRetryAfter: number | undefined;
    for (const v of variants) {
      const url = `velis/${v}/${encodeURIComponent(plantId)}`;
      try {
        const res = await this.doGet(url, headers);
        if (res.status === 200 && res.data && Object.keys(res.data as any).length) {
          const fields = this.extractFields(res.data);
          const score = scoreCandidate(fields);
          candidates.push({ kind: v, data: res.data, fields, score });
        }
      } catch (e: any) {
        if (e instanceof RateLimitError) {
          saw429 = true;
          if (typeof e.retryAfter === 'number') maxRetryAfter = Math.max(maxRetryAfter || 0, e.retryAfter);
        }
        if (this.debug) this.log.error(`[GET ${url}] error: ${e?.message || e}`);
        // continue with next variant
      }
    }
    if (!candidates.length) {
      if (saw429) throw new RateLimitError('Rate limited', maxRetryAfter);
      throw new Error('No plant data');
    }
    candidates.sort((a, b) => b.score - a.score || variants.indexOf(a.kind) - variants.indexOf(b.kind));
    const best = candidates[0];
    this.storage.setVariant(plantId, best.kind);
    return best;
  }

  async setTemperature(variantKind: string, plantId: string, oldTemp: number, newTemp: number, eco = false) {
    const headers = { 'ar.authToken': this.token as string };
    const url = `velis/${variantKind}/${encodeURIComponent(plantId)}/temperature`;
    const body = { eco: !!eco, old: oldTemp, new: newTemp };
    const res = await this.http.post(url, body, { headers });
    if (this.debug) this.log.log(`[POST ${url}] status=${res.status}`);
    if (res.status !== 200) throw new Error(`Set temperature failed (${res.status})`);
  }

  async setPower(variantKind: string, plantId: string, on: boolean) {
    const headers = { 'ar.authToken': this.token as string };
    const url = `velis/${variantKind}/${encodeURIComponent(plantId)}/switch`;
    const res = await this.http.post(url, !!on, { headers });
    if (this.debug) this.log.log(`[POST ${url}] status=${res.status}`);
    if (res.status !== 200) throw new Error(`Set power failed (${res.status})`);
  }
}
