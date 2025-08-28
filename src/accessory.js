const { AristonClient } = require('./client');

let Service, Characteristic;

class AristonHeaterAccessory {
  constructor(log, config, api) {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;

    this.log = log;
    this.api = api;
    this.name = config.name || 'Ariston Heater';
    this.gateway = config.gateway || null;
    this.pollInterval = Math.max(15, Number(config.pollInterval) || 30);
    this.debug = !!config.debug;

    const cacheDir = (api && api.user && api.user.storagePath && api.user.storagePath()) || process.cwd();
    this.client = new AristonClient({
      baseURL: config.baseURL,
      userAgent: config.userAgent,
      username: config.username,
      password: config.password,
      log,
      debug: this.debug,
      cacheDir,
    });

    this.service = new Service.Thermostat(this.name);
    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', (cb) => cb(null, Characteristic.TemperatureDisplayUnits.CELSIUS));

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 35, maxValue: 70, minStep: 1 })
      .on('get', this.getTargetTemperature.bind(this))
      .on('set', this.setTargetTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', this.getCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT] })
      .on('get', this.getTargetHeatingCoolingState.bind(this))
      .on('set', this.setTargetHeatingCoolingState.bind(this));

    this.cached = { currentTemp: null, targetTemp: null, power: null };
    this.variant = null;
    this.plantId = this.gateway;

    this.ready = this.initialize();
  }

  getServices() {
    return [this.service];
  }

  async initialize() {
    try {
      await this.client.login();
      if (!this.plantId) {
        const devices = await this.client.discoverVelis();
        const first = devices[0];
        if (!first) throw new Error('No Velis devices found');
        this.plantId = first.gw || first.gateway || first.id || first.plantId;
      }
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      this.cached.currentTemp = best.fields.currentTemp ?? null;
      this.cached.targetTemp = best.fields.targetTemp ?? null;
      this.cached.power = !!best.fields.powerState;
      this.pushState();
      this.schedule();
    } catch (e) {
      this.log('Initialize error:', e.message || e);
    }
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollInterval * 1000);
  }

  async refresh() {
    if (!this.plantId) return;
    try {
      const best = await this.client.getBestVelisPlantData(this.plantId);
      this.variant = best.kind;
      const { currentTemp, targetTemp, powerState } = best.fields;
      this.cached.currentTemp = typeof currentTemp === 'number' ? currentTemp : this.cached.currentTemp;
      this.cached.targetTemp = typeof targetTemp === 'number' ? targetTemp : this.cached.targetTemp;
      this.cached.power = typeof powerState === 'boolean' ? powerState : this.cached.power;
      this.pushState();
    } catch (e) {
      this.log('Refresh failed:', e.message || e);
    }
  }

  pushState() {
    const C = this.api.hap.Characteristic;
    if (typeof this.cached.currentTemp === 'number') this.service.updateCharacteristic(C.CurrentTemperature, this.cached.currentTemp);
    if (typeof this.cached.targetTemp === 'number') this.service.updateCharacteristic(C.TargetTemperature, this.cached.targetTemp);
    if (typeof this.cached.power === 'boolean') {
      this.service.updateCharacteristic(C.TargetHeatingCoolingState, this.cached.power ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
      this.service.updateCharacteristic(C.CurrentHeatingCoolingState, this.cached.power ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
    }
  }

  async getCurrentTemperature(cb) {
    try { await this.ready; cb(null, this.cached.currentTemp ?? 0); } catch (e) { cb(e); }
  }

  async getTargetTemperature(cb) {
    try { await this.ready; cb(null, this.cached.targetTemp ?? 0); } catch (e) { cb(e); }
  }

  async setTargetTemperature(value, cb) {
    await this.ready;
    const v = Math.max(35, Math.min(70, Math.round(value)));
    const oldV = typeof this.cached.targetTemp === 'number' ? this.cached.targetTemp : v;
    try {
      await this.client.setTemperature(this.variant, this.plantId, oldV, v, false);
      this.cached.targetTemp = v;
      cb();
      this.refresh().catch(() => {});
    } catch (e1) {
      this.log('setTargetTemperature failed, re-probing variant:', e1.message || e1);
      try {
        const best = await this.client.getBestVelisPlantData(this.plantId);
        this.variant = best.kind;
        await this.client.setTemperature(this.variant, this.plantId, oldV, v, false);
        this.cached.targetTemp = v;
        cb();
        this.refresh().catch(() => {});
      } catch (e2) {
        this.log('retry setTargetTemperature failed:', e2.message || e2);
        cb(e2);
      }
    }
  }

  async getTargetHeatingCoolingState(cb) {
    try { await this.ready; const C = this.api.hap.Characteristic; cb(null, this.cached.power ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF); } catch (e) { cb(e); }
  }

  async setTargetHeatingCoolingState(value, cb) {
    await this.ready;
    const C = this.api.hap.Characteristic;
    const on = value === C.TargetHeatingCoolingState.HEAT;
    try {
      await this.client.setPower(this.variant, this.plantId, on);
      this.cached.power = on;
      cb();
      this.refresh().catch(() => {});
    } catch (e1) {
      this.log('setTargetHeatingCoolingState failed, re-probing variant:', e1.message || e1);
      try {
        const best = await this.client.getBestVelisPlantData(this.plantId);
        this.variant = best.kind;
        await this.client.setPower(this.variant, this.plantId, on);
        this.cached.power = on;
        cb();
        this.refresh().catch(() => {});
      } catch (e2) {
        this.log('retry setTargetHeatingCoolingState failed:', e2.message || e2);
        cb(e2);
      }
    }
  }
}

module.exports = { AristonHeaterAccessory };
