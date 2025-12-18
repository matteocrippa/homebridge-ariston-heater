import type {
  API,
  Logger,
  PlatformConfig,
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import { AristonClient, PlantData } from './client';

export class AristonHeaterAccessory {
  private service: Service;
  private client: AristonClient;
  private plantId: string | null;
  private variant: string | null = null;
  private deviceReady = false;
  private timer?: NodeJS.Timeout;
  private pollInterval: number;
  private minTemp: number;
  private maxTemp: number;
  private debug: boolean;
  private consecutiveFailures = 0;
  private maxFailuresBeforeRediscovery = 5;

  // Cached state
  private cached = {
    currentTemp: null as number | null,
    targetTemp: null as number | null,
    power: null as boolean | null,
    antiLeg: null as boolean | null,
    heatReq: null as boolean | null,
    avShw: null as number | null,
    mode: null as number | null,
  };

  constructor(
    private log: Logger,
    config: PlatformConfig,
    private api: API,
    private accessory?: PlatformAccessory,
  ) {
    const Service = api.hap.Service;
    const Characteristic = api.hap.Characteristic;

    this.plantId = config.gateway || null;
    this.pollInterval = Math.max(300, Number(config.pollInterval) || 1800); // Min 5 min, default 30 min
    this.minTemp = Math.max(1, Number(config.minTemp ?? 40));
    this.maxTemp = Math.max(this.minTemp + 1, Number(config.maxTemp ?? 65));
    this.debug = !!config.debug;

    const cacheDir = api.user?.storagePath?.() || process.cwd();
    this.client = new AristonClient({
      username: config.username,
      password: config.password,
      log: console,
      debug: this.debug,
      cacheDir,
    });

    // Setup service
    const name = config.name || 'Ariston Heater';
    if (this.accessory) {
      this.service =
        this.accessory.getService(Service.Thermostat) ||
        this.accessory.addService(Service.Thermostat, name);
    } else {
      this.service = new Service.Thermostat(name);
    }

    // Configure characteristics
    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.cached.currentTemp ?? this.minTemp);

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(() => this.cached.targetTemp ?? this.minTemp)
      .onSet(this.setTargetTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.CurrentHeatingCoolingState.OFF,
          Characteristic.CurrentHeatingCoolingState.HEAT,
        ],
      });

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() => {
        const C = this.api.hap.Characteristic;
        return this.cached.power
          ? C.TargetHeatingCoolingState.HEAT
          : C.TargetHeatingCoolingState.OFF;
      })
      .onSet(this.setPower.bind(this));

    // Start initialization
    this.initialize();

    // Cleanup on shutdown
    this.api.on?.('shutdown', () => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  private async initialize(): Promise<void> {
    try {
      this.log.info('Initializing Ariston connection...');

      // Step 1: Login
      await this.client.login();
      this.log.info('Login successful');

      // Step 2: Get plant ID if not configured
      if (!this.plantId) {
        this.plantId = await this.client.discoverPlantId();
        if (!this.plantId) {
          throw new Error('No Ariston device found');
        }
        this.log.info(`Discovered device: ${this.plantId}`);
      }

      // Step 3: Discover variant (one-time, cached)
      this.variant = await this.client.discoverVariant(this.plantId);
      this.log.info(`Using variant: ${this.variant}`);

      // Step 4: Get initial data
      await this.refresh();

      // Step 5: Start polling
      this.deviceReady = true;
      this.timer = setInterval(() => this.refresh(), this.pollInterval * 1000);

      this.log.info('Device ready');
    } catch (e: any) {
      this.log.error('Initialization failed:', e.message);
      // Retry in 60 seconds
      setTimeout(() => this.initialize(), 60000);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.plantId || !this.variant) return;

    try {
      const data = await this.client.getPlantData(this.plantId, this.variant);

      if (data) {
        this.updateFromData(data);
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        this.log.warn(
          `Failed to get data (attempt ${this.consecutiveFailures}/${this.maxFailuresBeforeRediscovery})`,
        );

        // After too many failures, try rediscovering variant
        if (this.consecutiveFailures >= this.maxFailuresBeforeRediscovery) {
          this.log.warn('Too many failures, rediscovering variant...');
          this.client.clearVariantCache(this.plantId);
          this.variant = await this.client.discoverVariant(this.plantId);
          this.consecutiveFailures = 0;
        }
      }
    } catch (e: any) {
      this.consecutiveFailures++;
      this.log.warn(`Refresh error: ${e.message}`);

      // Backoff: wait longer after failures
      const backoffSeconds = Math.min(300, 30 * this.consecutiveFailures);
      this.log.info(`Backing off for ${backoffSeconds}s`);
      await new Promise((r) => setTimeout(r, backoffSeconds * 1000));
    }
  }

  private updateFromData(data: PlantData): void {
    const C = this.api.hap.Characteristic;

    // Update cached values
    if (typeof data.currentTemp === 'number' && data.currentTemp > 0) {
      this.cached.currentTemp = data.currentTemp;
      this.service.updateCharacteristic(C.CurrentTemperature, data.currentTemp);
    }

    if (typeof data.targetTemp === 'number' && data.targetTemp > 0) {
      this.cached.targetTemp = data.targetTemp;
      const clamped = Math.max(
        this.minTemp,
        Math.min(this.maxTemp, data.targetTemp),
      );
      this.service.updateCharacteristic(C.TargetTemperature, clamped);
    }

    if (typeof data.power === 'boolean') {
      this.cached.power = data.power;
      this.service.updateCharacteristic(
        C.TargetHeatingCoolingState,
        data.power
          ? C.TargetHeatingCoolingState.HEAT
          : C.TargetHeatingCoolingState.OFF,
      );
      this.service.updateCharacteristic(
        C.CurrentHeatingCoolingState,
        data.power
          ? C.CurrentHeatingCoolingState.HEAT
          : C.CurrentHeatingCoolingState.OFF,
      );
    }

    // Store extra data
    if (typeof data.antiLeg === 'boolean') this.cached.antiLeg = data.antiLeg;
    if (typeof data.heatReq === 'boolean') this.cached.heatReq = data.heatReq;
    if (typeof data.avShw === 'number') this.cached.avShw = data.avShw;
    if (typeof data.mode === 'number') this.cached.mode = data.mode;

    if (this.debug) {
      this.log.info(
        `Updated: temp=${this.cached.currentTemp}°C, target=${this.cached.targetTemp}°C, power=${this.cached.power}`,
      );
    }
  }

  private async setTargetTemperature(
    value: CharacteristicValue,
  ): Promise<void> {
    if (!this.deviceReady || !this.plantId || !this.variant) {
      throw new Error('Device not ready');
    }

    const newTemp = Math.round(Number(value));
    const oldTemp = this.cached.targetTemp ?? newTemp;

    this.log.info(`Setting temperature: ${oldTemp}°C → ${newTemp}°C`);

    const success = await this.client.setTemperature(
      this.plantId,
      this.variant,
      oldTemp,
      newTemp,
    );

    if (success) {
      this.cached.targetTemp = newTemp;
      // Refresh after a short delay to confirm
      setTimeout(() => this.refresh(), 5000);
    } else {
      throw new Error('Failed to set temperature');
    }
  }

  private async setPower(value: CharacteristicValue): Promise<void> {
    if (!this.deviceReady || !this.plantId || !this.variant) {
      throw new Error('Device not ready');
    }

    const C = this.api.hap.Characteristic;
    const on = Number(value) === C.TargetHeatingCoolingState.HEAT;

    this.log.info(`Setting power: ${on ? 'ON' : 'OFF'}`);

    const success = await this.client.setPower(this.plantId, this.variant, on);

    if (success) {
      this.cached.power = on;
      // Refresh after a short delay to confirm
      setTimeout(() => this.refresh(), 5000);
    } else {
      throw new Error('Failed to set power');
    }
  }
}
