/**
 * Colour palettes and accessibility validation.
 *
 * The default is Okabe-Ito, the eight-colour set designed by Masataka Okabe and
 * Kei Ito to stay distinguishable under all three common forms of colour vision
 * deficiency. It is the defensible default for figures that will be read by
 * roughly 8% of men with some form of CVD.
 */

export interface Palette {
  id: string;
  name: string;
  colors: readonly string[];
  /** True when the colours also separate once converted to greyscale. */
  grayscaleSafe: boolean;
  description: string;
}

export const OKABE_ITO: readonly string[] = [
  '#0072b2', // blue
  '#e69f00', // orange
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#56b4e9', // sky blue
  '#d55e00', // vermillion
  '#f0e442', // yellow
  '#000000', // black
];

export const PALETTES: readonly Palette[] = [
  {
    id: 'okabe-ito',
    name: 'Okabe–Ito (colour-blind safe)',
    colors: OKABE_ITO,
    grayscaleSafe: false,
    description: 'Distinguishable under deuteranopia, protanopia and tritanopia.',
  },
  {
    id: 'nature',
    name: 'Nature',
    colors: ['#3b6fb6', '#e1812c', '#3a923a', '#c03d3e', '#9372b2', '#845b53'],
    grayscaleSafe: false,
    description: 'Muted primaries in the register commonly seen in Nature figures.',
  },
  {
    id: 'grayscale',
    name: 'Greyscale safe',
    colors: ['#000000', '#404040', '#707070', '#9e9e9e', '#c4c4c4', '#e8e8e8'],
    grayscaleSafe: true,
    description: 'Separates by lightness alone; survives black-and-white printing.',
  },
  {
    id: 'viridis-discrete',
    name: 'Viridis (discrete)',
    colors: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
    grayscaleSafe: true,
    description: 'Perceptually uniform and monotonic in lightness.',
  },
];

export const findPalette = (id: string): Palette | undefined => PALETTES.find((p) => p.id === id);

export function paletteColors(palette: string | readonly string[], count: number): string[] {
  const base = Array.isArray(palette)
    ? (palette as readonly string[])
    : (findPalette(palette as string)?.colors ?? OKABE_ITO);
  if (base.length === 0) return Array.from({ length: count }, () => '#000000');
  return Array.from({ length: count }, (_, i) => base[i % base.length]!);
}

// ---------------------------------------------------------------------------
// Colour space conversion
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const value = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(value)) return { r: 0, g: 0, b: 0 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

export const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;

const srgbToLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (c: number): number => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return v * 255;
};

/** Relative luminance per WCAG 2.1. */
export function relativeLuminance(color: string): number {
  const { r, g, b } = parseHex(color);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio, 1–21. Used for text legibility checks. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// CIELAB / ΔE
// ---------------------------------------------------------------------------

interface Lab {
  L: number;
  a: number;
  b: number;
}

/** sRGB → CIELAB under D65. */
export function toLab(color: string): Lab {
  const { r, g, b } = parseHex(color);
  const [rl, gl, bl] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];

  // sRGB → XYZ (D65), then normalise by the white point.
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;

  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t / 116 + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIEDE2000 perceptual difference. Roughly: <1 is invisible, ~2.3 is the
 * "just noticeable difference", and series colours in a figure want to be
 * comfortably above 10.
 */
export function deltaE2000(colorA: string, colorB: string): number {
  const l1 = toLab(colorA);
  const l2 = toLab(colorB);

  const kL = 1;
  const kC = 1;
  const kH = 1;

  const c1 = Math.hypot(l1.a, l1.b);
  const c2 = Math.hypot(l2.a, l2.b);
  const cBar = (c1 + c2) / 2;

  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * l1.a;
  const a2p = (1 + g) * l2.a;

  const c1p = Math.hypot(a1p, l1.b);
  const c2p = Math.hypot(a2p, l2.b);

  const deg = (rad: number): number => (rad * 180) / Math.PI;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const norm = (d: number): number => (d < 0 ? d + 360 : d);

  const h1p = c1p === 0 ? 0 : norm(deg(Math.atan2(l1.b, a1p)));
  const h2p = c2p === 0 ? 0 : norm(deg(Math.atan2(l2.b, a2p)));

  const dLp = l2.L - l1.L;
  const dCp = c2p - c1p;

  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2);

  const lBarP = (l1.L + l2.L) / 2;
  const cBarP = (c1p + c2p) / 2;

  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hBarP += h1p + h2p < 360 ? 360 : -360;
    hBarP /= 2;
  }

  const t =
    1 -
    0.17 * Math.cos(rad(hBarP - 30)) +
    0.24 * Math.cos(rad(2 * hBarP)) +
    0.32 * Math.cos(rad(3 * hBarP + 6)) -
    0.2 * Math.cos(rad(4 * hBarP - 63));

  const sL = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;

  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const rT = -rC * Math.sin(rad(2 * dTheta));

  return Math.sqrt(
    (dLp / (kL * sL)) ** 2 +
      (dCp / (kC * sC)) ** 2 +
      (dHp / (kH * sH)) ** 2 +
      rT * (dCp / (kC * sC)) * (dHp / (kH * sH)),
  );
}

// ---------------------------------------------------------------------------
// Colour vision deficiency simulation
// ---------------------------------------------------------------------------

export type CvdType = 'deuteranopia' | 'protanopia' | 'tritanopia';

/**
 * Brettel/Viénot-style linear-RGB projections. Approximations, but the standard
 * ones used for design checking and more than accurate enough to catch a
 * red/green series pairing before it reaches a reviewer.
 */
const CVD_MATRICES: Record<CvdType, readonly number[]> = {
  protanopia: [0.1121, 0.8853, -0.0005, 0.1127, 0.8897, -0.0001, 0.0045, 0.0085, 0.9913],
  deuteranopia: [0.292, 0.7054, -0.0003, 0.2843, 0.6975, 0.0001, -0.0209, 0.0286, 0.9924],
  tritanopia: [0.9553, 0.0522, -0.0075, -0.0059, 0.9354, 0.0705, 0.0983, 0.7168, 0.1849],
};

export function simulateCvd(color: string, type: CvdType): string {
  const { r, g, b } = parseHex(color);
  const [rl, gl, bl] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const m = CVD_MATRICES[type];
  return toHex({
    r: linearToSrgb(m[0]! * rl + m[1]! * gl + m[2]! * bl),
    g: linearToSrgb(m[3]! * rl + m[4]! * gl + m[5]! * bl),
    b: linearToSrgb(m[6]! * rl + m[7]! * gl + m[8]! * bl),
  });
}

/** Greyscale as a print press would render it — luminance only. */
export function toGrayscale(color: string): string {
  const v = linearToSrgb(relativeLuminance(color));
  return toHex({ r: v, g: v, b: v });
}

export interface ColorConflict {
  colorA: string;
  colorB: string;
  indexA: number;
  indexB: number;
  /** Which condition the pair collides under; 'grayscale' for print. */
  condition: CvdType | 'grayscale' | 'normal';
  deltaE: number;
}

/**
 * Below this the two series read as the same colour to an affected reader.
 * Chosen well above the 2.3 JND because figure marks are small and thin.
 */
export const MIN_SERIES_DELTA_E = 12;

/**
 * Check every pair of series colours under normal vision, all three CVD types
 * and greyscale. Returns the pairs that collide, worst first.
 */
export function findColorConflicts(
  colors: readonly string[],
  threshold = MIN_SERIES_DELTA_E,
): ColorConflict[] {
  const conditions: (CvdType | 'grayscale' | 'normal')[] = [
    'normal',
    'deuteranopia',
    'protanopia',
    'tritanopia',
    'grayscale',
  ];

  const conflicts: ColorConflict[] = [];

  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const a = colors[i]!;
      const b = colors[j]!;
      for (const condition of conditions) {
        const [sa, sb] =
          condition === 'normal'
            ? [a, b]
            : condition === 'grayscale'
              ? [toGrayscale(a), toGrayscale(b)]
              : [simulateCvd(a, condition), simulateCvd(b, condition)];

        const d = deltaE2000(sa, sb);
        if (d < threshold) {
          conflicts.push({ colorA: a, colorB: b, indexA: i, indexB: j, condition, deltaE: d });
        }
      }
    }
  }

  return conflicts.sort((x, y) => x.deltaE - y.deltaE);
}
