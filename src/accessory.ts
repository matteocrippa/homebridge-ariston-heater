import type { API, Logger, PlatformConfig, PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { AristonClient } from './client';

export class AristonHeaterAccessory {
  private service: Service;
  private eveCharacteristics: boolean;
  private eveAntiLeg?: any;
  private eveHeatReq?: any;
  private eveShowers?: any;
  private eveMode?: any;
  private eveModeName?: any;
  private eveModeRange?: any;
  private deviceReady = false;
  private cached = {
    currentTemp: null as number | null,
    targetTemp: null as number | null,
    power: null as boolean | null,
    antiLeg: null as boolean | null,
    heatReq: null as boolean | null,
    avShw: null as number | null,
    mode: null as number | null,
  };
  private variant: string | null = null;
  private plantId: string | null;
  private timer?: NodeJS.Timeout;
  private pollInterval: number;
  private refreshOnGet: boolean;
  private refreshOnGetCooldown: number;
  private lastRefreshAt = 0;
  private refreshing: Promise<void> | null = null;
  private debug: boolean;
  private client: AristonClient;
  private name: string;
  private minTemp: number;
  private maxTemp: number;

  constructor(
    private log: Logger, 
    config: PlatformConfig & any, 
    private api: API,
    private accessory?: PlatformAccessory,
  ) {
    const ServiceCtor = api.hap.Service;
    const CharacteristicCtor = api.hap.Characteristic;

    this.name = config.name || 'Ariston Heater';
    this.plantId = (config.gateway as string) || null;
    // Enforce a 30-minute minimum poll interval; earlier updates only via on-demand refresh
    this.pollInterval = Math.max(1800, Number(config.pollInterval) || 1800);
    this.debug = !!config.debug;
    this.minTemp = Math.max(1, Number(config.minTemp ?? 35));
    this.maxTemp = Math.max(this.minTemp + 1, Number(config.maxTemp ?? 70));
    this.eveCharacteristics = config.eveCharacteristics !== false; // default true
    this.refreshOnGet = config.refreshOnGet !== false; // default true
    this.refreshOnGetCooldown = Math.max(2, Number(config.refreshOnGetCooldownSeconds) || 10);

    const cacheDir = (api && api.user && api.user.storagePath && api.user.storagePath()) || process.cwd();
    this.client = new AristonClient({
      baseURL: config.baseURL,
      userAgent: config.userAgent,
      username: config.username,
      password: config.password,
      log: (console as any) as Console,
      debug: this.debug,
      cacheDir,
    });

    // Use existing service from cached accessory or create new one
    if (this.accessory) {
      this.service = this.accessory.getService(ServiceCtor.Thermostat) 
        || this.accessory.addService(ServiceCtor.Thermostat, this.name);
    } else {
      this.service = new ServiceCtor.Thermostat(this.name);
    }
    this.service
      .getCharacteristic(CharacteristicCtor.TemperatureDisplayUnits)
      .onGet(async () => CharacteristicCtor.TemperatureDisplayUnits.CELSIUS);

    this.service
      .getCharacteristic(CharacteristicCtor.TargetTemperature)
  .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(this.onGetTargetTemperature.bind(this))
      .onSet(this.onSetTargetTemperature.bind(this));

    this.service
      .getCharacteristic(CharacteristicCtor.CurrentTemperature)
      .onGet(this.onGetCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(CharacteristicCtor.CurrentHeatingCoolingState)
      .setProps({ validValues: [CharacteristicCtor.CurrentHeatingCoolingState.OFF, CharacteristicCtor.CurrentHeatingCoolingState.HEAT] });

    this.service
      .getCharacteristic(CharacteristicCtor.TargetHeatingCoolingState)
      .setProps({ validValues: [CharacteristicCtor.TargetHeatingCoolingState.OFF, CharacteristicCtor.TargetHeatingCoolingState.HEAT] })
      .onGet(this.onGetTargetHeatingCoolingState.bind(this))
      .onSet(this.onSetTargetHeatingCoolingState.bind(this));

    // Eve-only custom characteristics (not visible in Apple Home)
    if (this.eveCharacteristics) {
  const H = this.api.hap;
  const makeUUID = (suffix: string) => `0D5B${suffix}-A1F7-4C2E-8E0B-2B7E5B2A9A10`;

      class EveAntiLegCharacteristic extends H.Characteristic {
        static readonly UUID = makeUUID('0001');
        constructor() {
          super('Anti Legionella', EveAntiLegCharacteristic.UUID, {
            format: H.Formats.BOOL,
            perms: [H.Perms.PAIRED_READ, H.Perms.NOTIFY],
          });
        }
      }

      class EveHeatReqCharacteristic extends H.Characteristic {
        static readonly UUID = makeUUID('0002');
        constructor() {
          super('Heating Active', EveHeatReqCharacteristic.UUID, {
            format: H.Formats.BOOL,
            perms: [H.Perms.PAIRED_READ, H.Perms.NOTIFY],
          });
        }
      }

    class EveShowersCharacteristic extends H.Characteristic {
        static readonly UUID = makeUUID('0003');
        constructor() {
      super('Showers', EveShowersCharacteristic.UUID, {
            format: H.Formats.UINT8,
            perms: [H.Perms.PAIRED_READ, H.Perms.NOTIFY],
            minValue: 0,
            maxValue: 4,
            minStep: 1,
          });
        }
      }

      class EveModeCharacteristic extends H.Characteristic {
        static readonly UUID = makeUUID('0004');
        constructor() {
          super('Mode', EveModeCharacteristic.UUID, {
            format: H.Formats.UINT8,
            perms: [H.Perms.PAIRED_READ, H.Perms.NOTIFY],
            minValue: 0,
            maxValue: 255,
            minStep: 1,
          });
        }
      }

      class EveModeNameCharacteristic extends H.Characteristic {
        static readonly UUID = makeUUID('0005');
        constructor() {
          super('Mode Name', EveModeNameCharacteristic.UUID, {
            format: H.Formats.STRING,
            perms: [H.Perms.PAIRED_READ, H.Perms.NOTIFY],
          });
        }
      }

      class EveModeRangeCharacteristic extends H.Characteristic {
        static readonly UUID = makeUUID('0006');
        constructor() {
          super('Mode Range', EveModeRangeCharacteristic.UUID, {
            format: H.Formats.STRING,
            perms: [H.Perms.PAIRED_READ, H.Perms.NOTIFY],
          });
        }
      }

      try {
        this.eveAntiLeg = this.service.getCharacteristic(EveAntiLegCharacteristic);
      } catch {
        try {
          this.eveAntiLeg = this.service.addOptionalCharacteristic(EveAntiLegCharacteristic);
        } catch {
          this.eveAntiLeg = this.service.addCharacteristic(EveAntiLegCharacteristic);
        }
      }
      if (this.eveAntiLeg) {
        this.eveAntiLeg.onGet(async () => !!this.cached.antiLeg);
      }

      try {
        this.eveHeatReq = this.service.getCharacteristic(EveHeatReqCharacteristic);
      } catch {
        try {
          this.eveHeatReq = this.service.addOptionalCharacteristic(EveHeatReqCharacteristic);
        } catch {
          this.eveHeatReq = this.service.addCharacteristic(EveHeatReqCharacteristic);
        }
      }
      if (this.eveHeatReq) {
        this.eveHeatReq.onGet(async () => !!this.cached.heatReq);
      }

      try {
        this.eveShowers = this.service.getCharacteristic(EveShowersCharacteristic);
      } catch {
        try {
          this.eveShowers = this.service.addOptionalCharacteristic(EveShowersCharacteristic);
        } catch {
          this.eveShowers = this.service.addCharacteristic(EveShowersCharacteristic);
        }
      }
      if (this.eveShowers) {
        this.eveShowers.onGet(async () => this.getShowersCount());
      }

      try {
        this.eveMode = this.service.getCharacteristic(EveModeCharacteristic);
      } catch {
        try {
          this.eveMode = this.service.addOptionalCharacteristic(EveModeCharacteristic);
        } catch {
          this.eveMode = this.service.addCharacteristic(EveModeCharacteristic);
        }
      }
      if (this.eveMode) {
        this.eveMode.onGet(async () => this.cached.mode ?? 0);
      }

      try {
        this.eveModeName = this.service.getCharacteristic(EveModeNameCharacteristic);
      } catch {
        try {
          this.eveModeName = this.service.addOptionalCharacteristic(EveModeNameCharacteristic);
        } catch {
          this.eveModeName = this.service.addCharacteristic(EveModeNameCharacteristic);
        }
      }
      if (this.eveModeName) {
        this.eveModeName.onGet(async () => this.getModeName(this.cached.mode));
      }

      try {
        this.eveModeRange = this.service.getCharacteristic(EveModeRangeCharacteristic);
      } catch {
        try {
          this.eveModeRange = this.service.addOptionalCharacteristic(EveModeRangeCharacteristic);
        } catch {
          this.eveModeRange = this.service.addCharacteristic(EveModeRangeCharacteristic);
        }
      }
      if (this.eveModeRange) {
        this.eveModeRange.onGet(async () => {
          const range = this.getModeTemperatureRange(this.cached.mode);
          return `${range.min}-${range.max}°C`;
        });
      }
    }

    this.initialize();

    // Cleanup on Homebridge shutdown
    try {
      this.api.on('shutdown', () => {
        if (this.timer) clearInterval(this.timer);
      });
    } catch {}
  }

  /**
   * Validates if a temperature reading is reasonable.
   * Returns the value if valid, null if it's a placeholder/error value.
   * Placeholder values are typically 0, negative, or far outside device range.
   */
  private validateTemp(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    // Reasonable range for a water heater: 0-65°C
    // Values like 33 without context or 0 are often placeholder/error values
    if (value < 0 || value > 65) return null;
    // If we see a value that's way outside configured range AND it's exactly 33 or 0,
    // it's likely a placeholder being sent by the API in certain states
    if ((value === 0 || value === 33) && (value < this.minTemp - 5 || value > this.maxTemp + 5)) {
      return null;
    }
    return value;
  }

  private async initialize() {
    try {
      // Retry login with exponential backoff
      let loginAttempt = 0;
      const maxLoginAttempts = 3;
      while (loginAttempt < maxLoginAttempts) {
        try {
          await this.client.login();
          break;
        } catch (e: any) {
          loginAttempt++;
          if (loginAttempt >= maxLoginAttempts) throw e;
          const backoffMs = Math.min(1000 * Math.pow(2, loginAttempt - 1), 10000);
          this.log.warn(`Login attempt ${loginAttempt} failed, retrying in ${Math.round(backoffMs / 1000)}s:`, e?.message || e);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
      if (!this.plantId) {
        const devices = await this.client.discoverVelis();
        const first = devices[0];
        if (!first) throw new Error('No Velis devices found');
        this.plantId = (first.gw || first.gateway || first.id || first.plantId) as string;
      }
      const best = await this.client.getBestVelisPlantData(this.plantId as string);
      this.variant = best.kind;
      
      // Validate and cache temperature readings
      const currentTemp = this.validateTemp(best.fields.currentTemp as number);
      const targetTemp = this.validateTemp(best.fields.targetTemp as number);
      this.cached.currentTemp = currentTemp;
      this.cached.targetTemp = targetTemp;
      this.cached.power = (best.fields.powerState as boolean) ?? null;
      this.cached.antiLeg = (best.fields.antiLeg as boolean) ?? null;
      this.cached.heatReq = (best.fields.heatReq as boolean) ?? null;
      this.cached.avShw = (best.fields.avShw as number) ?? null;
      this.cached.mode = (best.fields.mode as number) ?? null;
      
      // Log if we detected placeholder/error values
      if (best.fields.currentTemp !== undefined && best.fields.currentTemp !== null && currentTemp === null) {
        this.log.debug(`Current temperature ${best.fields.currentTemp}°C discarded as placeholder value`);
      }
      if (best.fields.targetTemp !== undefined && best.fields.targetTemp !== null && targetTemp === null) {
        this.log.debug(`Target temperature ${best.fields.targetTemp}°C discarded as placeholder value`);
      }
      
      // Log mode if available
      if (this.cached.mode !== null) {
        const modeName = this.getModeName(this.cached.mode);
        const modeRange = this.getModeTemperatureRange(this.cached.mode);
        this.log.info(`Device mode: ${modeName} (${this.cached.mode}), temp range: ${modeRange.min}-${modeRange.max}°C`);
      }
      
      this.pushState();
      this.schedule();
      this.deviceReady = true;
      this.log.info('Device initialized successfully');
    } catch (e: any) {
      this.deviceReady = false;
      this.log.error('Initialize error:', e?.message || e);
    }
  }

  private schedule() {
    if (this.timer) clearInterval(this.timer);
    setTimeout(() => this.refresh().catch(() => {}), 2000);
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollInterval * 1000);
  }

  private async refresh() {
    if (!this.plantId) return;
    try {
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      const { currentTemp, targetTemp, powerState, antiLeg, heatReq, avShw, mode } = best.fields as any;
      
      // Validate temperatures before updating cache
      const validCurrent = this.validateTemp(currentTemp);
      const validTarget = this.validateTemp(targetTemp);
      
      if (validCurrent !== null) {
        this.cached.currentTemp = validCurrent;
      }
      if (validTarget !== null) {
        this.cached.targetTemp = validTarget;
      }
      this.cached.power = typeof powerState === 'boolean' ? powerState : this.cached.power;
      this.cached.antiLeg = typeof antiLeg === 'boolean' ? antiLeg : this.cached.antiLeg;
      this.cached.heatReq = typeof heatReq === 'boolean' ? heatReq : this.cached.heatReq;
      this.cached.avShw = typeof avShw === 'number' ? avShw : this.cached.avShw;
      
      // Detect mode change
      const oldMode = this.cached.mode;
      const newMode = typeof mode === 'number' ? mode : this.cached.mode;
      if (oldMode !== newMode && newMode !== null) {
        const oldModeName = this.getModeName(oldMode);
        const newModeName = this.getModeName(newMode);
        const newModeRange = this.getModeTemperatureRange(newMode);
        this.log.info(`Mode changed: ${oldModeName} (${oldMode}) → ${newModeName} (${newMode}), temp range: ${newModeRange.min}-${newModeRange.max}°C`);
      }
      this.cached.mode = newMode;
      
      this.pushState();
      this.lastRefreshAt = Date.now();
    } catch (e: any) {
  const msg = e?.message || String(e);
  const isRate = e?.name === 'RateLimitError';
  const delay = isRate && typeof e?.retryAfter === 'number' ? Math.max(1000, e.retryAfter * 1000) : 500;
  this.log.warn(isRate ? 'Rate limited, backing off:' : 'Refresh failed:', msg, isRate ? `(retry in ${Math.round(delay / 1000)}s)` : '');
      try {
        await new Promise((r) => setTimeout(r, delay));
      } catch {}
    }
  }

  private triggerRefresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        await this.refresh();
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private maybeRefreshOnDemand() {
    if (!this.refreshOnGet) return;
    const now = Date.now();
    if (now - this.lastRefreshAt >= this.refreshOnGetCooldown * 1000) {
      this.triggerRefresh();
    }
  }

  private pushState() {
    const C = this.api.hap.Characteristic;
    // Clamp temperatures to valid range before updating HomeKit
    if (typeof this.cached.currentTemp === 'number') {
      const clampedCurrent = Math.max(this.minTemp, Math.min(this.maxTemp, this.cached.currentTemp));
      this.service.updateCharacteristic(C.CurrentTemperature, clampedCurrent);
    }
    if (typeof this.cached.targetTemp === 'number') {
      const clampedTarget = Math.max(this.minTemp, Math.min(this.maxTemp, this.cached.targetTemp));
      this.service.updateCharacteristic(C.TargetTemperature, clampedTarget);
    }
    if (typeof this.cached.power === 'boolean') {
      this.service.updateCharacteristic(C.TargetHeatingCoolingState, this.cached.power ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
      this.service.updateCharacteristic(C.CurrentHeatingCoolingState, this.cached.power ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
    }

    // Update Eve custom characteristics
    try {
      if (this.eveAntiLeg && typeof this.cached.antiLeg === 'boolean') {
        this.eveAntiLeg.updateValue(!!this.cached.antiLeg);
      }
    } catch {}
    try {
      if (this.eveHeatReq && typeof this.cached.heatReq === 'boolean') {
        this.eveHeatReq.updateValue(!!this.cached.heatReq);
      }
    } catch {}
    try {
      if (this.eveShowers) {
        this.eveShowers.updateValue(this.getShowersCount());
      }
    } catch {}
    try {
      if (this.eveMode && typeof this.cached.mode === 'number') {
        this.eveMode.updateValue(this.cached.mode);
      }
    } catch {}
    try {
      if (this.eveModeName) {
        this.eveModeName.updateValue(this.getModeName(this.cached.mode));
      }
    } catch {}
    try {
      if (this.eveModeRange) {
        const range = this.getModeTemperatureRange(this.cached.mode);
        this.eveModeRange.updateValue(`${range.min}-${range.max}°C`);
      }
    } catch {}
  }

  private getShowersCount(): number {
    const n = typeof this.cached.avShw === 'number' ? Math.round(this.cached.avShw) : 0;
    return Math.max(0, Math.min(4, n));
  }

  private getModeName(mode: number | null): string {
    if (mode === null || mode === undefined) return 'Unknown';
    const modeNames: Record<number, string> = {
      1: 'iMemory',
      2: 'Green',
      7: 'Boost',
    };
    return modeNames[mode] || `Mode ${mode}`;
  }

  private getModeTemperatureRange(mode: number | null): { min: number; max: number } {
    if (mode === null || mode === undefined) {
      return { min: this.minTemp, max: this.maxTemp };
    }
    
    // Mode-specific temperature ranges (from Ariston app behavior)
    const ranges: Record<number, { min: number; max: number }> = {
      1: { min: 40, max: 65 },     // iMemory
      2: { min: 40, max: 53 },     // Green
      7: { min: 40, max: 65 },     // Boost
    };
    
    const modeRange = ranges[mode];
    if (modeRange) {
      return modeRange;
    }
    
    // Fallback to configured range
    return { min: this.minTemp, max: this.maxTemp };
  }

  private async onGetCurrentTemperature(): Promise<number> {
  this.maybeRefreshOnDemand();
    return this.cached.currentTemp ?? this.minTemp;
  }

  private async onGetTargetTemperature(): Promise<number> {
  this.maybeRefreshOnDemand();
    return this.cached.targetTemp ?? this.minTemp;
  }

  private async onSetTargetTemperature(value: CharacteristicValue): Promise<void> {
    if (!this.deviceReady) throw new Error('Device not ready yet. Try again in a moment.');
    if (!this.plantId || !this.variant) throw new Error('Device not ready');
    const vNum = typeof value === 'number' ? value : Number(value as any);
    const v = Math.max(this.minTemp, Math.min(this.maxTemp, Math.round(vNum)));
    const oldV = typeof this.cached.targetTemp === 'number' ? this.cached.targetTemp : v;
    try {
      await this.client.setTemperature(this.variant, this.plantId, oldV, v, false);
      this.cached.targetTemp = v;
      this.refresh().catch(() => {});
    } catch (e1: any) {
      this.log.warn('setTargetTemperature failed, re-probing variant:', e1?.message || e1);
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      await this.client.setTemperature(this.variant, this.plantId, oldV, v, false);
      this.cached.targetTemp = v;
      this.refresh().catch(() => {});
    }
  }

  private async onGetTargetHeatingCoolingState(): Promise<number> {
    const C = this.api.hap.Characteristic;
  this.maybeRefreshOnDemand();
    return this.cached.power ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF;
  }

  private async onSetTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    if (!this.deviceReady) throw new Error('Device not ready yet. Try again in a moment.');
    if (!this.plantId || !this.variant) throw new Error('Device not ready');
    const C = this.api.hap.Characteristic;
    const num = typeof value === 'number' ? value : Number(value as any);
    const on = num === C.TargetHeatingCoolingState.HEAT;
    try {
      await this.client.setPower(this.variant, this.plantId, on);
      this.cached.power = on;
      this.refresh().catch(() => {});
    } catch (e1: any) {
      this.log.warn('setTargetHeatingCoolingState failed, re-probing variant:', e1?.message || e1);
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      await this.client.setPower(this.variant, this.plantId, on);
      this.cached.power = on;
      this.refresh().catch(() => {});
    }
  }
}
