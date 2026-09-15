/**
 * The AI layout assistant's client-side seam.
 *
 * `validateGroupingSuggestion`/`validateLayoutInstruction` are pure functions
 * and get the bulk of the coverage — they are what stands between whatever
 * the server returns and a document mutation, so every hallucination/
 * malformed-shape case is worth pinning here independent of any network.
 * `httpLayoutAssistant()` is covered separately with a stubbed `fetch`, to
 * prove the wire shape really does flow through those same validators.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  httpLayoutAssistant,
  validateGroupingSuggestion,
  validateLayoutInstruction,
  type GroupingSuggestion,
  type LayoutInstruction,
  type PanelSummary,
} from './aiLayoutAssistant.js';

const PANELS: PanelSummary[] = [
  { panelId: 'p1', letter: 'a', plotType: 'bar-dot', axisTitles: [], datasetName: 'Cohort 1' },
  { panelId: 'p2', letter: 'b', plotType: 'heatmap', axisTitles: [], datasetName: 'Cohort 1' },
  { panelId: 'p3', letter: 'c', plotType: 'scatter', axisTitles: [] },
];

describe('validateGroupingSuggestion', () => {
  it('passes a well-formed group through unchanged', () => {
    const suggestion: GroupingSuggestion = {
      groups: [{ panelIds: ['p1', 'p2'], rationale: 'Same cohort.' }],
    };
    expect(validateGroupingSuggestion(PANELS, suggestion)).toEqual(suggestion);
  });

  it('drops a hallucinated id from its group rather than the whole group', () => {
    const suggestion: GroupingSuggestion = {
      groups: [{ panelIds: ['p1', 'p2', 'not-a-real-id'], rationale: 'ok' }],
    };
    expect(validateGroupingSuggestion(PANELS, suggestion).groups).toEqual([
      { panelIds: ['p1', 'p2'], rationale: 'ok' },
    ]);
  });

  it('drops a group left with fewer than two real panels', () => {
    const suggestion: GroupingSuggestion = {
      groups: [{ panelIds: ['p1', 'invented'], rationale: 'ok' }],
    };
    expect(validateGroupingSuggestion(PANELS, suggestion).groups).toEqual([]);
  });

  it('deduplicates a repeated id within one group', () => {
    const suggestion: GroupingSuggestion = {
      groups: [{ panelIds: ['p1', 'p1', 'p2'], rationale: 'ok' }],
    };
    expect(validateGroupingSuggestion(PANELS, suggestion).groups[0]?.panelIds).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('keeps every well-formed group when several are offered', () => {
    const suggestion: GroupingSuggestion = {
      groups: [
        { panelIds: ['p1', 'p2'], rationale: 'a' },
        { panelIds: ['p3', 'invented'], rationale: 'dropped' },
      ],
    };
    expect(validateGroupingSuggestion(PANELS, suggestion).groups).toHaveLength(1);
  });
});

describe('validateLayoutInstruction', () => {
  it('passes a well-formed group instruction through unchanged', () => {
    const instruction: LayoutInstruction = {
      kind: 'group',
      panelIds: ['p1', 'p2'],
      reason: 'asked',
    };
    expect(validateLayoutInstruction(PANELS, instruction)).toEqual(instruction);
  });

  it('passes a well-formed resize instruction through unchanged', () => {
    const instruction: LayoutInstruction = {
      kind: 'resize',
      panelId: 'p2',
      direction: 'bigger',
      reason: 'asked',
    };
    expect(validateLayoutInstruction(PANELS, instruction)).toEqual(instruction);
  });

  it('turns a resize naming an unknown panel into unsupported', () => {
    const instruction: LayoutInstruction = {
      kind: 'resize',
      panelId: 'not-a-real-id',
      direction: 'bigger',
      reason: 'asked',
    };
    expect(validateLayoutInstruction(PANELS, instruction).kind).toBe('unsupported');
  });

  it('turns a group left with one real panel into unsupported', () => {
    const instruction: LayoutInstruction = {
      kind: 'group',
      panelIds: ['p1', 'gone'],
      reason: 'asked',
    };
    expect(validateLayoutInstruction(PANELS, instruction).kind).toBe('unsupported');
  });

  it('leaves an already-unsupported instruction untouched', () => {
    const instruction: LayoutInstruction = { kind: 'unsupported', reason: 'not possible' };
    expect(validateLayoutInstruction(PANELS, instruction)).toEqual(instruction);
  });
});

describe('httpLayoutAssistant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts panels to /layout/suggest-grouping and validates the reply', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ groups: [{ panelIds: ['p1', 'p2', 'invented'], rationale: 'x' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpLayoutAssistant().suggestGrouping(PANELS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/layout/suggest-grouping');
    const body = JSON.parse(init!.body as string) as { panels: unknown[]; apiKey?: string };
    expect(body.panels).toHaveLength(3);
    // No key was passed, so the wire shape omits the field entirely rather
    // than sending an explicit undefined/empty value.
    expect(body).not.toHaveProperty('apiKey');
    // The invented id was filtered by the client, not merely trusted from the wire.
    expect(result.groups).toEqual([{ panelIds: ['p1', 'p2'], rationale: 'x' }]);
  });

  it('includes a supplied apiKey in the request body', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ groups: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await httpLayoutAssistant().suggestGrouping(PANELS, 'sk-ant-mine');

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as { apiKey?: string };
    expect(body.apiKey).toBe('sk-ant-mine');
  });

  it('posts an instruction to /layout/interpret and validates the reply', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        kind: 'resize',
        reason: 'asked',
        panelId: 'p2',
        direction: 'bigger',
        panelIds: null,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpLayoutAssistant().interpretInstruction('bigger heatmap', PANELS);

    expect(result).toEqual({ kind: 'resize', panelId: 'p2', direction: 'bigger', reason: 'asked' });
  });

  it('downgrades a resize naming an id outside the sent panel list to unsupported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          kind: 'resize',
          reason: 'asked',
          panelId: 'not-sent',
          direction: 'bigger',
        }),
      })),
    );

    const result = await httpLayoutAssistant().interpretInstruction('x', PANELS);
    expect(result.kind).toBe('unsupported');
  });

  it('throws ApiError on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ detail: 'Too many panels.' }),
      })),
    );

    await expect(httpLayoutAssistant().suggestGrouping(PANELS)).rejects.toThrow(
      'Too many panels.',
    );
  });
});
