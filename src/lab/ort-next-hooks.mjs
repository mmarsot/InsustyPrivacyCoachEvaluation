// Module resolution hooks for lab workers that run a candidate model on a
// newer onnxruntime-web (package alias `onnxruntime-web-next`): the
// Transformers.js imports of `onnxruntime-node` (aliased to onnxruntime-web
// in package.json) and `onnxruntime-common` resolve to that version instead.
const root = new URL("../../node_modules/onnxruntime-web-next/", import.meta.url);
const targets = {
  "onnxruntime-node": new URL("dist/ort.node.min.mjs", root).href,
  "onnxruntime-web": new URL("dist/ort.node.min.mjs", root).href,
  "onnxruntime-common": new URL("node_modules/onnxruntime-common/dist/esm/index.js", root).href,
};
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(targets, specifier)) return { url: targets[specifier], shortCircuit: true };
  return next(specifier, context);
}
