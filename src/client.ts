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
  private log: Console;
  private debug: boolean;
  private username?: string;
  private password?: string;

  constructor(opts: AristonClientOpts = {}) {
    const baseURL =
      opts.baseURL || 'https://www.ariston-net.remotethermo.com/api/v2/';
    const userAgent =
      opts.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';

    this.username = opts.username || process.env.ARISTON_USER;
    this.password = opts.password || process.env.ARISTON_PASS;
    this.log = opts.log || console;
    this.debug = opts.debug || false;
    this.storage = new VariantStorage(opts.cacheDir, this.log);

    if (!this.username || !this.password) {
      throw new Error('Ariston credentials required');
    }

    this.http = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'User-Agent': userAgent, 'Content-Type': 'application/json' },
      validateStatus: () => true, // Handle all status codes manually
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async login(): Promise<void> {
    const res = await this.http.post('accounts/login', {
      usr: this.username,
      pwd: this.password,
      imp: false,
      notTrack: true,
      appInfo: {
        os: 2,
        appVer: '5.6.7772.40151',
        appId: 'com.remotethermo.aristonnet',
      },
    });

    if (res.status !== 200 || !res.data?.token) {
      throw new Error(`Login failed (${res.status})`);
    }

    this.token = res.data.token;
    if (this.debug) this.log.log('Login successful');
  }

  async discoverPlantId(): Promise<string | null> {
    if (!this.token) throw new Error('Not logged in');

    const headers = { 'ar.authToken': this.token };

    for (const path of ['velis/medPlants', 'velis/plants']) {
      const res = await this.http.get(path, { headers });
      if (
        res.status === 200 &&
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
    // Check cache first
    const cached = this.storage.getVariant(plantId)?.variant;
    if (cached) {
      if (this.debug) this.log.log(`Using cached variant: ${cached}`);
      return cached;
    }

    if (!this.token) throw new Error('Not logged in');

    const headers = { 'ar.authToken': this.token };
    const variants = [
      'sePlantData',
      'medPlantData',
      'slpPlantData',
      'onePlantData',
      'evoPlantData',
    ];

    this.log.info(`Discovering variant for ${plantId}...`);

    for (const variant of variants) {
      try {
        const url = `velis/${variant}/${encodeURIComponent(plantId)}`;
        const res = await this.http.get(url, { headers });

        if (this.debug) {
          this.log.log(`Trying ${variant}: status=${res.status}`);
        }

        if (res.status === 200 && res.data && typeof res.data === 'object') {
          const data = res.data;
          // Check if response has any useful data
          if (
            data.temp !== undefined ||
            data.reqTemp !== undefined ||
            data.on !== undefined
          ) {
            this.log.info(`Found working variant: ${variant}`);
            this.storage.setVariant(plantId, variant);
            return variant;
          }
        }

        // Small delay between discovery attempts to avoid rate limiting
        await this.delay(1000);
      } catch (e: any) {
        if (this.debug) this.log.log(`Variant ${variant} failed: ${e.message}`);
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
    if (!this.token) throw new Error('Not logged in');

    const headers = { 'ar.authToken': this.token };
    const url = `velis/${variant}/${encodeURIComponent(plantId)}`;

    const res = await this.http.get(url, { headers });

    // Handle auth expiry - re-login and retry once
    if (res.status === 401) {
      if (this.debug) this.log.log('Token expired, re-logging in...');
      await this.login();
      return this.getPlantData(plantId, variant);
    }

    // Rate limited
    if (res.status === 429) {
      this.log.warn('Rate limited by API');
      return null;
    }

    // Server error
    if (res.status >= 500) {
      if (this.debug) this.log.log(`Server error: ${res.status}`);
      return null;
    }

    // Success but empty data
    if (res.status === 200 && (!res.data || typeof res.data !== 'object')) {
      return null;
    }

    if (res.status !== 200) {
      return null;
    }

    // Extract fields from response
    const raw = res.data;
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
    if (!this.token) throw new Error('Not logged in');

    const headers = { 'ar.authToken': this.token };
    const url = `velis/${variant}/${encodeURIComponent(plantId)}/temperature`;
    const body = { eco: false, old: oldTemp, new: newTemp };

    const res = await this.http.post(url, body, { headers });

    if (res.status === 401) {
      await this.login();
      return this.setTemperature(plantId, variant, oldTemp, newTemp);
    }

    return res.status === 200;
  }

  async setPower(
    plantId: string,
    variant: string,
    on: boolean,
  ): Promise<boolean> {
    if (!this.token) throw new Error('Not logged in');

    const headers = { 'ar.authToken': this.token };
    const url = `velis/${variant}/${encodeURIComponent(plantId)}/switch`;

    const res = await this.http.post(url, on, { headers });

    if (res.status === 401) {
      await this.login();
      return this.setPower(plantId, variant, on);
    }

    return res.status === 200;
  }

  clearVariantCache(plantId: string): void {
    this.storage.clearVariant(plantId);
  }
}
