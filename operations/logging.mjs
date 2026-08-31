import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

export const LOG_CATEGORIES = Object.freeze(['daily', 'browser', 'errors', 'health']);

export class LocalOperationalLogger {
  constructor({ root = 'logs', clock = () => new Date(), categories = LOG_CATEGORIES } = {}) { this.root = path.resolve(root); this.clock = clock; this.categories = [...categories]; }
  initialize() {
    for (const category of this.categories) mkdirSync(path.join(this.root, category), { recursive: true, mode: 0o700 });
    return this.root;
  }
  write(category, event, payload = {}) {
    if (!this.categories.includes(category)) throw new TypeError(`unknown log category: ${category}`);
    this.initialize();
    const at = this.clock().toISOString();
    const file = path.join(this.root, category, `${at.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ at, event, ...payload })}\n`, { encoding: 'utf8', mode: 0o600 });
    return file;
  }
}
