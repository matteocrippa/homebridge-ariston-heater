import axios, { AxiosInstance } from 'axios';
import { VariantStorage } from './storage';

export interface SmallLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
}

export interface AristonClientOpts {
  baseURL?: string;
  userAgent?: string;
  username?: string;
  password?: string;
  log?: SmallLogger;
  debug?: boolean;
  cacheDir?: string;
}

const API_BASE = 'https://www.ariston-net.remotethermo.com/api/v2/';

// Tuning constants (easy to change in one place)
const DEFAULT_TIMEOUT_MS = 30000;
// TTL for the in-memory fallback when network fails (KISS)
const DEFAULT_FALLBACK_TTL_MS = 2 * 60 * 1000; // 2 minutes

const VARIANTS = [
  'sePlantData',
  'medPlantData',
  'slpPlantData',
  'onePlantData',
  'evoPlantData',
];

export interface PlantData {
  variant: string;
  raw: any;
  currentTemp?: number;
  targetTemp?: number;
  power?: boolean;
  antiLeg?: boolean;
  heatReq?: boolean;
  avShw?: number;
  mode?: number;
}

export class AristonClient {
  private http: AxiosInstance;
  private token: string | null = null;
  private storage: VariantStorage;
  private log: Required<SmallLogger>;
  private debug: boolean;
  private username?: string;
  private password?: string;
  // In-memory fallback cache keyed by `${plantId}::${variant}`
  private memoryCache: Map<string, { data: PlantData; ts: number }> = new Map();
  // Promise used to serialize concurrent logins
  private loginPromise: Promise<void> | null = null;
  // Promise used to ensure storage initialization occurs once
  private initPromise: Promise<void> | null = null;

  constructor(opts: AristonClientOpts = {}) {
    const baseURL = opts.baseURL || API_BASE;
    const userAgent =
      opts.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';

    this.username = opts.username || process.env.ARISTON_USER;
    this.password = opts.password || process.env.ARISTON_PASS;
    // Use injected logger; fallback to a noop logger to avoid accidental console usage
    const noopLogger: Required<SmallLogger> = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    this.log = (opts.log as any) || noopLogger;
    this.debug = !!opts.debug;
    this.storage = new VariantStorage(opts.cacheDir, this.log as any);

    if (!this.username || !this.password) {
      throw new Error('Ariston credentials required');
    }

    this.http = axios.create({
      baseURL,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: { 'User-Agent': userAgent, 'Content-Type': 'application/json' },
      validateStatus: () => true, // Handle all status codes manually
    });

    // Attach token automatically when present
    this.http.interceptors.request.use((config) => {
      if (this.token) {
        config.headers = config.headers || {};
        (config.headers as any)['ar.authToken'] = this.token;
      }
      return config;
    });

    // Retry once on 401 (avoid retrying login itself)
    this.http.interceptors.response.use(
      (res) => res,
      async (error) => {
        const { config, response } = error;
        try {
          if (
            response &&
            response.status === 401 &&
            config &&
            !config._retry &&
            !(config.url && config.url.toString().includes('accounts/login'))
          ) {
            // mark to avoid infinite loops
            config._retry = true;
            await this.login();
            config.headers = config.headers || {};
            (config.headers as any)['ar.authToken'] = this.token;
            return this.http.request(config);
          }
        } catch (e) {
          // if login fails, fall through to rejection below
        }
        return Promise.reject(error);
      },
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async login(): Promise<void> {
    // Serialize concurrent login attempts
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      const res = await this.http.post('accounts/login', {
        usr: this.username,
        pwd: this.password,
        imp: false,
        notTrack: true,
        appInfo: {
          os: 2,
          appVer: '6.0.10.40276',
          appId: 'com.remotethermo.aristonnet',
        },
      });

      if (res.status !== 200 || !res.data?.token) {
        this.token = null;
        this.loginPromise = null;
        throw new Error(`Login failed (${res.status})`);
      }

      this.token = res.data.token;
      if (this.debug) this.log.debug?.('Login successful');
      this.loginPromise = null;
    })();

    return this.loginPromise;
  }

  // Initialize underlying resources (async) — should be called once at startup
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      // initialize persistent storage (non-blocking)
      await this.storage.init();
    })();
    try {
      await this.initPromise;
    } finally {
      // always clear initPromise so caller can retry init later if needed
      this.initPromise = null;
    }
  }

  async discoverPlantId(): Promise<string | null> {
    // Ensure we're logged in; the interceptor will attach token
    await this.login();

    for (const p of ['velis/medPlants', 'velis/plants']) {
      const res = await this.http.get(p);
      if (
        res.status >= 200 &&
        res.status < 300 &&
        Array.isArray(res.data) &&
        res.data.length > 0
      ) {
        const plant = res.data[0];
        return plant.gw || plant.gateway || plant.id || plant.plantId || null;
      }
    }

    return null;
  }

  /**
   * One-time discovery to find which variant works for this device.
   * Called once at startup, result is cached.
   */
  async discoverVariant(plantId: string): Promise<string> {
    // Check cache first (storage is expected to be initialized at startup via client.init())
    const cached = this.storage.getVariant(plantId)?.variant;
    if (cached) {
      if (this.debug) this.log.debug?.(`Using cached variant: ${cached}`);
      return cached;
    }

    await this.login();
    this.log.info(`Discovering variant for ${plantId}...`);

    for (const variant of VARIANTS) {
      try {
        const url = `velis/${variant}/${encodeURIComponent(plantId)}`;
        const res = await this.http.get(url);

        if (this.debug) {
          this.log.debug?.(`Trying ${variant}: status=${res.status}`);
        }

        if (
          res.status >= 200 &&
          res.status < 300 &&
          res.data &&
          typeof res.data === 'object'
        ) {
          const data = res.data;
          // Check if response contains meaningful plant data.
          // Some Ariston endpoints return HTTP 200 with a valid-looking
          // structure but all state values set to zero/false.
          const hasMeaningfulData =
              (typeof data.temp === 'number' && data.temp > 0) ||
              (typeof data.reqTemp === 'number' && data.reqTemp > 0) ||
              (typeof data.procReqTemp === 'number' && data.procReqTemp > 0) ||
              (typeof data.avShw === 'number' && data.avShw > 0);

          if (hasMeaningfulData) {
              this.log.info(`Found working variant: ${variant}`);
              await this.storage.setVariant(plantId, variant);
              return variant;
          }

          if (this.debug) {
              this.log.info(`Variant ${variant} returned no meaningful plant data; trying next variant`);
          }
        }

        // Small delay between discovery attempts to avoid rate limiting
        await this.delay(1000);
      } catch (e: any) {
        if (this.debug)
          this.log.debug?.(`Variant ${variant} failed: ${e?.message || e}`);
        await this.delay(1000);
      }
    }

    throw new Error('Could not find working variant for this device');
  }

  /**
   * Simple data fetch using known variant. No discovery, no fallback.
   * If it fails, caller should retry with backoff.
   */
  async getPlantData(
    plantId: string,
    variant: string,
  ): Promise<PlantData | null> {
    await this.login();
    const url = `velis/${variant}/${encodeURIComponent(plantId)}`;

    // Single attempt fetch: keep it KISS — if it fails we'll use cache and try again next poll
    const res = await this.http.get(url);

    if (res.status >= 200 && res.status < 300) {
      if (!res.data || typeof res.data !== 'object') return null;
      const parsed = this.parsePlantData(res.data, variant);
      // store short-lived in-memory fallback
      try {
        const key = `${plantId}::${variant}`;
        this.memoryCache.set(key, { data: parsed, ts: Date.now() });
      } catch {
        // no-op on memory cache errors; this should not normally fail
      }
      return parsed;
    }

    // Rate limited or server error — return recent in-memory fallback if available
    if (res.status === 429 || res.status >= 500) {
      this.log.warn(
        'API transient error; returning in-memory fallback if available',
      );
      const key = `${plantId}::${variant}`;
      const entry = this.memoryCache.get(key);
      if (entry && Date.now() - entry.ts <= DEFAULT_FALLBACK_TTL_MS) {
        return entry.data;
      }
      return null;
    }

    // Other statuses (4xx etc.) — try in-memory fallback then give up
    const key = `${plantId}::${variant}`;
    const entry = this.memoryCache.get(key);
    if (entry && Date.now() - entry.ts <= DEFAULT_FALLBACK_TTL_MS) {
      return entry.data;
    }
    return null;
  }

  // Extract PlantData fields from raw response
  private parsePlantData(raw: any, variant: string): PlantData {
    return {
      variant,
      raw,
      currentTemp: raw.temp ?? raw.wtrTemp ?? raw.currentTemp,
      targetTemp: raw.reqTemp ?? raw.procReqTemp ?? raw.targetTemp,
      power: raw.on ?? raw.power,
      antiLeg: raw.antiLeg ?? raw.antiLegionella,
      heatReq: raw.heatReq ?? raw.heatingReq,
      avShw: raw.avShw ?? raw.availableShowers,
      mode: raw.mode,
    };
  }

  async setTemperature(
    plantId: string,
    variant: string,
    oldTemp: number,
    newTemp: number,
  ): Promise<boolean> {
    await this.login();
    const url = `velis/${variant}/${encodeURIComponent(plantId)}/temperature`;
    const body = { eco: false, old: oldTemp, new: newTemp };

    const res = await this.http.post(url, body);
    return res.status >= 200 && res.status < 300;
  }

  async setPower(
    plantId: string,
    variant: string,
    on: boolean,
  ): Promise<boolean> {
    await this.login();
    const url = `velis/${variant}/${encodeURIComponent(plantId)}/switch`;

    const res = await this.http.post(url, on);
    return res.status >= 200 && res.status < 300;
  }
}
