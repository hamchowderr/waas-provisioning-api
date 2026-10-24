import { readFileSync } from 'node:fs';

/**
 * Watches the whole server's CPU from /proc/stat, which in a container without lxcfs is the host's, for /health
 * (`cpu.ok`) and an outside keyword monitor. On 2026-10-23 the server ran above its provider's CPU baseline for
 * about 19 hours, used up its CPU credits and was held to 30% of its cores for over a day before anyone noticed;
 * this says so within the hour. `busy` is the share of all cores in use (user, nice, system, irq, softirq), `steal`
 * the share the hypervisor kept from us, which jumps when the provider holds the server back.
 */

export interface CpuWatchConfig {
  /** Over this share of all cores, on average over the window, `ok` turns false. Default 0.45 (Hostinger's baseline is 0.6). */
  busyLimit: number;
  /** Over this share of steal, on average over the window, `ok` turns false. Default 0.2. */
  stealLimit: number;
  /** Minutes averaged; `ok` stays true until a full window is in. Default 60. */
  windowMinutes: number;
}

export interface CpuStatus {
  ok: boolean;
  /** Averages over the last `minutes` minutes, 0 to 1; null until the first two samples. */
  busy: number | null;
  steal: number | null;
  minutes: number;
}

interface Sample {
  at: number;
  busy: number;
  steal: number;
  total: number;
}

/** The first line of /proc/stat as cumulative busy, steal and total ticks. */
export function parseProcStat(text: string): Omit<Sample, 'at'> {
  const fields = /^cpu\s+(.*)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number);
  if (!fields || fields.length < 8 || fields.some((n) => !Number.isFinite(n))) throw new Error('Unreadable /proc/stat');
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields as [number, number, number, number, number, number, number, number];
  const busy = user + nice + system + irq + softirq;
  return { busy, steal, total: busy + idle + iowait + steal };
}

export const DEFAULT_CPU_WATCH: CpuWatchConfig = { busyLimit: 0.45, stealLimit: 0.2, windowMinutes: 60 };

export class CpuWatch {
  private samples: Sample[] = [];

  constructor(
    private readonly config: CpuWatchConfig = DEFAULT_CPU_WATCH,
    private readonly read: () => string = () => readFileSync('/proc/stat', 'utf8'),
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one sample; keeps a window's worth plus one. A read error is skipped. */
  sample() {
    try {
      this.samples.push({ at: this.now(), ...parseProcStat(this.read()) });
    } catch {
      return;
    }
    const since = this.now() - this.config.windowMinutes * 60_000;
    while (this.samples.length > 2 && this.samples[1]!.at <= since) this.samples.shift();
  }

  status(): CpuStatus {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last === first || last.total <= first.total) return { ok: true, busy: null, steal: null, minutes: 0 };
    const total = last.total - first.total;
    const busy = (last.busy - first.busy) / total;
    const steal = (last.steal - first.steal) / total;
    const minutes = Math.round((last.at - first.at) / 60_000);
    const full = minutes >= this.config.windowMinutes - 1;
    const ok = !full || (busy <= this.config.busyLimit && steal <= this.config.stealLimit);
    return { ok, busy: round(busy), steal: round(steal), minutes };
  }

  /** Samples every minute until stopped. */
  start(): () => void {
    this.sample();
    const timer = setInterval(() => this.sample(), 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** CPU_WATCH=off turns it off; CPU_WATCH_BUSY, CPU_WATCH_STEAL (0 to 1) and CPU_WATCH_MINUTES change the limits. */
export function loadCpuWatchConfig(env: Record<string, string | undefined>): CpuWatchConfig | undefined {
  if (env.CPU_WATCH === 'off') return undefined;
  const share = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!(n > 0 && n <= 1)) throw new Error(`${name} must be a share between 0 and 1, like 0.45`);
    return n;
  };
  const minutes = env.CPU_WATCH_MINUTES ? Number(env.CPU_WATCH_MINUTES) : DEFAULT_CPU_WATCH.windowMinutes;
  if (!Number.isInteger(minutes) || minutes < 5) throw new Error('CPU_WATCH_MINUTES must be a whole number of minutes, 5 or more');
  return { busyLimit: share('CPU_WATCH_BUSY', DEFAULT_CPU_WATCH.busyLimit), stealLimit: share('CPU_WATCH_STEAL', DEFAULT_CPU_WATCH.stealLimit), windowMinutes: minutes };
}
