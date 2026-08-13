/**
 * The rule that keeps the widened bridge from becoming an arbitrary file
 * reader.
 *
 * Stage 1's bridge touched no filesystem at all. Stage 2 hands the renderer
 * real file access, so the question "which paths may it name?" is now a
 * security boundary, and a boundary that is not tested is a boundary that is
 * asserted. Every case here is a request a hostile or buggy renderer could
 * plausibly make.
 */

import { describe, expect, it } from 'vitest';

import { ARCHIVE_EXTENSIONS } from '@figureforge/doc-model';

import { AuthorisedPaths, PROJECT_EXTENSIONS, basename, hasProjectExtension } from './projects.js';

describe('PROJECT_EXTENSIONS', () => {
  it('matches the archive extensions the document model defines', () => {
    // Imported at test time only. The main process must not take the
    // renderer's word for what counts as a project file — it is the process
    // validating the renderer — and `apps/desktop` depends on nothing internal
    // at runtime, which is what keeps the browser build first-class. This
    // assertion is what stops the two lists drifting apart unnoticed.
    expect([...PROJECT_EXTENSIONS].sort()).toEqual([...ARCHIVE_EXTENSIONS].sort());
  });
});

describe('hasProjectExtension', () => {
  it('accepts both the current and the legacy extension', () => {
    expect(hasProjectExtension('/home/a/figure.ffg')).toBe(true);
    expect(hasProjectExtension('/home/a/figure.figureforge')).toBe(true);
  });

  it('is case-insensitive, because filesystems are not consistent about it', () => {
    expect(hasProjectExtension('/home/a/FIGURE.FFG')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const path of ['/etc/passwd', '/home/a/.ssh/id_rsa', '/home/a/figure.ffg.exe']) {
      expect(hasProjectExtension(path)).toBe(false);
    }
  });
});

describe('basename', () => {
  it('handles both separators', () => {
    expect(basename('/home/a/figure.ffg')).toBe('figure.ffg');
    expect(basename('C:\\Users\\a\\figure.ffg')).toBe('figure.ffg');
    expect(basename('figure.ffg')).toBe('figure.ffg');
  });
});

describe('AuthorisedPaths', () => {
  it('refuses a path it never granted', () => {
    const paths = new AuthorisedPaths();
    expect(paths.refuse('/home/a/figure.ffg')).toMatch(/did not open or save/);
  });

  it('allows a granted path', () => {
    const paths = new AuthorisedPaths();
    paths.grant('/home/a/figure.ffg');
    expect(paths.refuse('/home/a/figure.ffg')).toBeNull();
  });

  it('refuses a non-project file even after it was granted', () => {
    // Belt and braces: nothing should ever grant one, but the extension check
    // is what makes a bug in the granting path non-exploitable.
    const paths = new AuthorisedPaths();
    paths.grant('/etc/passwd');
    expect(paths.refuse('/etc/passwd')).toMatch(/not a FigureForge project/);
  });

  it('names the file rather than the whole path in the extension refusal', () => {
    const paths = new AuthorisedPaths();
    expect(paths.refuse('/home/someone/secrets/notes.txt')).toContain('notes.txt');
  });

  it('does not authorise a sibling of a granted path', () => {
    const paths = new AuthorisedPaths();
    paths.grant('/home/a/figure.ffg');
    expect(paths.refuse('/home/a/other.ffg')).toMatch(/did not open or save/);
  });

  it('grants exactly the string given, with no normalisation', () => {
    // Path traversal only matters if two spellings of one file can disagree
    // about authorisation. They cannot here: the set is compared literally,
    // and every member came from the OS itself via a dialog or a drop.
    const paths = new AuthorisedPaths();
    paths.grant('/home/a/figure.ffg');
    expect(paths.refuse('/home/a/../a/figure.ffg')).toMatch(/did not open or save/);
  });
});
