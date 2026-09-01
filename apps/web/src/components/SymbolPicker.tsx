/**
 * A Greek-letter/math-symbol insertion menu.
 *
 * Raw Unicode already renders correctly wherever text is drawn — Liberation
 * Sans covers these blocks, and `text-width.ts`'s measurement already
 * tolerates any character it has no exact metric for. So this is purely a
 * discoverability affordance (find and insert `μ`, `Δ`, `±`, …) rather than
 * a rendering capability the app lacked.
 *
 * A native `<select>` rather than a floating popover: no popover/modal
 * infrastructure exists anywhere in this app, and a `<select>` is the same
 * enumerated-choice idiom the Inspector already uses everywhere else
 * (`AxisFields`'s Scale/Labels dropdowns) — it also gets free type-ahead,
 * which is a reasonable answer to "discoverability" on its own.
 */

interface SymbolEntry {
  char: string;
  name: string;
}

const GREEK: readonly SymbolEntry[] = [
  { char: 'α', name: 'alpha' },
  { char: 'β', name: 'beta' },
  { char: 'γ', name: 'gamma' },
  { char: 'δ', name: 'delta' },
  { char: 'Δ', name: 'Delta' },
  { char: 'ε', name: 'epsilon' },
  { char: 'θ', name: 'theta' },
  { char: 'λ', name: 'lambda' },
  { char: 'µ', name: 'mu' },
  { char: 'π', name: 'pi' },
  { char: 'σ', name: 'sigma' },
  { char: 'Σ', name: 'Sigma' },
  { char: 'φ', name: 'phi' },
  { char: 'χ', name: 'chi' },
  { char: 'ψ', name: 'psi' },
  { char: 'Ω', name: 'Omega' },
];

const MATH: readonly SymbolEntry[] = [
  { char: '±', name: 'plus-minus' },
  { char: '×', name: 'times' },
  { char: '÷', name: 'divide' },
  { char: '°', name: 'degree' },
  { char: '√', name: 'square root' },
  { char: '≤', name: 'less-or-equal' },
  { char: '≥', name: 'greater-or-equal' },
  { char: '≠', name: 'not equal' },
  { char: '≈', name: 'approximately' },
  { char: '∞', name: 'infinity' },
  { char: '→', name: 'right arrow' },
  { char: '²', name: 'superscript 2' },
];

export function SymbolPicker({ onInsert }: { onInsert: (char: string) => void }) {
  return (
    <select
      className="symbol-picker"
      aria-label="Insert symbol"
      value=""
      onChange={(e) => {
        if (e.target.value) onInsert(e.target.value);
        e.target.value = '';
      }}
    >
      <option value="" disabled>
        Insert symbol…
      </option>
      <optgroup label="Greek">
        {GREEK.map((s) => (
          <option key={s.char} value={s.char}>
            {s.char}  {s.name}
          </option>
        ))}
      </optgroup>
      <optgroup label="Math">
        {MATH.map((s) => (
          <option key={s.char} value={s.char}>
            {s.char}  {s.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
