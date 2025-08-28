const fs = require('fs');
const path = require('path');

class VariantStorage {
  constructor(baseDir, log = console) {
    this.log = log;
    this.baseDir = baseDir || process.cwd();
    this.file = path.join(this.baseDir, 'ariston-cache.json');
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
    } catch {}
    this.cache = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const txt = fs.readFileSync(this.file, 'utf8');
        return JSON.parse(txt);
      }
    } catch (e) {
      this.log?.warn?.('Failed to load cache:', e.message || e);
    }
    return { variants: {} };
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch (e) {
      this.log?.warn?.('Failed to save cache:', e.message || e);
    }
  }

  getVariant(plantId) {
    return this.cache?.variants?.[plantId] || null;
  }

  setVariant(plantId, variant) {
    if (!this.cache.variants) this.cache.variants = {};
    this.cache.variants[plantId] = { variant, updatedAt: new Date().toISOString() };
    this._save();
  }
}

module.exports = { VariantStorage };
