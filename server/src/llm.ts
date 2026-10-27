// OpenAI-compatible chat client for the hackathon LLM gateway (API_URL, MODEL, BEARER from ../.env).
// The model is a reasoning model. With thinking on, the gateway returns it in a separate
// `reasoning` field and `content` holds only the answer; with thinking off, the reasoning leaks
// into `content` (see answerText). The token budget must cover both.

export const llmConfig = {
  url: process.env.API_URL ?? "",
  model: process.env.MODEL ?? "",
  configured: !!(process.env.API_URL && process.env.MODEL && process.env.BEARER),
};

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmError extends Error {}

export async function complete(messages: LlmMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}) {
  if (!llmConfig.configured) throw new LlmError("LLM not configured (API_URL, MODEL, BEARER in .env)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(llmConfig.url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BEARER}` },
      body: JSON.stringify({
        model: llmConfig.model,
        messages,
        max_tokens: opts.maxTokens ?? 3000,
        temperature: opts.temperature ?? 0.3,
      }),
    });
    if (!res.ok) throw new LlmError(`LLM gateway returned ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null; reasoning?: string; reasoning_content?: string } }[]; model?: string };
    const msg = json.choices?.[0]?.message;
    let content = (msg?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!content) throw new LlmError("LLM returned no answer (token budget used up by reasoning)");
    return { content, model: json.model ?? llmConfig.model };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError((e as Error).name === "AbortError" ? "LLM timed out" : `LLM request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Tool calling (OpenAI-compatible function calling) ----------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolRound {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  finishReason?: string;
}

/**
 * One model round with tools. With `onDelta`, the request streams and the visible answer text is
 * passed on as it arrives. The answer is what stands inside <answer>…</answer> (the system prompt
 * asks for it): with reasoning off, GLM writes its reasoning into the content first.
 */
export async function completeWithTools(
  messages: AgentMessage[],
  tools: ToolSpec[],
  opts: { maxTokens?: number; timeoutMs?: number; thinking?: boolean; onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<ToolRound> {
  if (!llmConfig.configured) throw new LlmError("LLM not configured (API_URL, MODEL, BEARER in .env)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);
  const stream = !!opts.onDelta;
  try {
    const res = await fetch(llmConfig.url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BEARER}` },
      body: JSON.stringify({
        model: llmConfig.model,
        messages,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
        max_tokens: opts.maxTokens ?? 6000,
        temperature: 0.2,
        stream,
        // vLLM chat templates (GLM, Qwen) skip the reasoning phase with this; other servers ignore it.
        ...(opts.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // The gateway answers some errors with an HTML page; keep only JSON detail.
      const detail = body.trimStart().startsWith("{") ? `: ${body.slice(0, 200)}` : "";
      throw new LlmError(`LLM gateway returned ${res.status}${detail}`);
    }
    if (!stream || !res.body) {
      const json = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[]; model?: string };
      const msg = json.choices?.[0]?.message;
      return { content: answerText(msg?.content ?? ""), toolCalls: msg?.tool_calls ?? [], model: json.model ?? llmConfig.model, finishReason: json.choices?.[0]?.finish_reason };
    }

    // Streaming: accumulate content and tool-call deltas (by index), pass visible answer text on.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let raw = "";
    let shown = 0;
    let model = llmConfig.model;
    let finishReason: string | undefined;
    const calls: ToolCall[] = [];
    const visible = () => {
      const v = visibleAnswer(raw, opts.thinking !== false);
      if (v.length > shown) {
        opts.onDelta!(v.slice(shown));
        shown = v.length;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: { model?: string; choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.model) model = j.model;
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        for (const d of ch.delta?.tool_calls ?? []) {
          const c = (calls[d.index] ??= { id: d.id ?? `call_${d.index}_${Date.now()}`, type: "function", function: { name: "", arguments: "" } });
          if (d.id) c.id = d.id;
          if (d.function?.name) c.function.name += d.function.name;
          if (d.function?.arguments) c.function.arguments += d.function.arguments;
        }
        if (ch.delta?.content) {
          raw += ch.delta.content;
          // Once a round calls tools its text is not an answer: stop showing it.
          if (!calls.length) visible();
        }
      }
    }
    return { content: answerText(raw), toolCalls: calls.filter(Boolean), model, finishReason };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (opts.signal?.aborted) throw new LlmError("Stopped");
    throw new LlmError((e as Error).name === "AbortError" ? "LLM timed out" : `LLM request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Removes reasoning from the content: whole <think> blocks (an unclosed one when cut off by
 * max_tokens), and everything before a lone </think>, which GLM writes when reasoning is switched
 * off but it reasons anyway.
 */
function dropReasoning(content: string) {
  const c = content.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  const close = c.lastIndexOf("</think>");
  return close >= 0 ? c.slice(close + 8) : c;
}

/**
 * The final answer: inside <answer> if present; without reasoning mode, text before it is reasoning.
 * The last filled <answer> wins, since GLM sometimes names the tag in its notes first.
 */
function answerText(content: string) {
  const c = dropReasoning(content);
  if (!c.includes("<answer>")) return c.trim();
  const parts = c.split("<answer>").slice(1).map((p) => p.split("</answer>")[0].trim()).filter(Boolean);
  return parts.at(-1) ?? "";
}

/** The part of a streaming answer that can be shown already. */
function visibleAnswer(raw: string, thinking: boolean) {
  const c = dropReasoning(raw);
  const at = c.lastIndexOf("<answer>");
  if (at >= 0) {
    const rest = c.slice(at + 8);
    const end = rest.indexOf("</answer>");
    return stripPartialTag(end >= 0 ? rest.slice(0, end) : rest).replace(/^\s+/, "");
  }
  // Without reasoning mode the text before <answer> is reasoning: show nothing yet.
  if (!thinking) return "";
  return stripPartialTag(c).replace(/^\s+/, "");
}

/** Holds back a tag that is still arriving ("<ans"), so it never flashes on screen. */
const stripPartialTag = (s: string) => s.replace(/<\/?[a-z]*$/i, "");

/** Extracts the first JSON object from a model answer (tolerates ```json fences). */
export function parseJsonObject<T>(text: string): T | null {
  const clean = text.replace(/```(?:json)?/g, "");
  // Try every "{" from the last one backwards, so stray braces earlier in the text don't break parsing.
  for (let i = clean.lastIndexOf("{"); i >= 0; i = clean.lastIndexOf("{", i - 1)) {
    const end = clean.lastIndexOf("}");
    if (end <= i) continue;
    try {
      return JSON.parse(clean.slice(i, end + 1)) as T;
    } catch {
      // keep looking
    }
  }
  return null;
}
