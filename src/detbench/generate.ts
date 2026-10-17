/**
 * Generated text for large cases (`generated` in a dataset line).
 *
 * A placeholder listed under `generated` renders as plain text built by a
 * named generator here, so a case of thousands of spreadsheet rows stays one
 * short line on disk. Generators are pure arithmetic on the row number: the
 * same parameters always give the same text. Generated text holds no item and
 * no labelled decoy; every detection inside it counts as a false positive.
 * Changing a generator changes every case that uses it, so add a new name
 * instead.
 */
import type { DetGenerated } from "./schema.ts";

/** Status cells that read as US state codes or short words (`ok`, `in`, `me`, `or`, `de`, `la`...). */
const EN_STATUS = [
  "ok",
  "in",
  "me",
  "or",
  "ok",
  "shipped",
  "on hold",
  "OK",
  "IN",
  "de",
  "la",
  "pa",
];
const FR_STATUS = [
  "ok",
  "en cours",
  "la",
  "de",
  "livré",
  "ok",
  "en stock",
  "le",
  "à relancer",
  "OK",
];
const FR_ITEMS = [
  "Palettes bois",
  "Vis inox M6",
  "Carton de rangement",
  "Gaine technique",
  "Rouleau adhésif",
  "Plaque de plâtre",
  "Joint silicone",
];

/** Word pools for `gpu_report`: public GPU API vocabulary, no machine data. */
const GPU_VERBS = [
  "emulate",
  "disable",
  "limit",
  "force",
  "avoid",
  "clamp",
  "reset",
  "split",
  "promote",
  "flush",
  "rewrite",
  "expose",
  "keep",
];
const GPU_NOUNS = [
  "Texture",
  "Buffer",
  "Framebuffer",
  "Renderbuffer",
  "Sampler",
  "Shader",
  "Varyings",
  "Uniform",
  "Pixel",
  "Query",
  "Fence",
  "Surface",
  "Mipmap",
];
/** Half of them mix digits into a word (`2D`, `To1MB`, `RGBA4`), the shapes `main` reads as a secret; the others are plain words. */
const GPU_SHAPES = [
  "2D",
  "Copy",
  "To1MB",
  "Clear",
  "RGBA4",
  "Storage",
  "16Bit",
  "Blit",
  "Float32",
  "Readback",
  "Glsl400",
  "Level0Pbo",
  "Init",
  "ESSL3",
  "Dxt1",
  "Swizzle",
];
const DAWN_FORMATS = [
  "depth16unorm",
  "rgb9e5ufloat",
  "t2b2t",
  "bgra8unorm",
  "depth32float",
  "rg11b10ufloat",
  "stencil8",
  "r8unorm",
  "depth",
  "srgb",
  "stencil",
  "color",
];
const DAWN_NOUNS = [
  "texture",
  "buffer",
  "storage",
  "sampler",
  "attachment",
  "workgroup",
];
const GPU_EXTENSIONS = [
  "GL_EXT_texture_sRGB_decode",
  "GL_EXT_texture_compression_s3tc_srgb",
  "GL_OES_texture_half_float_linear",
  "GL_EXT_sRGB_write_control",
  "GL_KHR_texture_compression_astc_ldr",
  "GL_ANGLE_framebuffer_multisample",
  "EGL_KHR_gl_texture_2D_image",
  "EGL_EXT_image_dma_buf_import_modifiers",
  "VK_KHR_shader_float16_int8",
  "VK_EXT_external_memory_dma_buf",
  "VK_FORMAT_A2B10G10R10_UNORM_PACK32",
  "GL_COMPRESSED_RGBA_S3TC_DXT5_EXT",
  "GL_OES_texture_storage_multisample_2d_array",
  "VK_KHR_sampler_ycbcr_conversion",
];
/** Uppercase environment names with plain values, as about:gpu prints them. */
const GPU_ENV: [string, string][] = [
  ["XDG_SESSION_TYPE", "wayland"],
  ["XDG_CURRENT_DESKTOP", "ubuntu:GNOME"],
  ["GDMSESSION", "ubuntu"],
  ["DESKTOP_SESSION", "ubuntu-xorg"],
  ["MESA_LOADER_DRIVER_OVERRIDE", "iris"],
  ["__GLX_VENDOR_LIBRARY_NAME", "mesa"],
  ["LIBVA_DRIVER_NAME", "iHD"],
  ["WAYLAND_DISPLAY", "wayland-0"],
  ["Ozone platform", "wayland"],
  ["Display type", "ANGLE_OPENGL"],
  ["Skia Backend", "GaneshGL"],
  ["Sandboxed", "false"],
];
const GPU_PROSE = [
  "Use a blit instead of a copy command to copy the stencil aspect of a texture.",
  "Clears the resource to zero on first use so that no stale data is read.",
  "Some drivers cannot recover after a lost context; exit the GPU process instead.",
  "Disable index clamping on runtime-sized arrays in the shader compiler.",
  "Emulate the copy with a render pass on drivers that report the wrong format.",
];
const hex4 = (x: number) => (x % 65536).toString(16).padStart(4, "0");

/**
 * Generators by name. `orders_tsv` mirrors the spreadsheet of the document-
 * upload research (`ORD-0-10000⇥Customer 230⇥35000⇥note 10000⇥ok`): from row
 * 10000 on, the amount and the note number have five digits and sit next to
 * short status cells. `commandes_tsv` is a French order export: quantity,
 * item, five-digit amount in cents, status. `gpu_report` is a Chrome
 * about:gpu-like report, 12 line shapes in turn: ANGLE workarounds and
 * features (camelCase, digits mixed into words in half of them), Dawn toggles
 * (snake_case with format names such as `depth16unorm`), WebGPU features
 * (kebab-case), extension lists, uppercase environment names with plain
 * values, `GPU0 : VENDOR= 0x…` lines, crbug links and prose.
 */
export const GENERATORS: Record<string, (row: number) => string> = {
  orders_tsv: (n) =>
    `ORD-0-${n}\tCustomer ${n % 977}\t${(n * 7) / 2}\tnote ${n}\t${EN_STATUS[n % EN_STATUS.length]}`,
  commandes_tsv: (n) =>
    `CMD-${n}\t${(n % 48) + 2}\t${FR_ITEMS[n % FR_ITEMS.length]}\t${10000 + ((n * 37) % 89999)}\t${FR_STATUS[n % FR_STATUS.length]}`,
  gpu_report: (n) => {
    const k = Math.floor(n / 12);
    const pick = <T>(list: readonly T[], salt: number, step = 7) =>
      list[(k * step + salt) % list.length]!;
    const camel = (salt: number) =>
      `${pick(GPU_VERBS, salt)}${pick(GPU_NOUNS, salt + 3, 5)}${pick(GPU_SHAPES, salt + 5, 3)}${pick(GPU_NOUNS, salt + 8, 2)}`;
    switch (n % 12) {
      case 0:
        return `*   ${camel(0)} (OpenGL workarounds): Disabled`;
      case 1:
        return `    ${pick(GPU_PROSE, 1)}`;
      case 2:
        return `*   use_${pick(DAWN_NOUNS, 2)}_for_${pick(DAWN_FORMATS, 2)}_${pick(DAWN_NOUNS, 5, 5)}_copy: `;
      case 3:
        return `    (https://crbug.com/${40000000 + ((n * 7919) % 9999999)}):`;
      case 4:
        return `*   ${pick(DAWN_FORMATS, 4)}-${pick(["renderable", "filterable", "for-external-texture", "storage-binding"], 4, 3)}`;
      case 5: {
        const [name, value] = pick(GPU_ENV, 5);
        return `${name.padEnd(32)}: ${value}`;
      }
      case 6:
        return `*   ${camel(6)} (Frontend features): Enabled`;
      case 7:
        return [0, 1, 2, 3, 4, 5]
          .map((i) => pick(GPU_EXTENSIONS, i * 5, 3))
          .join(" ");
      case 8:
        return `GPU${k % 2}${" ".repeat(28)}: VENDOR= 0x${hex4(k * 40503 + 4096)}, DEVICE=0x${hex4(k * 9973 + 513)}, DRIVER_VENDOR=Mesa, DRIVER_VERSION=2${k % 7}.${k % 4}.${k % 9}`;
      case 9:
        return `*   ${camel(9)} (Vulkan workarounds): Enabled`;
      case 10:
        return "";
      default:
        return `    ${pick(GPU_PROSE, 11)}`;
    }
  },
};

/** Rows `from` .. `from + count - 1`, one per line, no trailing newline. */
export function generateText(spec: DetGenerated): string {
  const generator = GENERATORS[spec.generator];
  if (!generator) throw new Error(`unknown generator ${spec.generator}`);
  const rows: string[] = [];
  for (let n = spec.from; n < spec.from + spec.count; n++)
    rows.push(generator(n));
  return rows.join("\n");
}

/** Largest `count` a dataset line may ask for (bench runtime grows linearly with it). */
export const MAX_GENERATED_ROWS = 20000;
