import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { AristonHeaterAccessory } from './accessory';

const PLATFORM_NAME = 'AristonHeater';
const PLUGIN_NAME = 'homebridge-ariston-heater';

class AristonHeaterPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    // Create a single accessory based on config
    const uuid = this.api.hap.uuid.generate('ariston-heater-' + (this.config.gateway || this.config.username));
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new AristonHeaterAccessory(this.log, this.config, this.api, existingAccessory);
    } else {
      this.log.info('Adding new accessory:', this.config.name || 'Ariston Heater');
      const accessory = new this.api.platformAccessory(this.config.name || 'Ariston Heater', uuid);
      new AristonHeaterAccessory(this.log, this.config, this.api, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}

export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AristonHeaterPlatform);
};
