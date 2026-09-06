/**
 * A small block of a colour, shown beside the hex code that names it in a
 * finding or warning. Purely presentational — the fill is exactly the string
 * quoted alongside it, so it cannot disagree with what the figure actually
 * uses. Shared by the Quality tab's `withColorSwatches` (`SidePanel.tsx`) and
 * the Inspector's colour-conflict warnings, which render the same two hex
 * codes through different JSX shapes (one string to regex-split, two
 * separate expressions) and would otherwise carry two copies of this span.
 */
export function ColorChip({ hex }: { hex: string }) {
  return <span className="color-chip" style={{ background: hex }} title={hex} aria-hidden />;
}
