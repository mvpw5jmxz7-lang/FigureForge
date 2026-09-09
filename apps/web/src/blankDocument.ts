/**
 * What a fresh figure is.
 *
 * The app opened on a seven-panel demo until round 51, which was built to show
 * what the renderer could draw and to give Smart layout something real to
 * solve. It did both; an author starting work now wants the page they are
 * going to publish, not one they have to empty first.
 *
 * `createDocument`'s own defaults are already right — 'Untitled figure', the
 * nature-double preset at 183 x 120 mm, the default layers, no nodes — so this
 * adds nothing but a name. The name is the point: launch, New Figure and Close
 * File must all produce the same thing, and three call sites each spelling out
 * their own idea of "blank" is how they come to disagree.
 */

import { createDocument, type FigureDocument } from '@figureforge/doc-model';

export function blankDocument(): FigureDocument {
  return createDocument();
}
