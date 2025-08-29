import type { API, Logging, PlatformConfig, Service, CharacteristicValue } from 'homebridge';
import { AristonClient } from './client';

export class AristonHeaterAccessory {
  private service: Service;
  private cached = { currentTemp: null as number | null, targetTemp: null as number | null, power: null as boolean | null };
  private variant: string | null = null;
  private plantId: string | null;
  private timer?: NodeJS.Timeout;
  private pollInterval: number;
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
    this.pollInterval = Math.max(15, Number(config.pollInterval) || 30);
  this.debug = !!config.debug;
  this.minTemp = Math.max(1, Number(config.minTemp ?? 35));
  this.maxTemp = Math.max(this.minTemp + 1, Number(config.maxTemp ?? 70));

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

    this.initialize();
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
      this.pushState();
      this.schedule();
    } catch (e: any) {
      this.log('Initialize error:', e?.message || e);
    }
  }

  private schedule() {
  if (this.timer) clearInterval(this.timer);
  // Slightly delay first refresh to stagger multiple accessories
  setTimeout(() => this.refresh().catch(() => {}), 2000);
  this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollInterval * 1000);
  }

  private async refresh() {
    if (!this.plantId) return;
    try {
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      const { currentTemp, targetTemp, powerState } = best.fields as any;
      this.cached.currentTemp = typeof currentTemp === 'number' ? currentTemp : this.cached.currentTemp;
      this.cached.targetTemp = typeof targetTemp === 'number' ? targetTemp : this.cached.targetTemp;
      this.cached.power = typeof powerState === 'boolean' ? powerState : this.cached.power;
      this.pushState();
    } catch (e: any) {
      this.log('Refresh failed:', e?.message || e);
      // Optional: backoff a bit to avoid hammering if errors persist
      try {
        await new Promise((r) => setTimeout(r, 500));
      } catch {}
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
  }

  private async onGetCurrentTemperature(): Promise<number> {
    return this.cached.currentTemp ?? 0;
  }

  private async onGetTargetTemperature(): Promise<number> {
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
