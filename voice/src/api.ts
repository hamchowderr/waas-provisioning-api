// The AnyPress API, as the phone receptionist sees it (src/voice.ts in the API): the store behind a called number,
// that store's phone routes, and the call log. One token, VOICE_AGENT_TOKEN, for every store.

export interface Line {
  tenantId: string;
  name: string;
  domain: string;
  /** Where urgent calls are put through to, E.164; null: take a message. */
  forwardTo: string | null;
  usedMinutes: number;
  limitMinutes: number;
  minutesLeft: number;
  /** The store's business profile (AnyPress Client's /site/business), or null when the store didn't answer. */
  business: { site?: Record<string, unknown>; about?: Record<string, string> } | null;
}

export type Outcome = 'booked' | 'message' | 'transferred' | 'answered' | 'hung_up';

export interface Call {
  caller: string | null;
  seconds: number;
  outcome: Outcome;
  urgent: boolean;
  summary: string;
}

export class VoiceApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON: keep the text.
    }
    return { status: res.status, data };
  }

  private linePath(number: string) {
    return `/voice/lines/${encodeURIComponent(number)}`;
  }

  /** The store that answers `number`, or null when no store has it. */
  async line(number: string): Promise<Line | null> {
    const res = await this.request('GET', this.linePath(number));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`The API answered ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    return res.data as Line;
  }

  /** One of the store's phone routes; the store's own status and answer, for the model to read. */
  async store(number: string, method: 'GET' | 'POST', path: string, options: { query?: Record<string, string>; body?: unknown } = {}) {
    const res = await this.request('POST', `${this.linePath(number)}/store`, { method, path, ...options });
    if (res.status !== 200) return { status: res.status, body: res.data };
    return res.data as { status: number; body: any };
  }

  async logCall(number: string, call: Call): Promise<void> {
    const res = await this.request('POST', `${this.linePath(number)}/calls`, call);
    if (res.status !== 201) throw new Error(`The call log answered ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
}
