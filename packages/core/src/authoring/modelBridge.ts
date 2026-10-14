/** Keep canonical Rust JSON authoritative; TS fields are an editor projection. */
import { createInstructionFile } from '../model/defaults.js';
import type { InstructionFile } from '../model/types.js';
import { createLenientContext, finishLenient, modFromRecord } from '../serialization/lenient.js';
import { decodeRustAuthoringGuide, normalizeRustAuthoringGuide, validateRustAuthoringGuide, type RustAuthoringGuide } from './transactions.js';

export function projectRustAuthoringGuide(value:unknown, normalizeInput=true):{file:InstructionFile;warnings:string[]} {
  const guide=normalizeInput ? normalizeRustAuthoringGuide(value) : decodeRustAuthoringGuide(value);
  validateRustAuthoringGuide(guide);
  const context=createLenientContext();
  const file=createInstructionFile({mods:guide.thisMod.map((component,index)=>modFromRecord(component,context,index))});
  file.rustAuthoringGuide=structuredClone(guide);
  file.metadata=Object.fromEntries(Object.entries(guide).filter(([key])=>key!=='thisMod'));
  return {file,warnings:finishLenient(context)};
}
/** Never reconstruct Rust provenance/resources/nested options from the lossy TS projection. */
export function requireRustAuthoringGuide(file:InstructionFile):RustAuthoringGuide {
  if(file.rustAuthoringGuide===undefined)throw new Error('Load a Rust authoring guide before applying authoring operations');
  return decodeRustAuthoringGuide(file.rustAuthoringGuide);
}
