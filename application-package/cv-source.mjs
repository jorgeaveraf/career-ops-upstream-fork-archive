import { hashStable } from '../acquisition/normalize.mjs';

export function canonicalCvMetadata(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new TypeError('canonical CV is required');
  const lines = text.split('\n');
  const name = lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim() || '';
  const titleIndex = lines.findIndex(line => /^##\s+/.test(line));
  const title = titleIndex >= 0 ? lines[titleIndex].replace(/^##\s+/, '').trim() : '';
  const summary = titleIndex >= 0
    ? lines.slice(titleIndex + 1).find(line => line.trim() && !line.startsWith('#'))?.trim() || ''
    : '';
  return { hash: hashStable(text), name, title, summary, source: 'cv.md' };
}

