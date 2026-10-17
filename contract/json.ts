/**
 * The JSON form of contract values (`contract/redaction-contract.schema.json`):
 * byte arrays become `{ size, sha256 }`, plus `base64` when the record must
 * carry the bytes themselves.
 */
import { createHash } from "node:crypto";
import type { RedactionInput, RedactionOutput } from "./types.ts";

/**
 * Bytes in a JSON record: the size and SHA-256 always, the content (`base64`)
 * only when the record must reproduce the file.
 */
export interface JsonBytes {
  size: number;
  sha256: string;
  base64?: string;
}

/** The JSON form of a byte array; `withBytes` embeds the content too. */
export const jsonBytes = (bytes: Uint8Array, withBytes = false): JsonBytes => ({
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  ...(withBytes ? { base64: Buffer.from(bytes).toString("base64") } : {}),
});

/** The JSON form of a `RedactionInput`, for records and the schema check. */
export function inputToJson(input: RedactionInput, withBytes = false): unknown {
  return input.kind === "text"
    ? input
    : {
        kind: "document",
        name: input.name,
        bytes: jsonBytes(input.bytes, withBytes),
      };
}

/**
 * The JSON form of a `RedactionOutput`: the redacted file's bytes become
 * `JsonBytes`, everything else is already JSON.
 */
export function outputToJson(
  output: RedactionOutput,
  withBytes = false,
): unknown {
  const { file, ...redaction } = output.redaction;
  return {
    ...output,
    redaction: {
      ...redaction,
      ...(file
        ? {
            file: {
              name: file.name,
              type: file.type,
              bytes: jsonBytes(file.bytes, withBytes),
            },
          }
        : {}),
    },
  };
}
