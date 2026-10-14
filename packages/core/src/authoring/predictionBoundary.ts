import type { InstructionFile } from "../model/types.js";

/**
 * Port of Rust Session::guide_through: truncate effects at the cursor, keeping
 * every component's selection, dependency graph and metadata intact. The
 * caller must use a prediction engine that accepts empty selected effect lists.
 * This function does not invoke an installer or change filesystem state.
 */
export function guideThroughAction(
  file: InstructionFile,
  component: number,
  instructions: number,
): InstructionFile {
  if (!Number.isSafeInteger(component) || component < 0 || component >= file.mods.length) {
    throw new Error("Component is out of range");
  }
  const selected = file.mods[component]!;
  if (!Number.isSafeInteger(instructions) || instructions < 0 || instructions > selected.instructions.length) {
    throw new Error("Instruction is out of range");
  }
  const guide = structuredClone(file);
  guide.mods[component]!.instructions.length = instructions;
  for (const future of guide.mods.slice(component + 1)) future.instructions = [];
  return guide;
}
