export class StructuredGenerationProvider {
  constructor({ id, model }) {
    this.id = String(id || '').trim();
    this.model = String(model || '').trim();
    if (!this.id) throw new TypeError('provider id is required');
    if (!this.model) throw new TypeError('provider model is required');
  }

  async generateStructured() {
    throw new Error('generateStructured() must be implemented by the provider');
  }
}

export class OpenAIResponsesProvider extends StructuredGenerationProvider {
  constructor({
    model = process.env.CAREER_OPS_DEEP_MODEL || process.env.CAREER_OPS_MODEL,
    apiKey = process.env.OPENAI_API_KEY,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
  } = {}) {
    super({ id: 'openai-responses', model });
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async generateStructured({ instructions, input, schema, name = 'career_ops_deep_evaluation' }) {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for structured generation');
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model, instructions, input: JSON.stringify(input), store: false,
          text: { format: { type: 'json_schema', name, schema, strict: true } },
        }),
      });
    } finally { clearTimeout(timer); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`OpenAI Responses failed (${response.status}): ${body?.error?.message || 'unknown error'}`);
    const outputText = body.output_text || (body.output || []).flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('');
    if (!outputText) throw new Error('OpenAI Responses returned no structured output text');
    let data;
    try { data = JSON.parse(outputText); } catch { throw new Error('OpenAI Responses returned invalid JSON'); }
    return { data, providerId: this.id, model: body.model || this.model, responseId: body.id || null, usage: body.usage || null };
  }
}
