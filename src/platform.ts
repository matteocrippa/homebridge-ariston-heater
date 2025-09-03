import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { AristonHeaterPlatformAccessory } from './platformAccessory.js';

export class AristonHeaterPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly discovered: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig & any,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Initialized platform:', this.config?.name || PLATFORM_NAME);
    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching');
      this.discoverDevices().catch((e) => this.log.error('discoverDevices failed:', e?.message || e));
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices() {
    // We expose one logical accessory (the Velis/Lydos water heater). If config.gateway is empty, auto-discover first plant.
    const name = this.config?.name || 'Ariston Heater';
    const uuidSeed = 'ariston-heater:' + (this.config?.gateway || 'auto');
    const uuid = this.api.hap.uuid.generate(uuidSeed);

    let accessory = this.accessories.get(uuid);
    const ctx = accessory?.context || {};
    const mergedCtx = { ...ctx, device: { name, gateway: this.config?.gateway ?? null } };

    if (accessory) {
      this.log.info('Restoring existing accessory from cache:', accessory.displayName);
      accessory.context = mergedCtx;
      this.api.updatePlatformAccessories([accessory]);
      new AristonHeaterPlatformAccessory(this, accessory, this.config);
    } else {
      this.log.info('Adding new accessory:', name);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context = mergedCtx;
      new AristonHeaterPlatformAccessory(this, accessory, this.config);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.discovered.push(uuid);

    // Clean up any cached accessories that we didn't re-discover
    for (const [cachedUUID, acc] of this.accessories) {
      if (!this.discovered.includes(cachedUUID)) {
        this.log.info('Removing stale accessory from cache:', acc.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(cachedUUID);
      }
    }
  }
}
