// Ollama client. Two rules govern GPU use:
//   1. During a batch the model is held warm (keep_alive "5m") so we pay the ~3s load once.
//   2. The batch ALWAYS ends with an explicit unload, even on error, so VRAM returns to zero.

const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["business_spam", "phishing", "legitimate"] },
    evidence: { type: "array", items: { type: "string" }, maxItems: 4 },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["category", "evidence", "confidence", "reason"],
};

export class Ollama {
  constructor(endpoint, model) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  // Cheap liveness probe. Returns null when the daemon is not reachable, so callers
  // can quietly defer work instead of erroring.
  async health(timeoutMs = 2500) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(`${this.endpoint}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const j = await r.json();
      const names = (j.models || []).map((m) => m.name);
      return { ok: true, models: names, hasModel: names.includes(this.model) };
    } catch {
      return null;
    }
  }

  // Which models currently occupy VRAM.
  async loaded() {
    try {
      const r = await fetch(`${this.endpoint}/api/ps`);
      const j = await r.json();
      return (j.models || []).map((m) => ({ name: m.name, vram: m.size_vram }));
    } catch {
      return [];
    }
  }

  async classify(systemPrompt, emailText, { keepAlive = "5m", timeoutMs = 45000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: this.model,
          keep_alive: keepAlive,
          stream: false,
          think: false,
          format: SCHEMA,
          options: {
            temperature: 0,
            // A verdict is a short JSON object. Without a hard cap, a message that
            // trips the model into looping generates until it exhausts the context
            // window, forces a context shift and returns HTTP 500 after ~30s.
            num_predict: 320,
            // Headroom so a long message plus the few-shot block never crowds the
            // window, which is what makes runaway generation likely in the first place.
            num_ctx: 8192,
          },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Classify this email.\n\n" + emailText },
          ],
        }),
      });
      if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
      const j = await r.json();
      const out = JSON.parse(j.message.content);
      // The model reports poorly-calibrated confidence (it clusters near 0.95 regardless
      // of difficulty), so callers must not treat this as a real probability.
      out.confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
      if (!Array.isArray(out.evidence)) out.evidence = [];
      return out;
    } finally {
      clearTimeout(t);
    }
  }

  // Free the GPU. Safe to call when nothing is loaded.
  async unload() {
    try {
      await fetch(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, keep_alive: 0, messages: [] }),
      });
      return true;
    } catch {
      return false;
    }
  }
}
