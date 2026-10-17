/**
 * Minimal in-process metrics registry rendered in the Prometheus text format.
 * Counters are monotonic; gauges are sampled through callbacks at render time.
 */
export class Metrics {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.help = new Map();
  }

  counter(name, help) {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    this.help.set(name, help);
  }

  /** @param {string} name @param {Record<string,string>} [labels] @param {number} [by] */
  inc(name, labels = {}, by = 1) {
    let series = this.counters.get(name);
    if (!series) {
      series = new Map();
      this.counters.set(name, series);
    }
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + by);
  }

  get(name, labels = {}) {
    return this.counters.get(name)?.get(labelKey(labels)) ?? 0;
  }

  /** @param {string} name @param {string} help @param {() => number | Array<[Record<string,string>, number]>} sample */
  gauge(name, help, sample) {
    this.gauges.set(name, sample);
    this.help.set(name, help);
  }

  render() {
    const lines = [];
    for (const [name, series] of this.counters) {
      if (this.help.has(name)) lines.push(`# HELP ${name} ${this.help.get(name)}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of series) lines.push(`${name}${key} ${value}`);
    }
    for (const [name, sample] of this.gauges) {
      lines.push(`# HELP ${name} ${this.help.get(name)}`);
      lines.push(`# TYPE ${name} gauge`);
      const value = sample();
      if (Array.isArray(value)) for (const [labels, v] of value) lines.push(`${name}${labelKey(labels)} ${v}`);
      else lines.push(`${name} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}

function labelKey(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',')}}`;
}
