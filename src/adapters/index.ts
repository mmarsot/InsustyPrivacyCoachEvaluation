import { gretel } from "./gretel.ts";
import { nemotron } from "./nemotron.ts";
import { tab } from "./tab.ts";
import type { BenchmarkAdapter } from "./types.ts";

/**
 * Published datasets the deterministic track scores, all under licences
 * that allow a commercial project to publish results (checked on each card
 * at the pinned revision). ai4privacy open-pii-masking-500k is deliberately
 * absent: its card puts use under the Llama 3.1/3.3 Community License and
 * says commercial use may need written permission (README, "Literature
 * benchmarks").
 */
export const ADAPTERS: BenchmarkAdapter[] = [tab, gretel, nemotron];
export const findAdapter = (id: string) =>
  ADAPTERS.find((a) => a.id === id || a.id.startsWith(id));
