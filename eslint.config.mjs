import eslint from "@eslint/js";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/bin/**",
      "**/obj/**",
      "artifacts/**",
      "eng/scripts/fixtures/**"
    ]
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ["src/clients/desktop/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='nodeIntegration'][value.value=true]",
          message: "Electron nodeIntegration must remain disabled."
        },
        {
          selector: "Property[key.name='contextIsolation'][value.value=false]",
          message: "Electron contextIsolation must remain enabled."
        }
      ]
    }
  },
  {
    files: ["src/clients/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "fs", message: "Renderer must use the preload boundary." },
            { name: "node:fs", message: "Renderer must use the preload boundary." },
            { name: "child_process", message: "Renderer must use the preload boundary." },
            { name: "node:child_process", message: "Renderer must use the preload boundary." }
          ]
        }
      ]
    }
  },
  {
    files: ["src/clients/desktop/src/renderer/csp.test.ts"],
    rules: {
      // This test reads the renderer HTML fixture; production renderer modules
      // remain covered by the complete restricted-import rule above.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "fs", message: "Renderer must use the preload boundary." },
            { name: "child_process", message: "Renderer must use the preload boundary." },
            { name: "node:child_process", message: "Renderer must use the preload boundary." }
          ]
        }
      ]
    }
  }
];
