/**
 * Microsoft Presidio (presidio-analyzer 2.2.364, spaCy en_core_web_sm,
 * default recognizers) as a baseline behind the redaction contract. It runs
 * locally in a pinned Python environment (`modules/presidio/
 * requirements.txt`, created with uv under `cache/tmp/presidio/` on first
 * use) with its network access disabled (`server.py`). It is a baseline
 * only, never a component of the product.
 *
 * Presidio entity types map to built-in labels as in the design report
 * (§11.5): cards, IBANs, US bank numbers and crypto wallets → FINANCIAL;
 * e-mail; phone; IP and MAC → IP; national ids of every country pack →
 * NATIONAL_ID; company registers → COMPANY_ID; LOCATION → ADDRESS (its
 * closest type); DATE_TIME → DATE_OF_BIRTH only after birth words, other
 * dates are dropped (it flags every date). PERSON, ORGANIZATION, NRP, URL
 * and the rest have no built-in label and are dropped. Presidio has no
 * secret recognizer. Text input only: documents are reported unsupported.
 */
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import {
  CONTRACT_VERSION,
  type BuiltinLabel,
  type ModuleConfig,
  type RedactionModule,
  type RedactionOutput,
  type Span,
} from "../../contract/types.ts";
import { machineProfile } from "../../engine/machine.ts";
import { CACHE_DIR, MODULES_DIR } from "../../engine/paths.ts";

const DIR = join(CACHE_DIR, "tmp", "presidio");
const PYTHON = join(DIR, "venv", "bin", "python");
const REQUIREMENTS = join(MODULES_DIR, "presidio", "requirements.txt");
const SERVER = join(MODULES_DIR, "presidio", "server.py");

const TYPES: Record<string, BuiltinLabel> = {
  CREDIT_CARD: "FINANCIAL",
  IBAN_CODE: "FINANCIAL",
  US_BANK_NUMBER: "FINANCIAL",
  CRYPTO: "FINANCIAL",
  EMAIL_ADDRESS: "EMAIL",
  PHONE_NUMBER: "PHONE",
  IP_ADDRESS: "IP",
  MAC_ADDRESS: "IP",
  LOCATION: "ADDRESS",
  DE_HANDELSREGISTER: "COMPANY_ID",
  IT_VAT_CODE: "COMPANY_ID",
  AU_ABN: "COMPANY_ID",
  AU_ACN: "COMPANY_ID",
  SG_UEN: "COMPANY_ID",
  SE_ORGANISATIONSNUMMER: "COMPANY_ID",
};
/** National ids: every country pack's personal identifiers. */
const NATIONAL =
  /^(US_SSN|US_ITIN|US_PASSPORT|US_DRIVER_LICENSE|UK_NHS|UK_NINO|UK_PASSPORT|ES_NIF|ES_NIE|IT_FISCAL_CODE|IT_DRIVER_LICENSE|IT_PASSPORT|IT_IDENTITY_CARD|PL_PESEL|SG_NRIC_FIN|AU_TFN|AU_MEDICARE|IN_PAN|IN_AADHAAR|IN_VEHICLE_REGISTRATION|IN_VOTER|IN_PASSPORT|FI_PERSONAL_IDENTITY_CODE|KR_RRN|TH_TNIN|SE_PERSONNUMMER|NG_NIN|PH_[A-Z_]+|TR_[A-Z_]+|ZA_[A-Z_]+|CA_[A-Z_]+|DE_[A-Z_]+)$/;
/**
 * A birth word just before a date (at most three words between,
 * EN/FR/DE/ES/IT): only those dates are a DATE_OF_BIRTH.
 */
const BIRTH_CONTEXT =
  /(born|birth|d\.?o\.?b|né|née|naissance|geboren|nacido|nata|nato)\W{0,3}(\w+\W+){0,3}$/iu;

/**
 * The built-in labels Presidio's recognizers map to; `SECRET` is absent, as
 * Presidio has no secret recognizer.
 */
export const PRESIDIO_BUILTINS: BuiltinLabel[] = [
  "FINANCIAL",
  "NATIONAL_ID",
  "DATE_OF_BIRTH",
  "PHONE",
  "EMAIL",
  "ADDRESS",
  "IP",
  "COMPANY_ID",
];

/** Creates the pinned environment once (uv: Python 3.12 plus requirements.txt). */
export function ensurePresidio(
  log: (line: string) => void = console.log,
): string {
  if (existsSync(PYTHON)) return PYTHON;
  log(
    `creating the Presidio environment in ${DIR} (uv, Python 3.12, ${REQUIREMENTS})`,
  );
  const env = { ...process.env, UV_CACHE_DIR: join(DIR, "uv-cache") };
  execFileSync("uv", ["venv", "--python", "3.12", join(DIR, "venv")], {
    stdio: "inherit",
    env,
  });
  execFileSync(
    "uv",
    ["pip", "install", "--python", PYTHON, "-r", REQUIREMENTS],
    { stdio: "inherit", env },
  );
  return PYTHON;
}

/** The label a Presidio result maps to, or null (dropped: no built-in label). */
export function presidioLabel(
  type: string,
  text: string,
  start: number,
): BuiltinLabel | null {
  if (type === "DATE_TIME")
    return BIRTH_CONTEXT.test(text.slice(Math.max(0, start - 40), start))
      ? "DATE_OF_BIRTH"
      : null;
  return TYPES[type] ?? (NATIONAL.test(type) ? "NATIONAL_ID" : null);
}

/**
 * Starts the Presidio server (installing its environment on first use) and
 * wraps it as a contract module; `dispose` stops it.
 */
export async function presidioModule(
  log: (line: string) => void = console.log,
): Promise<RedactionModule> {
  const python = ensurePresidio(log);
  const child: ChildProcessWithoutNullStreams = spawn(python, ["-I", SERVER], {
    cwd: DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: DIR,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    },
  });
  child.stderr.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) log(`[presidio] ${line.slice(0, 300)}`);
  });
  const lines = createInterface({ input: child.stdout });
  const waiting: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  lines.on("line", (line) => waiting.shift()?.resolve(line));
  child.on("exit", (code) => {
    for (const w of waiting.splice(0))
      w.reject(new Error(`Presidio exited (${code})`));
  });
  const next = () =>
    new Promise<string>((resolve, reject) => waiting.push({ resolve, reject }));
  const ready = JSON.parse(await next()) as {
    presidio: string;
    spacy: string;
    model: string;
    python: string;
    loadMs: number;
  };
  log(
    `Presidio ${ready.presidio} (spaCy ${ready.spacy}, ${ready.model}, Python ${ready.python}) ready in ${(ready.loadMs / 1000).toFixed(1)} s, network disabled`,
  );
  const info = {
    name: "presidio",
    version: `${ready.presidio}+spacy-${ready.spacy}+${ready.model}`,
  };
  const peakRss = () => {
    try {
      return Math.round(
        Number(
          /VmHWM:\s+(\d+)/.exec(
            readFileSync(`/proc/${child.pid}/status`, "utf8"),
          )?.[1],
        ) / 1024,
      );
    } catch {
      return undefined;
    }
  };
  let id = 0;
  let queue = Promise.resolve();
  const analyze = (text: string) => {
    const run = queue.then(async () => {
      const ask = next();
      child.stdin.write(JSON.stringify({ id: ++id, text }) + "\n");
      return JSON.parse(await ask) as {
        spans: Array<{
          start: number;
          end: number;
          type: string;
          score: number;
        }>;
        ms: number;
      };
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const defaultConfig = (): ModuleConfig => ({
    builtins: Object.fromEntries(PRESIDIO_BUILTINS.map((b) => [b, true])),
    addressCountries: [],
    customLabels: [],
    privateAi: { runsOn: "off" },
    ocr: { enabled: false, languages: [] },
  });
  return {
    contract: CONTRACT_VERSION,
    info,
    capabilities: {
      builtins: PRESIDIO_BUILTINS,
      customLabels: false,
      documents: false,
      ocr: false,
      privateAi: [],
    },
    defaultConfig,
    async redact(input, config): Promise<RedactionOutput> {
      const t0 = performance.now();
      const base = { contract: CONTRACT_VERSION, module: info };
      if (input.kind === "document")
        return {
          ...base,
          text: "",
          spans: [],
          redaction: { mode: "none", leakChecked: false },
          coverage: {
            checked: "none",
            reason: "unsupported",
            gaps: [],
            ocrPages: 0,
          },
          runtime: { stages: [], totalMs: performance.now() - t0 },
        };
      const text = input.text;
      const r = text ? await analyze(text) : { spans: [], ms: 0 };
      const spans: Span[] = [];
      for (const s of r.spans) {
        const label = presidioLabel(s.type, text, s.start);
        if (!label || s.end <= s.start) continue;
        spans.push({
          start: s.start,
          end: s.end,
          label,
          kind: "builtin",
          subtype: s.type,
          source: "rules",
          redacted: config.builtins[label] !== false,
          confidence: Math.max(0, Math.min(1, s.score)),
        });
      }
      spans.sort((a, b) => a.start - b.start || b.end - a.end);
      let redacted = "";
      let cursor = 0;
      for (const s of spans.filter((x) => x.redacted)) {
        if (s.start < cursor) continue;
        redacted += `${text.slice(cursor, s.start)}[${s.label}]`;
        cursor = s.end;
      }
      const any = spans.some((s) => s.redacted);
      const totalMs = performance.now() - t0;
      return {
        ...base,
        text,
        spans,
        redaction: any
          ? {
              text: redacted + text.slice(cursor),
              mode: "in_place",
              leakChecked: false,
            }
          : { mode: "none", leakChecked: false },
        coverage: { checked: "full", gaps: [], format: "text", ocrPages: 0 },
        runtime: {
          stages: [{ stage: "rules", ms: r.ms }],
          totalMs: Math.max(totalMs, r.ms),
          ...(peakRss() !== undefined ? { peakRssMb: peakRss() } : {}),
          ...(totalMs > 0
            ? { charsPerSecond: (text.length / totalMs) * 1000 }
            : {}),
          backend: { name: "python" },
          machine: { ...machineProfile(), python: ready.python },
        },
      };
    },
    async dispose() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}
