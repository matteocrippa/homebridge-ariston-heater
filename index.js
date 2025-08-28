const { AristonHeaterAccessory } = require('./src/accessory');

module.exports = (api) => {
  api.registerAccessory('homebridge-ariston-heater', 'AristonHeater', AristonHeaterAccessory);
};
const axios = require('axios');

let Service, Characteristic, hap;

module.exports = (api) => {
  hap = api.hap;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('homebridge-ariston-heater', 'AristonHeater', AristonHeaterAccessory);
};

class AristonClient {
  constructor({ baseURL, userAgent, username, password, log, debug }) {
  this.baseURL = baseURL || 'https://www.ariston-net.remotethermo.com/api/v2/';
  this.userAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';
    this.username = username;
    this.password = password;
    this.log = log;
    this.debug = !!debug;

    this.http = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/json',
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    this.token = null;
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

  async getBestVelisPlantData(plantId) {
    const headers = { 'ar.authToken': this.token };
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

    const extract = (raw) => {
      const get = (o, ks) => ks.find((k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) && o[ks.find((k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null)];
      const currentTemp = get(raw, ['temp', 'wtrTemp', 'currentTemp', 'currTemp', 'tCur']);
      const targetTemp = get(raw, ['procReqTemp', 'reqTemp', 'targetTemp', 'tSet']);
      const powerState = get(raw, ['on', 'power', 'pwr']);
      return { currentTemp, targetTemp, powerState };
    };

    const candidates = [];
    for (const v of variants) {
      const url = `velis/${v}/${encodeURIComponent(plantId)}`;
      const res = await this.http.get(url, { headers });
      if (this.debug) this.log(`[GET ${url}] status=${res.status}`);
      if (res.status === 200 && res.data && Object.keys(res.data).length) {
        const fields = extract(res.data);
        const score = scoreCandidate(fields);
        candidates.push({ kind: v, data: res.data, score, fields });
      }
    }
    if (!candidates.length) throw new Error('No plant data');
    candidates.sort((a, b) => b.score - a.score || variants.indexOf(a.kind) - variants.indexOf(b.kind));
    return candidates[0];
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

class AristonHeaterAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.name = config.name || 'Ariston Heater';
    this.gateway = config.gateway || null; // optional fixed plant id
    this.pollInterval = Math.max(15, Number(config.pollInterval) || 30);
    this.debug = !!config.debug;

    this.client = new AristonClient({
      baseURL: config.baseURL,
      userAgent: config.userAgent,
      username: config.username,
      password: config.password,
      log,
      debug: this.debug,
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
    this.variant = null; // selected velis variant
    this.plantId = this.gateway; // selected gateway

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
    if (typeof this.cached.currentTemp === 'number') {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.cached.currentTemp);
    }
    if (typeof this.cached.targetTemp === 'number') {
      this.service.updateCharacteristic(Characteristic.TargetTemperature, this.cached.targetTemp);
    }
    if (typeof this.cached.power === 'boolean') {
      this.service.updateCharacteristic(
        Characteristic.TargetHeatingCoolingState,
        this.cached.power ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF,
      );
      this.service.updateCharacteristic(
        Characteristic.CurrentHeatingCoolingState,
        this.cached.power ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF,
      );
    }
  }

  // Characteristic handlers
  async getCurrentTemperature(cb) {
    try {
      await this.ready;
      cb(null, this.cached.currentTemp ?? 0);
    } catch (e) {
      cb(e);
    }
  }

  async getTargetTemperature(cb) {
    try {
      await this.ready;
      cb(null, this.cached.targetTemp ?? 0);
    } catch (e) {
      cb(e);
    }
  }

  async setTargetTemperature(value, cb) {
    try {
      await this.ready;
      const v = Math.max(35, Math.min(70, Math.round(value)));
      const oldV = typeof this.cached.targetTemp === 'number' ? this.cached.targetTemp : v;
      await this.client.setTemperature(this.variant, this.plantId, oldV, v, false);
      this.cached.targetTemp = v;
      cb();
      // refresh in background to reflect any server-side adjustments
      this.refresh().catch(() => {});
    } catch (e) {
      this.log('setTargetTemperature failed:', e.message || e);
      cb(e);
    }
  }

  async getTargetHeatingCoolingState(cb) {
    try {
      await this.ready;
      const mode = this.cached.power ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF;
      cb(null, mode);
    } catch (e) {
      cb(e);
    }
  }

  async setTargetHeatingCoolingState(value, cb) {
    try {
      await this.ready;
      const on = value === Characteristic.TargetHeatingCoolingState.HEAT;
      await this.client.setPower(this.variant, this.plantId, on);
      this.cached.power = on;
      cb();
      this.refresh().catch(() => {});
    } catch (e) {
      this.log('setTargetHeatingCoolingState failed:', e.message || e);
      cb(e);
    }
  }
}
