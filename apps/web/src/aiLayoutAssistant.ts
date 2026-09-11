/**
 * The AI layout helper's client-side seam.
 *
 * `LayoutAssistant` is an interface, the same discipline `ProjectFileSystem`
 * (`projectFiles.ts`) already follows: the real implementation
 * (`httpLayoutAssistant`) calls the service, and a caller that wants a
 * deterministic double for a test — or a future in-app stub, if the real
 * backend is ever unreachable — can supply any object shaped like this one.
 *
 * The whole point of this module, matching `packages/doc-model/src/
 * smart-layout.ts`'s own stated reasoning ("an LLM cannot measure
 * millimetres"): nothing here ever produces a frame, a millimetre or an
 * id it invented. `suggestGrouping`/`interpretInstruction` both return a
 * closed shape, and both re-validate every id in that shape against the
 * exact panel list the request was built from before returning it — an id
 * the assistant hallucinated, or a group left with fewer than two real
 * panels, is treated exactly like an out-of-scope request: dropped, or
 * turned into `{ kind: 'unsupported' }`. The server already does this
 * validation (`services/api/figureforge/layout_assistant.py`); this is a
 * second, independent check on the client, which is what lets a caller here
 * trust the shape without re-deriving the server's own logic.
 */

import type { NodeId } from '@figureforge/doc-model';
import {
  interpretLayoutInstruction as interpretLayoutInstructionOverHttp,
  suggestPanelGrouping as suggestPanelGroupingOverHttp,
  type AiPanelSummary,
  type LayoutInstructionResult,
} from './api.js';

export interface PanelSummary {
  panelId: NodeId;
  letter: string;
  plotType?: string;
  axisTitles: readonly string[];
  datasetName?: string;
  captionText?: string;
}

export interface GroupSuggestion {
  panelIds: readonly NodeId[];
  rationale: string;
}

export interface GroupingSuggestion {
  groups: readonly GroupSuggestion[];
}

/**
 * A closed discriminated union, not free text. `panelIds`/`panelId`/
 * `direction` exist only for the `kind` they belong to.
 */
export type LayoutInstruction =
  | { kind: 'group'; panelIds: readonly NodeId[]; reason: string }
  | { kind: 'resize'; panelId: NodeId; direction: 'bigger' | 'smaller'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface LayoutAssistant {
  suggestGrouping(panels: readonly PanelSummary[]): Promise<GroupingSuggestion>;
  interpretInstruction(
    instruction: string,
    panels: readonly PanelSummary[],
  ): Promise<LayoutInstruction>;
}

function toWirePanel(p: PanelSummary): AiPanelSummary {
  return {
    panelId: p.panelId,
    letter: p.letter,
    plotType: p.plotType,
    axisTitles: [...p.axisTitles],
    datasetName: p.datasetName,
    captionText: p.captionText,
  };
}

function dedupeKnown(ids: readonly (string | null | undefined)[], known: ReadonlySet<NodeId>): NodeId[] {
  const seen = new Set<NodeId>();
  const out: NodeId[] = [];
  for (const id of ids) {
    if (id && known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Every id a group names, restricted to real panels and deduplicated. A
 * group left with fewer than two survivors is dropped entirely — the same
 * refusal `addGroup` (`packages/doc-model/src/operations.ts`) itself makes
 * for a group of one, so a lone survivor here would be applied as nothing.
 */
export function validateGroupingSuggestion(
  panels: readonly PanelSummary[],
  suggestion: GroupingSuggestion,
): GroupingSuggestion {
  const known = new Set(panels.map((p) => p.panelId));
  const groups: GroupSuggestion[] = [];
  for (const g of suggestion.groups) {
    const panelIds = dedupeKnown(g.panelIds, known);
    if (panelIds.length >= 2) groups.push({ panelIds, rationale: g.rationale });
  }
  return { groups };
}

/**
 * Restricted to the panel list the request was built from. An instruction
 * naming an id outside it — hallucinated, or belonging to a panel deleted
 * between building the request and reading the reply — becomes
 * `unsupported` rather than reaching a document operation with a dangling
 * reference.
 */
export function validateLayoutInstruction(
  panels: readonly PanelSummary[],
  instruction: LayoutInstruction,
): LayoutInstruction {
  const known = new Set(panels.map((p) => p.panelId));
  if (instruction.kind === 'group') {
    const panelIds = dedupeKnown(instruction.panelIds, known);
    if (panelIds.length >= 2) return { ...instruction, panelIds };
    return {
      kind: 'unsupported',
      reason: 'The assistant named panels this figure does not have, or fewer than two.',
    };
  }
  if (instruction.kind === 'resize') {
    if (known.has(instruction.panelId)) return instruction;
    return {
      kind: 'unsupported',
      reason: 'The assistant named a panel this figure does not have.',
    };
  }
  return instruction;
}

function fromWireInstruction(wire: LayoutInstructionResult): LayoutInstruction {
  const reason = wire.reason || 'No reason was given.';
  if (wire.kind === 'group' && wire.panelIds && wire.panelIds.length >= 2) {
    return { kind: 'group', panelIds: wire.panelIds, reason };
  }
  if (
    wire.kind === 'resize' &&
    wire.panelId &&
    (wire.direction === 'bigger' || wire.direction === 'smaller')
  ) {
    return { kind: 'resize', panelId: wire.panelId, direction: wire.direction, reason };
  }
  // Anything else — including a 'group'/'resize' reply missing the fields
  // that shape requires — is exactly as unsupported as the server saying so
  // outright. The server already makes this guarantee; this is what makes
  // the client's type honest without trusting it blindly.
  return { kind: 'unsupported', reason };
}

/**
 * The real implementation, calling the service through `api.ts`. Every
 * production caller gets this one — `LayoutAssistant` exists as an interface
 * for testability, not because there are two real backends to choose
 * between (unlike `ProjectFileSystem`'s genuine browser-vs-desktop split).
 */
export function httpLayoutAssistant(): LayoutAssistant {
  return {
    async suggestGrouping(panels) {
      const result = await suggestPanelGroupingOverHttp({ panels: panels.map(toWirePanel) });
      return validateGroupingSuggestion(panels, { groups: result.groups });
    },
    async interpretInstruction(instruction, panels) {
      const result = await interpretLayoutInstructionOverHttp({
        instruction,
        panels: panels.map(toWirePanel),
      });
      return validateLayoutInstruction(panels, fromWireInstruction(result));
    },
  };
}
