# Homebridge Ariston Heater

Homebridge plugin for Ariston NET Velis/Lydos water heaters. It discovers your plant, reads current/target temperature and toggles power. It auto-selects the correct Velis endpoint variant (se/med/slp/one/evo).


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
  "pollInterval": 30,
  "minTemp": 35,
  "maxTemp": 70,
      "debug": false
    }
  ]
}
```

## Features

- Auto discovery (if `gateway` not set)
- Reads current and target temperature
- Sets target temperature (35–70°C)
- Power on/off mapped to Heating/Cooling State (OFF/HEAT)
- Auto-selects best Velis variant by scoring returned payloads and ignoring zeroed responses

## Project structure

- `src/client.ts`: network client (login, discovery, read/write, variant selection)
- `src/accessory.ts`: Homebridge accessory wiring using the client
- `src/index.ts`: Homebridge registration entry
- `src/bin/test-client.ts`: standalone CLI source; published binary is `dist/bin/test-client.js`

## Notes

- Requires Ariston NET cloud account credentials (same used in the mobile app).
- For Lydos devices, `sePlantData` is typically selected; MED can return zeros which are ignored automatically.
 - If behavior seems off, delete the cache file (ariston-cache.json) from the Homebridge storage path to force a re-probe.

## License

MIT. Portions inspired by the Home Assistant Ariston integration (MIT). See LICENSE.

## Credits

Inspired by:
- [ariston-remotethermo-home-assistant-v3](https://github.com/fustom/ariston-remotethermo-home-assistant-v3)
- [homebridge-aristonnet](https://github.com/fhihung/homebridge-aristonnet)