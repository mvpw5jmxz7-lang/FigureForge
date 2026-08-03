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

describe('import reading', () => {
  it('reads a pasted xy-pair table as independent runs', () => {
    const ds = datasetFromText(XY_PAIRS_PASTE, 'Runs', 'd1');
    expect(ds.format).toBe('sigmaplot');
    expect(toSeries(ds).map((s) => s.x?.[0])).toEqual([1, 1.4, 0.9]);
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
