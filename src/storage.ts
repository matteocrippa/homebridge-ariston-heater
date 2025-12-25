import { promises as fsp } from 'fs';
import path from 'path';

export interface VariantEntry {
  variant: string;
  updatedAt: string;
}

interface CacheShape {
  variants: Record<string, VariantEntry>;
}

export interface SmallLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  log?: (...args: any[]) => void;
}

/**
 * Async VariantStorage
 *
 * Usage:
 *   const store = new VariantStorage(baseDir, logger);
 *   await store.init(); // must be called before using get/set
 *
 * This class uses fs.promises for non-blocking I/O and writes atomically
 * (write tmp file + rename) to reduce risk of corrupted cache files.
 */
export class VariantStorage {
  private file: string;
  private cache: CacheShape = { variants: {} };
  private log: Required<SmallLogger>;

  constructor(baseDir?: string, log?: SmallLogger) {
    const noop: Required<SmallLogger> = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      log: () => {},
    };
    this.log = (log as any) || noop;
    const dir = baseDir || process.cwd();
    this.file = path.join(dir, 'ariston-heater-cache.json');
  }

  // Prepare storage (create dir, load existing cache)
  async init(): Promise<void> {
    const dir = path.dirname(this.file);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e: any) {
      // non-fatal, proceed to load (may fail downstream)
      this.log.warn('Failed to ensure cache directory:', e?.message || e);
    }
    this.cache = await this.load();
  }

  private async load(): Promise<CacheShape> {
    try {
      // check existence
      await fsp.access(this.file).catch(() => {
        // file not present
        return;
      });
      const txt = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(txt);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.variants &&
        typeof parsed.variants === 'object'
      ) {
        return parsed as CacheShape;
      } else {
        this.log.warn('Cache file malformed; ignoring');
      }
    } catch (e: any) {
      // If file doesn't exist, or parse error, return empty cache
      this.log.warn('Failed to load cache:', e?.message || e);
    }
    return { variants: {} };
  }

  private async save(): Promise<void> {
    try {
      const tmp = this.file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
      try {
        // atomic replace where possible
        await fsp.rename(tmp, this.file);
      } catch {
        // fallback: overwrite
        await fsp.writeFile(
          this.file,
          JSON.stringify(this.cache, null, 2),
          'utf8',
        );
      }
    } catch (e: any) {
      this.log.warn('Failed to save cache:', e?.message || e);
    }
  }

  // Synchronous read from in-memory cache (init must have been called)
  getVariant(plantId: string): VariantEntry | null {
    return (
      (this.cache && this.cache.variants && this.cache.variants[plantId]) ||
      null
    );
  }

  // Async setter that persists to disk
  async setVariant(plantId: string, variant: string): Promise<void> {
    if (!this.cache.variants) this.cache.variants = {};
    this.cache.variants[plantId] = {
      variant,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }
}
