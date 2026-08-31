import { acquisitionFailure } from './contracts.mjs';
import { DirectPageReader, JinaPageReader } from './page-reader.mjs';
import { hashContent } from './normalize.mjs';

const FALLBACK_CODES = new Set([
  'BLOCKED', 'CAPTCHA', 'CHALLENGE', 'EMPTY_CONTENT', 'TIMEOUT', 'UPSTREAM_UNAVAILABLE',
]);

export class PublicWebReader {
  constructor({ directReader = new DirectPageReader(), jinaReader = new JinaPageReader(), enableJina = false } = {}) {
    this.id = 'public-web-fallback';
    this.version = '1';
    this.directReader = directReader;
    this.jinaReader = jinaReader;
    this.enableJina = Boolean(enableJina);
  }

  async read(url, context) {
    const direct = await this.directReader.read(url, context);
    if (direct.ok || !this.enableJina || !FALLBACK_CODES.has(direct.error?.code)) return direct;
    const fallback = await this.jinaReader.read(url, context);
    return fallback.ok
      ? { ...fallback, attempts: [...direct.attempts, ...fallback.attempts], warnings: [`direct-http failed: ${direct.error.code}`, ...fallback.warnings] }
      : acquisitionFailure(fallback.error, {
        data: fallback.data,
        attempts: [...direct.attempts, ...fallback.attempts],
        warnings: [`direct-http failed: ${direct.error.code}`, ...fallback.warnings],
      });
  }
}

export function publicWebFallbackConfig(config = {}) {
  const input = config?.acquisition?.public_web_fallback;
  if (!input || input.enabled !== true) return { enabled: false, jina: false, maxPagesPerTarget: 0 };
  const requested = Number(input.max_pages_per_target);
  return {
    enabled: true,
    jina: input.jina === true,
    maxPagesPerTarget: Number.isInteger(requested) && requested > 0 ? Math.min(requested, 5) : 1,
  };
}

export async function enrichJobFromPublicWeb(job, reader, context) {
  const result = await reader.read(job.url, context);
  const rawMetadata = {
    ...(job.rawMetadata && typeof job.rawMetadata === 'object' ? job.rawMetadata : {}),
    pageRead: {
      ok: result.ok,
      status: result.data?.status || null,
      attempts: result.attempts,
      warnings: result.warnings,
    },
  };
  if (!result.ok) return { job: { ...job, rawMetadata }, result };
  return {
    result,
    job: {
      ...job,
      description: result.data.text,
      contentHash: result.data.contentHash || hashContent(result.data.text),
      rawMetadata: {
        ...rawMetadata,
        descriptionProvenance: result.attempts.at(-1) || null,
      },
    },
  };
}
