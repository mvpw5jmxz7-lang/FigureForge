/**
 * The recent-projects list.
 *
 * The parser cases matter more than the list arithmetic: this file lives in
 * the user's profile, survives upgrades, and is read during menu construction
 * — so anything it might contain has to degrade to "no recents" rather than
 * stop the app from starting.
 */

import { describe, expect, it } from 'vitest';

import { MAX_RECENT, addRecent, parseRecent, removeRecent, serialiseRecent } from './recent.js';

describe('addRecent', () => {
  it('puts the newest first', () => {
    expect(addRecent(['/a.ffg'], '/b.ffg')).toEqual(['/b.ffg', '/a.ffg']);
  });

  it('moves a re-opened file to the top instead of duplicating it', () => {
    expect(addRecent(['/a.ffg', '/b.ffg'], '/b.ffg')).toEqual(['/b.ffg', '/a.ffg']);
  });

  it('is bounded, dropping the oldest', () => {
    const many = Array.from({ length: MAX_RECENT }, (_, i) => `/f${i}.ffg`);
    const next = addRecent(many, '/new.ffg');
    expect(next).toHaveLength(MAX_RECENT);
    expect(next[0]).toBe('/new.ffg');
    expect(next).not.toContain(`/f${MAX_RECENT - 1}.ffg`);
  });

  it('does not mutate the list it was given', () => {
    const original = ['/a.ffg'];
    addRecent(original, '/b.ffg');
    expect(original).toEqual(['/a.ffg']);
  });
});

describe('removeRecent', () => {
  it('drops an entry that no longer opens', () => {
    expect(removeRecent(['/a.ffg', '/b.ffg'], '/a.ffg')).toEqual(['/b.ffg']);
  });

  it('is a no-op for something not in the list', () => {
    expect(removeRecent(['/a.ffg'], '/gone.ffg')).toEqual(['/a.ffg']);
  });
});

describe('parseRecent', () => {
  it('round-trips through serialise', () => {
    const list = ['/a.ffg', '/b.ffg'];
    expect(parseRecent(serialiseRecent(list))).toEqual(list);
  });

  it('survives a corrupt file', () => {
    // Read during menu construction, so a throw here would be a shell that
    // will not start because of a convenience feature.
    for (const bad of ['', 'not json', '{', 'null', '{"recent":[]}', '3']) {
      expect(parseRecent(bad)).toEqual([]);
    }
  });

  it('drops non-string entries rather than trusting the file', () => {
    expect(parseRecent('["/a.ffg", 7, null, {"path":"/b.ffg"}]')).toEqual(['/a.ffg']);
  });

  it('clamps a hand-grown list back to the maximum', () => {
    const huge = JSON.stringify(Array.from({ length: 100 }, (_, i) => `/f${i}.ffg`));
    expect(parseRecent(huge)).toHaveLength(MAX_RECENT);
  });
});
