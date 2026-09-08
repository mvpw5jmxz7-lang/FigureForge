import { describe, expect, it } from 'vitest';
import { toSeries } from '@figureforge/doc-model';
import { axisTitlesFor, datasetFromText } from './sample.js';

/**
 * The columns of `TestFiles/test graph.xlsx`, tab-delimited — the bytes an
 * Excel copy actually puts on the clipboard. Three runs, each measured at its
 * own x positions.
 */
const XY_PAIRS_PASTE = [
  'X1\tY1\tX2\tY2\tX3\tY3',
  '1\t0\t1.4\t0.05\t0.9\t0.1',
  '2\t0.1\t1.9\t0.2\t2.05\t0.24',
  '3\t0.3\t3.1\t0.4\t2.9\t0.47',
  '4\t0.5\t3.9\t0.7\t4.05\t0.8',
  '5\t0.6\t5.1\t0.8\t5.05\t0.9',
  '6\t0.7\t6.1\t0.9\t6.1\t1.1',
].join('\n');

/**
 * `TestFiles/test2 data table.xlsx` — a shared x with three replicate y columns
 * per condition, its group titles written as merged cells.
 */
const XY_REPLICATES_PASTE = [
  'Hours\tControl\t\t\tTreated\t\t',
  '0\t45\t34\t20\t34\t31\t29',
  '6\t56\t58\t61\t41\t43\t42',
  '12\t76\t72\t77\t52\t55\t55',
  '24\t81\t95\t83\t63\t63\t80',
  '48\t99\t100\t104\t72\t67\t81',
  '72\t97\t110\t115\t78\t87\t60',
].join('\n');

/**
 * `TestFiles/grouped data example.prism` — genotypes down the rows, treatments
 * across the columns, three replicates in each cell.
 */
const GROUPED_PASTE = [
  '\tControl\t\t\tDrug A\t\t\tDrug B\t\t',
  'Wild type\t23\t21\t19\t67\t79\t98\t88\t86\t89',
  'Knock-out A\t24\t23\t15\t29\t31\t32\t90\t91\t92',
  'Knock-out B\t21\t25\t27\t65\t69\t71\t65\t66\t63',
].join('\n');

describe('import reading', () => {
  it('reads a pasted xy-pair table as independent runs', () => {
    const ds = datasetFromText(XY_PAIRS_PASTE, 'Runs', 'd1');
    expect(ds.format).toBe('sigmaplot');
    expect(toSeries(ds).map((s) => s.x?.[0])).toEqual([1, 1.4, 0.9]);
  });

  it('reads a merged-header replicate table without being told anything', () => {
    // `TestFiles/test2 data table.xlsx`: the merged group titles declare the
    // blocks, so no override is needed.
    const ds = datasetFromText(XY_REPLICATES_PASTE, 'Timecourse', 'd2');
    expect(ds.format).toBe('xy-replicates');
    expect(toSeries(ds).map((s) => s.name)).toEqual(['Control', 'Treated']);
    expect(axisTitlesFor(ds)).toEqual({ x: 'Hours' });
  });

  it('takes a stated replicate count as the statement that a table is xy+replicates', () => {
    /*
     * The same numbers with no merged header. Detection can only see a shared x
     * and six y columns, which is a legitimate reading — six series — so the
     * author settles it with one number rather than also hunting the layout out
     * of a dropdown listed under a Prism name.
     */
    const plain = 'Hours,C1,C2,C3,T1,T2,T3\n0,45,34,20,34,31,29\n6,56,58,61,41,43,42';
    expect(datasetFromText(plain, 'Timecourse', 'd3').format).toBe('prism');

    const stated = datasetFromText(plain, 'Timecourse', 'd3', null, { replicatesPerGroup: 3 });
    expect(stated.format).toBe('xy-replicates');
    expect(toSeries(stated).map((s) => s.name)).toEqual(['C1', 'T1']);
    expect(toSeries(stated)[0]!.values).toHaveLength(6);
  });

  it('does not read one column per series as a replicate claim', () => {
    // A count of 1 says nothing about replicates, so the table stays as read.
    const plain = 'Hours,WT,KO\n0,45,34\n6,56,58';
    expect(datasetFromText(plain, 'T', 'd4', null, { replicatesPerGroup: 1 }).format).toBe('prism');
  });

  it('reads a merged-header Grouped table without being told anything', () => {
    const ds = datasetFromText(GROUPED_PASTE, 'Genotypes', 'd5');
    expect(ds.format).toBe('grouped-replicates');
    expect(ds.columnGroups?.map((g) => g.name)).toEqual(['Control', 'Drug A', 'Drug B']);
    expect(toSeries(ds)).toHaveLength(9);
  });

  it('takes a stated column count as the statement that a table is grouped', () => {
    /*
     * The same table pasted without its group-title row. Detection sees labelled
     * rows and nine numeric columns, which reads as one treatment measured nine
     * times — a legitimate reading of that rectangle, and the wrong one here.
     * Before this the author had to find "Grouped" in the layout dropdown before
     * the control that takes the count would even appear.
     */
    const plain = GROUPED_PASTE.split('\n').slice(1).join('\n');
    expect(datasetFromText(plain, 'Genotypes', 'd6').format).toBe('replicate');

    const stated = datasetFromText(plain, 'Genotypes', 'd6', null, { replicatesPerGroup: 3 });
    expect(stated.format).toBe('grouped-replicates');
    const series = toSeries(stated);
    expect(series).toHaveLength(9);
    expect(series[0]!.category).toBe('Wild type');
    // Named for what they are, not after the placeholder column letters B/E/H.
    expect(stated.columnGroups?.map((g) => g.name)).toEqual(['Group 1', 'Group 2', 'Group 3']);
  });

  it('leaves a labelled replicate table alone when no count is stated', () => {
    const plain = GROUPED_PASTE.split('\n').slice(1).join('\n');
    const ds = datasetFromText(plain, 'Genotypes', 'd7', null, { replicatesPerGroup: 1 });
    expect(ds.format).toBe('replicate');
    expect(toSeries(ds)).toHaveLength(3);
  });
});

describe('axisTitlesFor', () => {
  it('takes a column name only when every column feeding that axis carries it', () => {
    /*
     * `X1,Y1,X2,Y2,X3,Y3` used to title its axes "X1" and "Y1" — the names of
     * one of three series, with "Y1" simultaneously sitting in the legend
     * beside "Y2" and "Y3". A name only one series owns does not name the axis.
     */
    expect(axisTitlesFor(datasetFromText(XY_PAIRS_PASTE, 'Runs', 'd1'))).toEqual({});
  });

  it('names a fold-fold plot\'s axes after its two contrast columns', () => {
    /*
     * The one shape where each axis is fed by exactly one named column, so
     * the "every column feeding this axis agrees" rule has nothing to decide
     * and would reject the honest answer — it reads both numeric columns as
     * y candidates and finds two different names.
     *
     * The opposite case to a volcano's, where `addPlot` hardcodes the titles
     * because neither header names what is drawn.
     */
    const ds = {
      ...datasetFromText('Gene,97Q/25Q enrichment,97Q/APEX enrichment\nTP53,2.1,1.7', 'FF', 'd9'),
      format: 'fold-fold' as const,
    };
    expect(axisTitlesFor(ds)).toEqual({
      x: '97Q/25Q enrichment',
      y: '97Q/APEX enrichment',
    });
  });

  it('leaves a fold-fold axis untitled when the header was a placeholder', () => {
    // `defaultColumnName` produces A, B, C… for a header-less paste; putting
    // one on an axis is worse than leaving it for the author to fill.
    const ds = {
      ...datasetFromText('Gene,A,B\nTP53,2.1,1.7', 'FF', 'd10'),
      format: 'fold-fold' as const,
    };
    expect(axisTitlesFor(ds)).toEqual({});
  });

  it('takes the shared name of repeated x columns', () => {
    // The honest case for the same rule: every run really was measured against
    // a radius, so "Radius" is the x axis.
    const ds = datasetFromText(
      'Radius,C(s)_run1,Radius,C(s)_run2\n6.0,0.1,6.1,0.2\n6.5,0.4,6.6,0.5',
      'Sedimentation',
      'd2',
    );
    expect(ds.format).toBe('sigmaplot');
    expect(axisTitlesFor(ds)).toEqual({ x: 'Radius' });
  });

  it('keeps both titles for a single xy series', () => {
    const ds = datasetFromText('Time (h),Absorbance\n0,0.1\n1,0.4', 'Kinetics', 'd3');
    expect(ds.format).toBe('simple-xy');
    expect(axisTitlesFor(ds)).toEqual({ x: 'Time (h)', y: 'Absorbance' });
  });

  it('withholds the y title on a shared-x table, where the y columns are series', () => {
    const ds = datasetFromText('Time,WT,KO,Rescue\n0,1,2,3\n1,2,3,4', 'Timecourse', 'd4');
    expect(ds.format).toBe('prism');
    expect(axisTitlesFor(ds)).toEqual({ x: 'Time' });
  });

  it('offers nothing for a layout whose first column labels groups', () => {
    const ds = datasetFromText('Treatment,R1,R2,R3\nVehicle,10,11,12', 'Viability', 'd5');
    expect(ds.format).toBe('replicate');
    expect(axisTitlesFor(ds)).toEqual({});
  });
});
