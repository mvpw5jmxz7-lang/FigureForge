/**
 * The stored working directory's parser.
 *
 * Mirrors `recent.test.ts`: the point of a tolerant parser is what it does
 * with a file it did not write, so the corruption cases are the test.
 */

import { describe, expect, it } from 'vitest';

import { parseWorkingDirectory, serialiseWorkingDirectory } from './workingDirectory';

describe('parseWorkingDirectory', () => {
  it('round-trips a stored path', () => {
    expect(parseWorkingDirectory(serialiseWorkingDirectory('/home/a/Figures'))).toBe(
      '/home/a/Figures',
    );
  });

  it('round-trips "no working directory"', () => {
    expect(parseWorkingDirectory(serialiseWorkingDirectory(null))).toBeNull();
  });

  it('survives anything the file might actually contain', () => {
    // A malformed or hand-edited file must degrade to "no working directory"
    // rather than throw during `startUp`, which would stop the app opening at
    // all — the same reason `parseRecent` swallows everything.
    for (const json of [
      '',
      'not json',
      '{',
      'null',
      '3',
      '"/home/a"', // a bare string: valid JSON, wrong shape
      '[]',
      '["/home/a"]',
      '{}',
      '{"path":42}',
      '{"path":null}',
      '{"path":""}',
    ]) {
      expect(parseWorkingDirectory(json), json).toBeNull();
    }
  });

  it('refuses a relative path', () => {
    // A cheap guard on a hand-edited file rather than a security control: the
    // value only ever reaches a dialog's `defaultPath` and is never opened, so
    // a wrong one costs a dialog that starts somewhere unhelpful.
    expect(parseWorkingDirectory('{"path":"Figures"}')).toBeNull();
    expect(parseWorkingDirectory('{"path":"./Figures"}')).toBeNull();
    expect(parseWorkingDirectory('{"path":"../Figures"}')).toBeNull();
  });

  it('keeps a path that no longer exists', () => {
    // Deliberately not checked against the filesystem: a folder on a network
    // share that is temporarily unmounted must not silently forget itself.
    expect(parseWorkingDirectory('{"path":"/mnt/share/Figures"}')).toBe('/mnt/share/Figures');
  });
});
