/**
 * Scene tree → SVG source.
 *
 * This is the export path. It must produce a standalone document: no external
 * references, no DOM, and text that stays text so the PDF keeps it selectable
 * and journals can edit it.
 */

import type { SceneAttrs, SceneNode } from './scene.js';
import { round } from './scene.js';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);

function serializeAttrs(attrs: SceneAttrs | undefined): string {
  if (!attrs) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const rendered = typeof value === 'number' ? String(round(value)) : escapeXml(value);
    parts.push(`${key}="${rendered}"`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export interface SvgStringOptions {
  /** Emit newlines and indentation. Off by default for compact output. */
  pretty?: boolean;
  /** Prepend the XML declaration — required for standalone .svg files. */
  xmlDeclaration?: boolean;
}

function serializeNode(node: SceneNode, indent: string, pretty: boolean): string {
  const attrs = serializeAttrs(node.attrs);
  const children = node.children ?? [];
  const hasText = node.text !== undefined && node.text !== '';

  if (!hasText && children.length === 0) {
    return `${indent}<${node.tag}${attrs}/>`;
  }

  // Text content must not be reflowed: whitespace inside <text> is rendered,
  // so indenting it would shift glyph positions in the output.
  if (hasText) {
    const inner = escapeXml(node.text!);
    const nested = children.map((c) => serializeNode(c, '', false)).join('');
    return `${indent}<${node.tag}${attrs}>${inner}${nested}</${node.tag}>`;
  }

  const nl = pretty ? '\n' : '';
  const childIndent = pretty ? `${indent}  ` : '';
  const inner = children.map((c) => serializeNode(c, childIndent, pretty)).join(nl);
  return `${indent}<${node.tag}${attrs}>${nl}${inner}${nl}${indent}</${node.tag}>`;
}

export function toSvgString(root: SceneNode, options: SvgStringOptions = {}): string {
  const pretty = options.pretty ?? false;
  const body = serializeNode(root, '', pretty);
  return options.xmlDeclaration ? `<?xml version="1.0" encoding="UTF-8"?>\n${body}` : body;
}

/**
 * Wrap the SVG in a minimal HTML page sized to the exact figure dimensions,
 * for the headless-browser PDF and raster export path.
 *
 * `svg { display: block }` is load-bearing: an inline SVG sits on a text
 * baseline, and the descender space beneath it pushes the content past the page
 * box, producing a second, blank page. Ghostscript then refuses to convert the
 * PDF to EPS at all.
 */
export function toExportHtml(
  svg: string,
  widthMm: number,
  heightMm: number,
  fontCss = '',
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: ${round(widthMm)}mm ${round(heightMm)}mm; margin: 0; }
html, body { margin: 0; padding: 0; width: ${round(widthMm)}mm; height: ${round(heightMm)}mm; }
svg { display: block; }
${fontCss}
</style>
</head>
<body>${svg}</body>
</html>`;
}
