# Homebridge Ariston Heater

[![npm version](https://img.shields.io/npm/v/homebridge-ariston-heater.svg?logo=npm)](https://www.npmjs.com/package/homebridge-ariston-heater)
[![license: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![homebridge](https://img.shields.io/badge/homebridge-1.8%2B-blue.svg)](https://github.com/homebridge/homebridge)

Homebridge plugin for Ariston NET Velis/Lydos water heaters. It discovers your plant, reads current/target temperature, toggles power, and auto-selects the correct Velis endpoint variant (se/med/slp/one/evo).


## Installation

1. From this repo root, `cd homebridge-ariston-heater` and install dependencies.
2. Publish or use locally via `npm link`.
3. Optional: test the network client without Homebridge using `.env` and the CLI:

```
# .env
ARISTON_USER=you@example.com
ARISTON_PASS=yourpassword
# optional

ariston-test-client
```

## Configuration (config.json)

Add an accessory like:

```
{
  "accessories": [
    {
      "accessory": "AristonHeater",
      "name": "Water Heater",
      "username": "<ariston email>",
      "password": "<ariston password>",
      "pollInterval": 1800,
      "minTemp": 35,
      "maxTemp": 70,
      "eveCharacteristics": true,
      "refreshOnGet": true,
      "refreshOnGetCooldownSeconds": 10,
          "debug": false
    }
  ]
}
```

## Features

- Auto discovery (if `gateway` not set)
- Reads current and target temperature
- Sets target temperature (default 35–70°C; configurable)
- Power on/off mapped to Heating/Cooling State (OFF/HEAT)
- Auto-selects best Velis variant by scoring returned payloads and ignoring zeroed responses
- Eve-only extra fields (visible in Eve app, hidden from Apple Home):
  - Anti Legionella (boolean)
  - Heating Request (boolean)
  - Showers (0–4)
- Gentle cloud polling (default every 30 minutes) with on-demand refresh when opening the accessory tile

## Project structure

- `src/client.ts`: network client (login, discovery, read/write, variant selection)
- `src/accessory.ts`: Homebridge accessory wiring using the client
- `src/index.ts`: Homebridge registration entry
- `src/bin/test-client.ts`: standalone CLI source; published binary is `dist/bin/test-client.js`

## Notes

- Requires Ariston NET cloud account credentials (same as the mobile app).
- For many Lydos/Velis devices, `sePlantData` is commonly selected; other variants are tried as needed.
- If behavior seems off, delete the cache file (`ariston-cache.json`) from the Homebridge storage path to force re-detection of the variant.
- Rate limiting: the plugin gracefully backs off on HTTP 429 responses using Retry-After headers. Consider increasing `pollInterval` if you encounter frequent 429s.

### Options

- `gateway` (string): Plant ID (gateway). Leave empty to auto-discover.
- `pollInterval` (number): Refresh cadence in seconds. Default 1800 (30 minutes). Minimum 15.
- `minTemp`/`maxTemp` (number): Allowed range for target temperature.
- `eveCharacteristics` (boolean): Expose Eve-only extra fields on the Thermostat service. Default true.
- `refreshOnGet` (boolean): Trigger a background refresh when the accessory is viewed/read. Default true.
- `refreshOnGetCooldownSeconds` (number): Minimum seconds between on-demand refreshes. Default 10.
- `debug` (boolean): Verbose logging.

## License

MIT. Portions inspired by the Home Assistant Ariston integration (MIT). See LICENSE.

## Credits

Inspired by:
- [ariston-remotethermo-home-assistant-v3](https://github.com/fustom/ariston-remotethermo-home-assistant-v3)
- [homebridge-aristonnet](https://github.com/fhihung/homebridge-aristonnet)