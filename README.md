# Homebridge Ariston Heater

[![npm version](https://img.shields.io/npm/v/homebridge-ariston-heater.svg?logo=npm)](https://www.npmjs.com/package/homebridge-ariston-heater)
[![license: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![homebridge](https://img.shields.io/badge/homebridge-1.8%2B-blue.svg)](https://github.com/homebridge/homebridge)

Homebridge plugin for Ariston NET Velis/Lydos water heaters. It discovers your plant, reads current/target temperature, toggles power, and auto-selects the correct Velis endpoint variant (se/med/slp/one/evo).

## Prerequisites

- **Node.js 18.0.0 or higher**
- **Homebridge 1.8.0 or higher** (or 2.0.0-beta.0+)
- Active Ariston NET cloud account with email and password

## Installation

1. Install via Homebridge UI or npm:
   ```bash
   npm install -g homebridge-ariston-heater
   ```

2. Configure the plugin (see Configuration below)

3. Restart Homebridge

### Test Client (Optional)

You can test your credentials without Homebridge:

```bash
# Copy .env.example to .env and fill in your credentials
cp .env.example .env

# Run the test client
ariston-test-client
```

## Configuration

Add this to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AristonHeater",
      "name": "Ariston Heater",
      "username": "your.email@example.com",
      "password": "your_password",
      "gateway": "",
      "pollInterval": 1800,
      "minTemp": 40,
      "maxTemp": 65,
      "debug": false
    }
  ]
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `username` | string | **required** | Your Ariston NET email |
| `password` | string | **required** | Your Ariston NET password |
| `gateway` | string | auto-discover | Plant/Gateway ID. Leave empty to auto-discover |
| `pollInterval` | number | 1800 | Refresh interval in seconds (min: 300, default: 1800) |
| `minTemp` | number | 40 | Minimum temperature (°C) exposed to HomeKit |
| `maxTemp` | number | 65 | Maximum temperature (°C) exposed to HomeKit |
| `debug` | boolean | false | Enable verbose logging |

### Migration from v0.2.x

v0.3.0 removes some configuration options that are no longer needed:

- ❌ `eveCharacteristics` - Removed (Eve characteristics no longer supported)
- ❌ `refreshOnGet` - Removed (no longer triggers API calls on read)
- ❌ `refreshOnGetCooldownSeconds` - Removed

Simply remove these options from your config if present.

### Migration from v0.1.x

Move configuration from `accessories` to `platforms` array:

```json
{
  "platforms": [
    {
      "platform": "AristonHeater",
      ...
    }
  ]
}
```

## Features

- **Auto discovery** - Finds your device automatically if `gateway` not set
- **Temperature reading** - Current and target temperature
- **Temperature control** - Set target temperature (40–65°C default)
- **Power control** - On/off mapped to Heating State (OFF/HEAT)
- **Smart variant detection** - Auto-selects best Velis API variant
- **Rate limit protection** - Progressive backoff prevents API throttling
- **Reliable caching** - Continues working during API outages

## How It Works

1. **Startup**: Logs in → Discovers device → Detects API variant (cached)
2. **Running**: Single API call every 30 minutes (configurable)
3. **On failure**: Backs off progressively, retries with increasing delays
4. **Variant re-discovery**: Only after 5 consecutive failures

This design minimizes API calls to prevent rate limiting issues.

## Troubleshooting

### "No plant data" or rate limiting errors

1. Delete the cache file to force re-discovery:
   ```bash
   rm ~/.homebridge/ariston-cache.json
   ```

2. Restart Homebridge

3. If issues persist, increase `pollInterval` to 3600 (1 hour)

### Device not found

1. Verify your credentials work in the official Ariston NET app
2. Check that your device is online in the app
3. Enable `debug: true` to see detailed logs

### Wrong temperatures

The plugin reads `reqTemp` (user-set temperature) for target and `temp` for current. If values seem wrong, the API variant may have changed. Delete the cache file and restart.

## Project Structure

- `src/client.ts` - API client (login, discovery, read/write)
- `src/accessory.ts` - Homebridge accessory implementation
- `src/storage.ts` - Variant cache storage
- `src/index.ts` - Homebridge platform registration
- `src/bin/test-client.ts` - Standalone CLI for testing

## License

MIT. See [LICENSE](LICENSE).

## Credits

Inspired by:
- [ariston-remotethermo-home-assistant-v3](https://github.com/fustom/ariston-remotethermo-home-assistant-v3)
- [homebridge-aristonnet](https://github.com/fhihung/homebridge-aristonnet)