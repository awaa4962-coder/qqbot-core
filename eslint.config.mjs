// eslint.config.mjs — 夜星桥接器代码质量基线
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["bridge/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        URL: "readonly",
        JSON: "readonly",
        Date: "readonly",
        Math: "readonly",
        Promise: "readonly",
        AbortController: "readonly",
      },
    },
    rules: {
      // 必须 error 的规则（运行错误级别）
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": "error",
      "no-duplicate-imports": "error",
      "no-irregular-whitespace": "error",
      "no-empty": ["error", { "allowEmptyCatch": true }],

      // 代码质量（warn 级别，不阻断）
      eqeqeq: "warn",
      "no-shadow": "warn",
      "consistent-return": "warn",
      "no-var": "warn",
      "prefer-const": "warn",
      "no-throw-literal": "error",
      
      // 复杂度警告
      complexity: ["warn", 15],
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
    },
  },
  // 辅助脚本宽松一点
  {
    files: ["gen_*.mjs", "test_*.mjs", "debug_*.mjs", "search_*.mjs", "daily_summary.mjs"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
    },
  },
  // 忽略
  {
    ignores: [
      "node_modules/**",
      "NapCat/**",
      "*.json",
      "logs/**",
    ],
  },
];
