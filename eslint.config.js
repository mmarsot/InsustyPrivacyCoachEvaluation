import eslint from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["cache/**", "runs/**"],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs", "**/*.js"],
    languageOptions: {
      parser,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      // noUncheckedIndexedAccess types every indexed read as possibly
      // undefined; in this harness `row[i]!` asserts an index the loop or the
      // dataset already guarantees, so the warning would fire on hundreds of
      // correct reads and hide the ones worth reading.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "error",
      // `_`-prefixed parameters fill a callback's signature, and
      // `{ field: _, ...rest }` is how the code drops a field from a copy.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-undef": "off",
    },
  },
  {
    // The document writers strip the control characters XML 1.0 forbids, so
    // their regular expressions name those characters on purpose.
    files: ["src/docbench/writers/**/*.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
];
