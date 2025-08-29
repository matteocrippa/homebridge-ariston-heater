import fs from 'fs';
import path from 'path';

export interface VariantEntry {
  variant: string;
  updatedAt: string;
}

interface CacheShape {
  variants: Record<string, VariantEntry>;
}

export class VariantStorage {
  private file: string;
  private cache: CacheShape;
  private log: { warn?: (...args: any[]) => void } | Console;

  constructor(baseDir?: string, log: { warn?: (...args: any[]) => void } | Console = console) {
    this.log = log;
    const dir = baseDir || process.cwd();
    this.file = path.join(dir, 'ariston-cache.json');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    this.cache = this.load();
  }

  private load(): CacheShape {
    try {
      if (fs.existsSync(this.file)) {
        const txt = fs.readFileSync(this.file, 'utf8');
        return JSON.parse(txt) as CacheShape;
      }
    } catch (e: any) {
      this.log?.warn?.('Failed to load cache:', e?.message || e);
    }
    return { variants: {} };
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch (e: any) {
      this.log?.warn?.('Failed to save cache:', e?.message || e);
    }
  }

  getVariant(plantId: string): VariantEntry | null {
    return (this.cache?.variants && this.cache.variants[plantId]) || null;
  }

  setVariant(plantId: string, variant: string) {
    if (!this.cache.variants) this.cache.variants = {} as any;
    this.cache.variants[plantId] = { variant, updatedAt: new Date().toISOString() };
    this.save();
  }
}
