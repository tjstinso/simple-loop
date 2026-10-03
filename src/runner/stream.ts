/** One event of `claude -p --output-format stream-json` (one JSON object per line). */
export interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Parses one stdout line. Returns null for anything that is not a JSON object
 * with a string `type` (blank lines, log noise, truncated JSON).
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (typeof (value as { type?: unknown }).type !== 'string') return null;
  return value as StreamEvent;
}

/**
 * Splits a byte stream into lines across chunk boundaries. `push` returns the
 * complete lines in the chunk; `end` returns the trailing partial line, if any.
 * Decoding is UTF-8 aware, so multi-byte characters split across chunks survive.
 */
export class LineSplitter {
  private buf = '';
  private readonly decoder = new TextDecoder('utf-8');

  push(chunk: Buffer | string): string[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines;
  }

  end(): string | null {
    this.buf += this.decoder.decode();
    const rest = this.buf;
    this.buf = '';
    return rest.length > 0 ? rest : null;
  }
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

function contentBlocks(ev: StreamEvent): ContentBlock[] {
  const message = ev.message as { content?: unknown } | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content.filter((b) => typeof b === 'object' && b !== null) as ContentBlock[]) : [];
}

const STEP_MAX = 200;

/** Folds stream events into the facts the runner reports. */
export class StreamCollector {
  readonly steps: string[] = [];
  /** Text of the most recent assistant message that contained text. */
  lastAssistantText: string | null = null;
  result: StreamEvent | null = null;

  add(ev: StreamEvent): void {
    if (ev.type === 'assistant') {
      const texts: string[] = [];
      for (const block of contentBlocks(ev)) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          let detail = '';
          if (block.input !== undefined) {
            try {
              detail = ' ' + JSON.stringify(block.input);
            } catch {
              detail = '';
            }
          }
          this.steps.push(truncate(block.name + detail, STEP_MAX));
        } else if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) this.lastAssistantText = texts.join('\n');
    } else if (ev.type === 'result') {
      this.result = ev;
    }
  }

  /** Final assistant text: the result event's `result`, else the last assistant text. */
  finalText(): string | null {
    const r = this.result?.result;
    if (typeof r === 'string') return r;
    return this.lastAssistantText;
  }

  costUsd(): number | undefined {
    const r = this.result;
    if (!r) return undefined;
    const c = r.total_cost_usd ?? r.cost_usd;
    return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
  }

  /** True when the stream ended in a successful result event. */
  succeeded(): boolean {
    const r = this.result;
    return r !== null && r.is_error !== true && (r.subtype === undefined || r.subtype === 'success');
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export type JsonBlock = { ok: true; value: unknown } | { ok: false; reason: string };

/** Parses the LAST fenced ```json block of `text`. */
export function lastJsonBlock(text: string | null): JsonBlock {
  if (text === null) return { ok: false, reason: 'no final assistant message' };
  const re = /```json[ \t]*\r?\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1]!;
  if (last === null) return { ok: false, reason: 'no ```json block in the final assistant message' };
  try {
    return { ok: true, value: JSON.parse(last) };
  } catch (e) {
    return { ok: false, reason: `unparseable \`\`\`json block: ${(e as Error).message}` };
  }
}
