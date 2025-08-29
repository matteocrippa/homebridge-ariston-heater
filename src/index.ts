import type { API } from 'homebridge';
// Use require to avoid TS complaining about local module declarations during development
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AristonHeaterAccessory } = require('./accessory');

export = (api: API) => {
  api.registerAccessory('homebridge-ariston-heater', 'AristonHeater', AristonHeaterAccessory as any);
};
