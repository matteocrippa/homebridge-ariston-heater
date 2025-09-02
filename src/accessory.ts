import type { API, Logging, PlatformConfig, Service, CharacteristicValue } from 'homebridge';
import { AristonClient } from './client';

export class AristonHeaterAccessory {
  private service: Service;
  private eveCharacteristics: boolean;
  private eveAntiLeg?: any;
  private eveHeatReq?: any;
  private eveShowers?: any;
  private cached = {
    currentTemp: null as number | null,
    targetTemp: null as number | null,
    power: null as boolean | null,
    antiLeg: null as boolean | null,
    heatReq: null as boolean | null,
    avShw: null as number | null,
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

  constructor(private log: Logging, config: PlatformConfig & any, private api: API) {
    const ServiceCtor = api.hap.Service;
    const CharacteristicCtor = api.hap.Characteristic;

    this.name = config.name || 'Ariston Heater';
    this.plantId = (config.gateway as string) || null;
  this.pollInterval = Math.max(15, Number(config.pollInterval) || 1800);
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

  this.service = new ServiceCtor.Thermostat(this.name);
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

      try {
        this.eveAntiLeg = this.service.getCharacteristic(EveAntiLegCharacteristic);
      } catch {
        try {
          this.eveAntiLeg = this.service.addCharacteristic(EveAntiLegCharacteristic);
        } catch {}
      }
      if (this.eveAntiLeg) this.eveAntiLeg.onGet(async () => !!this.cached.antiLeg);

      try {
        this.eveHeatReq = this.service.getCharacteristic(EveHeatReqCharacteristic);
      } catch {
        try {
          this.eveHeatReq = this.service.addCharacteristic(EveHeatReqCharacteristic);
        } catch {}
      }
      if (this.eveHeatReq) this.eveHeatReq.onGet(async () => !!this.cached.heatReq);

      try {
        this.eveShowers = this.service.getCharacteristic(EveShowersCharacteristic);
      } catch {
        try {
          this.eveShowers = this.service.addCharacteristic(EveShowersCharacteristic);
        } catch {}
      }
      if (this.eveShowers) this.eveShowers.onGet(async () => this.getShowersCount());
    }

    this.initialize();

    // Cleanup on Homebridge shutdown
    try {
      this.api.on('shutdown', () => {
        if (this.timer) clearInterval(this.timer);
      });
    } catch {}
  }

  getServices(): Service[] {
    return [this.service];
  }

  private async initialize() {
    try {
      await this.client.login();
      if (!this.plantId) {
        const devices = await this.client.discoverVelis();
        const first = devices[0];
        if (!first) throw new Error('No Velis devices found');
        this.plantId = (first.gw || first.gateway || first.id || first.plantId) as string;
      }
      const best = await this.client.getBestVelisPlantData(this.plantId as string);
      this.variant = best.kind;
      this.cached.currentTemp = (best.fields.currentTemp as number) ?? null;
      this.cached.targetTemp = (best.fields.targetTemp as number) ?? null;
      this.cached.power = (best.fields.powerState as boolean) ?? null;
      this.cached.antiLeg = (best.fields.antiLeg as boolean) ?? null;
      this.cached.heatReq = (best.fields.heatReq as boolean) ?? null;
      this.cached.avShw = (best.fields.avShw as number) ?? null;
      this.pushState();
      this.schedule();
    } catch (e: any) {
      this.log('Initialize error:', e?.message || e);
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
      const { currentTemp, targetTemp, powerState, antiLeg, heatReq, avShw } = best.fields as any;
      this.cached.currentTemp = typeof currentTemp === 'number' ? currentTemp : this.cached.currentTemp;
      this.cached.targetTemp = typeof targetTemp === 'number' ? targetTemp : this.cached.targetTemp;
      this.cached.power = typeof powerState === 'boolean' ? powerState : this.cached.power;
      this.cached.antiLeg = typeof antiLeg === 'boolean' ? antiLeg : this.cached.antiLeg;
      this.cached.heatReq = typeof heatReq === 'boolean' ? heatReq : this.cached.heatReq;
      this.cached.avShw = typeof avShw === 'number' ? avShw : this.cached.avShw;
      this.pushState();
      this.lastRefreshAt = Date.now();
    } catch (e: any) {
  const msg = e?.message || String(e);
  const isRate = e?.name === 'RateLimitError';
  const delay = isRate && typeof e?.retryAfter === 'number' ? Math.max(1000, e.retryAfter * 1000) : 500;
  this.log(isRate ? 'Rate limited, backing off:' : 'Refresh failed:', msg, isRate ? `(retry in ${Math.round(delay / 1000)}s)` : '');
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
    if (typeof this.cached.currentTemp === 'number') this.service.updateCharacteristic(C.CurrentTemperature, this.cached.currentTemp);
    if (typeof this.cached.targetTemp === 'number') this.service.updateCharacteristic(C.TargetTemperature, this.cached.targetTemp);
    if (typeof this.cached.power === 'boolean') {
      this.service.updateCharacteristic(C.TargetHeatingCoolingState, this.cached.power ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
      this.service.updateCharacteristic(C.CurrentHeatingCoolingState, this.cached.power ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
    }

    // Update Eve custom characteristics
    try {
      if (this.eveAntiLeg && typeof this.cached.antiLeg === 'boolean') this.eveAntiLeg.updateValue(!!this.cached.antiLeg);
    } catch {}
    try {
      if (this.eveHeatReq && typeof this.cached.heatReq === 'boolean') this.eveHeatReq.updateValue(!!this.cached.heatReq);
    } catch {}
    try {
      if (this.eveShowers) this.eveShowers.updateValue(this.getShowersCount());
    } catch {}
  }

  private getShowersCount(): number {
    const n = typeof this.cached.avShw === 'number' ? Math.round(this.cached.avShw) : 0;
    return Math.max(0, Math.min(4, n));
  }

  private async onGetCurrentTemperature(): Promise<number> {
  this.maybeRefreshOnDemand();
    return this.cached.currentTemp ?? 0;
  }

  private async onGetTargetTemperature(): Promise<number> {
  this.maybeRefreshOnDemand();
    return this.cached.targetTemp ?? 0;
  }

  private async onSetTargetTemperature(value: CharacteristicValue): Promise<void> {
    if (!this.plantId || !this.variant) throw new Error('Device not ready');
    const vNum = typeof value === 'number' ? value : Number(value as any);
  const v = Math.max(this.minTemp, Math.min(this.maxTemp, Math.round(vNum)));
    const oldV = typeof this.cached.targetTemp === 'number' ? this.cached.targetTemp : v;
    try {
      await this.client.setTemperature(this.variant, this.plantId, oldV as number, v, false);
      this.cached.targetTemp = v;
      this.refresh().catch(() => {});
    } catch (e1: any) {
      this.log('setTargetTemperature failed, re-probing variant:', e1?.message || e1);
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      await this.client.setTemperature(this.variant, this.plantId, oldV as number, v, false);
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
    if (!this.plantId || !this.variant) throw new Error('Device not ready');
    const C = this.api.hap.Characteristic;
    const num = typeof value === 'number' ? value : Number(value as any);
    const on = num === C.TargetHeatingCoolingState.HEAT;
    try {
      await this.client.setPower(this.variant, this.plantId, on);
      this.cached.power = on;
      this.refresh().catch(() => {});
    } catch (e1: any) {
      this.log('setTargetHeatingCoolingState failed, re-probing variant:', e1?.message || e1);
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      await this.client.setPower(this.variant, this.plantId, on);
      this.cached.power = on;
      this.refresh().catch(() => {});
    }
  }
}
