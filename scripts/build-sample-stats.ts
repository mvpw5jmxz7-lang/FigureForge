/**
 * Regenerates the pinned statistics for the built-in sample figure.
 *
 * The sample figure (`apps/web/src/sampleDocument.ts`) ships its statistics as
 * constants so it renders and scores offline — the same design the old volcano
 * panel used. This script is how those constants are produced: it builds each
 * dataset exactly as `sampleDocument.ts` does, calls the running analysis
 * service once per panel, and prints a ready-to-paste `sampleStats.ts` body.
 *
 * Run it in the api container with the service up:
 *
 *   podman exec figureforge-api npx vite-node scripts/build-sample-stats.ts
 *
 * Not part of CI — the committed constants are the source of truth; this only
 * proves them reproducible.
 */
import {
  analysisInputHash,
  eventsForHash,
  parseDelimited,
  inferFormat,
  toSeries,
  toSurvivalGroups,
  xForHash,
  type Dataset,
  type StatResult,
} from '@figureforge/doc-model';
import {
  SAMPLE_DOSE_RESPONSE as DOSE_RESPONSE,
  SAMPLE_EXPRESSION as EXPRESSION,
  SAMPLE_MARKERS as MARKERS,
  SAMPLE_SURVIVAL as SURVIVAL,
} from '../apps/web/src/sampleDocument.js';

const API = process.env.API_URL ?? 'http://localhost:8000';

function makeDataset(text: string, name: string, format?: Dataset['format']): Dataset {
  const parsed = parseDelimited(text);
  return {
    id: name,
    name,
    format: format ?? inferFormat(parsed.columns, {}),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: null,
    sourceFilename: null,
    importedAt: new Date(0).toISOString(),
  };
}

async function analyze(body: unknown): Promise<StatResult> {
  const res = await fetch(`${API}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as StatResult;
}

function show(label: string, result: StatResult, hash: string): void {
  console.log(`\n// ${label}  (inputHash the sample builds: ${hash})`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  // a — one-way ANOVA + Holm, 3 genotypes
  {
    const ds = makeDataset(EXPRESSION, 'Target expression');
    const series = toSeries(ds);
    const result = await analyze({
      test: 'anova-one-way',
      groups: series.map((s) => ({ name: s.name, values: s.values })),
      correction: 'holm',
    });
    const hash = analysisInputHash(
      { test: 'anova-one-way', correction: 'holm' },
      series.map((s) => s.values),
      xForHash(series),
      eventsForHash('anova-one-way', ds),
    );
    show('SAMPLE_ANOVA_RESULT — panel a', result, hash);
  }

  // b — linear regression on a single x/y series
  {
    const ds = makeDataset(DOSE_RESPONSE, 'Dose response', 'simple-xy');
    const series = toSeries(ds);
    const s = series[0]!;
    const result = await analyze({
      test: 'pearson',
      groups: [{ name: s.name, values: s.values }],
      x: { name: ds.columns[0]!.name, values: s.x },
      correction: 'none',
    });
    const hash = analysisInputHash({ test: 'pearson', correction: 'none' }, [s.values], s.x);
    show('SAMPLE_REGRESSION_RESULT — panel b', result, hash);
  }

  // d — Kruskal-Wallis + Holm, 3 genotypes n=12
  {
    const ds = makeDataset(MARKERS, 'Marker distribution');
    const series = toSeries(ds);
    const result = await analyze({
      test: 'kruskal-wallis',
      groups: series.map((s) => ({ name: s.name, values: s.values })),
      correction: 'holm',
    });
    const hash = analysisInputHash(
      { test: 'kruskal-wallis', correction: 'holm' },
      series.map((s) => s.values),
      xForHash(series),
      eventsForHash('kruskal-wallis', ds),
    );
    show('SAMPLE_KRUSKAL_RESULT — panel d', result, hash);
  }

  // e — log-rank, 2 arms
  {
    const ds = makeDataset(SURVIVAL, 'Survival by arm', 'survival');
    const groups = toSurvivalGroups(ds);
    const series = toSeries(ds);
    const result = await analyze({
      test: 'log-rank',
      groups: groups.map((g) => ({ name: g.name, values: g.times })),
      events: groups.map((g) => ({ name: g.name, values: g.events.map((e) => (e ? 1 : 0)) })),
      correction: 'none',
    });
    const hash = analysisInputHash(
      { test: 'log-rank', correction: 'none' },
      series.map((s) => s.values),
      xForHash(series),
      eventsForHash('log-rank', ds),
    );
    show('SAMPLE_LOGRANK_RESULT — panel e', result, hash);
  }
}

void main();
