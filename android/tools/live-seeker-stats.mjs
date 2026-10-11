// SurfaceFlinger text schema only. No shell commands or app identifiers are retained here.
export const BUCKETS = Object.freeze([...Array.from({ length: 35 }, (_, i) => i),
  36, 38, 40, 42, 44, 46, 48, 50, 54, 58, 62, 66, 70, 74, 78, 82, 86, 90, 94, 98,
  102, 106, 110, 114, 118, 122, 126, 130, 134, 138, 142, 146, 150, 200, 250, 300,
  350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000]);
export function requireStat(condition, code) { if (!condition) throw new Error(code); }
function integer(text, field) {
  const values = [...text.matchAll(new RegExp(`^\\s*${field}\\s*=\\s*(\\d+)\\s*$`, 'gm'))];
  requireStat(values.length === 1, 'missing-or-ambiguous-counter');
  const value = Number(values[0][1]);
  requireStat(Number.isSafeInteger(value), 'invalid-counter');
  return value;
}
export function validateSelection(packageName, layer) {
  requireStat(['gg.pixelkingdomwars.twa', 'gg.pixelkingdomwars.twa.debug'].includes(packageName), 'invalid-package');
  requireStat(typeof layer === 'string' && layer.length <= 512 && !/[\r\n\0]/.test(layer)
    && (layer.includes(`[${packageName}/`) || layer.includes(`[${packageName}]`)
      || layer.startsWith(`${packageName}/`)), 'layer-package-mismatch');
}
export function parseTimeStats(text, packageName, layer) {
  validateSelection(packageName, layer);
  const headings = [...text.matchAll(/^\s*layerName\s*=\s*(.+)\r?$/gm)];
  const selected = headings.map((h, i) => ({ name: h[1].trim(),
    text: text.slice(h.index, headings[i + 1]?.index ?? text.length) })).filter(h => h.name === layer);
  requireStat(selected.length === 1, selected.length ? 'ambiguous-layer' : 'missing-layer');
  const header = text.slice(0, headings[0]?.index ?? text.length);
  const start = integer(header, 'statsStart'), end = integer(header, 'statsEnd');
  requireStat(start > 0 && end >= start, 'inactive-or-invalid-timestats');
  const block = selected[0].text;
  const packages = [...block.matchAll(/^\s*packageName\s*=\s*(.*)$/gm)];
  requireStat(packages.length <= 1 && (!packages.length || packages[0][1].trim() === packageName), 'layer-package-mismatch');
  const histograms = [...block.matchAll(/^(?:presentToPresent|present2present) histogram is as below:\s*\n([^\n]+)/gm)];
  requireStat(histograms.length === 1, 'missing-or-ambiguous-histogram');
  const tokens = histograms[0][1].trim().split(/\s+/);
  requireStat(tokens.length === BUCKETS.length, 'unsupported-histogram-schema');
  const counts = tokens.map((token, i) => {
    const match = /^(\d+)ms=(\d+)$/.exec(token);
    requireStat(match && Number(match[1]) === BUCKETS[i], 'unsupported-histogram-schema');
    const count = Number(match[2]); requireStat(Number.isSafeInteger(count), 'invalid-counter'); return count;
  });
  return { start, end, frames: integer(block, 'totalFrames'), dropped: integer(block, 'droppedFrames'), counts };
}
export function intervalStats(before, after, seconds) {
  requireStat(Number.isFinite(seconds) && seconds >= 1 && seconds <= 75, 'sampling-gap');
  requireStat(after.start === before.start && after.end > before.end
    && Math.abs(after.end - before.end - seconds) <= 5, 'clock-or-counter-reset');
  const counts = after.counts.map((count, i) => count - before.counts[i]);
  const frames = after.frames - before.frames, dropped = after.dropped - before.dropped;
  requireStat(counts.length === BUCKETS.length && counts.every(n => Number.isSafeInteger(n) && n >= 0)
    && frames >= 0 && dropped >= 0, 'counter-reset');
  const samples = counts.reduce((a, b) => a + b, 0);
  requireStat(Number.isSafeInteger(samples) && samples > 0 && frames > 0, 'no-new-frames');
  requireStat(samples <= frames && frames - samples <= 1 && dropped === 0, 'incomplete-frame-coverage');
  return { seconds, frames, samples, dropped, counts, averagePresentedFps: frames / seconds,
    p95: percentileBounds(counts, 0.95, 20), p99: percentileBounds(counts, 0.99, 33) };
}
export function percentileBounds(counts, fraction, limitMs) {
  requireStat(counts.length === BUCKETS.length && counts.every(n => Number.isSafeInteger(n) && n >= 0), 'invalid-histogram');
  const total = counts.reduce((a, b) => a + b, 0);
  requireStat(total > 0 && Number.isSafeInteger(total), 'no-new-frames');
  const rank = Math.ceil(total * fraction); let accumulated = 0;
  const i = counts.findIndex(count => (accumulated += count) >= rank);
  // AOSP truncates ns to integer ms, then rounds UP to its histogram bucket.
  // Add the missing fractional millisecond; the final overflow bucket is unbounded.
  const lowerInclusiveMs = i === 0 ? 0 : BUCKETS[i - 1] + 1;
  const upperExclusiveMs = i === BUCKETS.length - 1 ? null : BUCKETS[i] + 1;
  return { bucketMs: BUCKETS[i], lowerInclusiveMs, upperExclusiveMs, limitMs,
    verdict: upperExclusiveMs !== null && upperExclusiveMs <= limitMs ? 'within-bound'
      : lowerInclusiveMs > limitMs ? 'exceeds-bound' : 'inconclusive' };
}
export function parseHealth(memory, thermal, battery) {
  const pss = /(?:TOTAL PSS:\s*(\d+)|^\s*TOTAL\s+(\d+)\s)/m.exec(memory);
  const status = /Thermal Status:\s*([0-6])\b/.exec(thermal);
  const override = /IsStatusOverride:\s*(true|false)/.exec(thermal);
  const ready = /HAL Ready:\s*(true|false)/.exec(thermal);
  const temp = /^\s*temperature:\s*(-?\d+)\s*$/m.exec(battery);
  const level = /^\s*level:\s*(\d+)\s*$/m.exec(battery);
  const scale = /^\s*scale:\s*(\d+)\s*$/m.exec(battery);
  requireStat(pss && status && override?.[1] === 'false' && ready?.[1] === 'true'
    && temp && level && scale && Number(scale[1]) > 0, 'missing-or-synthetic-health');
  const result = { totalPssKiB: Number(pss[1] ?? pss[2]), thermalStatus: Number(status[1]),
    batteryTemperatureC: Number(temp[1]) / 10, batteryPercent: Number(level[1]) * 100 / Number(scale[1]) };
  requireStat(result.totalPssKiB > 0 && result.totalPssKiB <= 100_000_000
    && result.batteryTemperatureC >= -30 && result.batteryTemperatureC <= 100
    && result.batteryPercent >= 0 && result.batteryPercent <= 100, 'invalid-health');
  return result;
}
export function installedIdentity(text, packageName) {
  const escaped = packageName.replaceAll('.', '\\.');
  requireStat(new RegExp(`Package \\[${escaped}\\]`).test(text), 'package-identity-unavailable');
  const codes = [...text.matchAll(/\bversionCode=(\d+)\b/g)];
  const flags = [...text.matchAll(/^\s*(?:pkgFlags|flags)=\[([^\]]*)\]/gm)];
  requireStat(codes.length === 1 && flags.length > 0 && !flags.some(f => /\bDEBUGGABLE\b/.test(f[1])), 'debuggable-or-ambiguous-package');
  const versionCode = Number(codes[0][1]); requireStat(Number.isSafeInteger(versionCode) && versionCode > 0, 'invalid-version');
  return { packageName, versionCode, debuggable: false };
}
