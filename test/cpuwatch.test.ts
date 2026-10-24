import { describe, expect, it } from 'vitest';
import { CpuWatch, loadCpuWatchConfig, parseProcStat } from '../src/cpuwatch.ts';

// user nice system idle iowait irq softirq steal: busy = user + nice + system + irq + softirq.
const stat = (busy: number, idle: number, steal: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 ${steal} 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\n`;

/** A watch fed by a list of /proc/stat readings, one a minute. */
function watch(readings: string[], config = { busyLimit: 0.45, stealLimit: 0.2, windowMinutes: 60 }) {
  let i = 0;
  let now = 0;
  const w = new CpuWatch(config, () => readings[i]!, () => now);
  const next = () => {
    w.sample();
    i++;
    now += 60_000;
  };
  return { w, next };
}

describe('CPU watch', () => {
  it('reads busy, steal and total ticks from the first line', () => {
    expect(parseProcStat('cpu  10 1 5 100 2 1 3 7 0 0\n')).toEqual({ busy: 20, steal: 7, total: 129 });
    expect(() => parseProcStat('nonsense')).toThrow();
  });

  it('stays ok until a full window is in, then goes by the averages', () => {
    // Every minute: 50 busy, 50 idle ticks: 50% busy, over the 45% limit.
    const readings = Array.from({ length: 62 }, (_, m) => stat(50 * m, 50 * m, 0));
    const { w, next } = watch(readings);
    expect(w.status()).toEqual({ ok: true, busy: null, steal: null, minutes: 0 });
    for (let m = 0; m < 30; m++) next();
    expect(w.status()).toMatchObject({ ok: true, busy: 0.5, minutes: 29 });
    for (let m = 30; m < 62; m++) next();
    expect(w.status()).toEqual({ ok: false, busy: 0.5, steal: 0, minutes: 60 });
  });

  it('alerts on steal, and recovers once the window is quiet', () => {
    // An hour held back by the provider (30% steal), then an hour at 20% busy and no steal.
    const readings: string[] = [];
    let busy = 0;
    let idle = 0;
    let steal = 0;
    for (let m = 0; m < 122; m++) {
      readings.push(stat(busy, idle, steal));
      if (m < 61) {
        busy += 30;
        idle += 40;
        steal += 30;
      } else {
        busy += 20;
        idle += 80;
      }
    }
    const { w, next } = watch(readings);
    for (let m = 0; m < 61; m++) next();
    expect(w.status()).toMatchObject({ ok: false, steal: 0.3 });
    for (let m = 61; m < 122; m++) next();
    expect(w.status()).toEqual({ ok: true, busy: 0.2, steal: 0, minutes: 60 });
  });

  it('skips a reading it cannot parse', () => {
    const { w, next } = watch([stat(0, 0, 0), 'garbage', stat(10, 90, 0)]);
    next();
    next();
    next();
    expect(w.status()).toMatchObject({ busy: 0.1, minutes: 2 });
  });

  it('is on by default, off with CPU_WATCH=off, and checks its limits', () => {
    expect(loadCpuWatchConfig({})).toEqual({ busyLimit: 0.45, stealLimit: 0.2, windowMinutes: 60 });
    expect(loadCpuWatchConfig({ CPU_WATCH: 'off' })).toBeUndefined();
    expect(loadCpuWatchConfig({ CPU_WATCH_BUSY: '0.5', CPU_WATCH_STEAL: '0.1', CPU_WATCH_MINUTES: '30' })).toEqual({ busyLimit: 0.5, stealLimit: 0.1, windowMinutes: 30 });
    expect(() => loadCpuWatchConfig({ CPU_WATCH_BUSY: '45' })).toThrow(/between 0 and 1/);
    expect(() => loadCpuWatchConfig({ CPU_WATCH_MINUTES: '2' })).toThrow(/5 or more/);
  });
});
