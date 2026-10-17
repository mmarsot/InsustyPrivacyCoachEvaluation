/**
 * The JSON form of contract values (`contract/redaction-contract.schema.json`):
 * byte arrays become `{ size, sha256 }`, plus `base64` when the record must
 * carry the bytes themselves.
 */
import { createHash } from "node:crypto";
import type { RedactionInput, RedactionOutput } from "./types.ts";

export interface JsonBytes {
  size: number;
  sha256: string;
  base64?: string;
}

export const jsonBytes = (bytes: Uint8Array, withBytes = false): JsonBytes => ({
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  ...(withBytes ? { base64: Buffer.from(bytes).toString("base64") } : {}),
});

export function inputToJson(input: RedactionInput, withBytes = false): unknown {
  return input.kind === "text" ? input : { kind: "document", name: input.name, bytes: jsonBytes(input.bytes, withBytes) };
}

export function outputToJson(output: RedactionOutput, withBytes = false): unknown {
  const { file, ...redaction } = output.redaction;
  return {
    ...output,
    redaction: { ...redaction, ...(file ? { file: { name: file.name, type: file.type, bytes: jsonBytes(file.bytes, withBytes) } } : {}) },
  };
}
