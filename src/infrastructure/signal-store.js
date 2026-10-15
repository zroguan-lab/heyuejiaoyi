import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export class SignalStore {
  constructor(filePath, { maxMemoryItems = 500 } = {}) {
    this.filePath = filePath;
    this.maxMemoryItems = maxMemoryItems;
    this.items = [];
    this.ids = new Set();
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((item) => item?.id);
      this.items = parsed.slice(-this.maxMemoryItems);
      this.ids = new Set(this.items.map((item) => item.id));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async append(signal) {
    if (signal.status !== "SIGNAL" || this.ids.has(signal.id)) return false;
    await appendFile(this.filePath, `${JSON.stringify(signal)}\n`, "utf8");
    this.items.push(signal);
    this.ids.add(signal.id);
    if (this.items.length > this.maxMemoryItems) {
      const removed = this.items.splice(0, this.items.length - this.maxMemoryItems);
      for (const item of removed) this.ids.delete(item.id);
    }
    return true;
  }

  list(limit = 100) {
    return this.items.slice(-Math.min(Math.max(1, limit), this.maxMemoryItems)).reverse();
  }
}
