import type { API } from 'homebridge';
import { AristonHeaterAccessory } from './accessory';

export = (api: API) => {
  api.registerAccessory('homebridge-ariston-heater', 'AristonHeater', AristonHeaterAccessory);
};
