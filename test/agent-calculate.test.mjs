import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jsep from "jsep";
import { calculate } from "../bridge/chat-tools/calculate.mjs";

function expectOk(expression, expected) {
  const result = calculate({ expression });
  assert.deepEqual(result, {
    status: "ok", expression: expression.trim(), result: expected,
    text: `${expression.trim()} = ${expected}`,
  });
  assert.equal(typeof result.result, "number");
  assert.equal(Number.isFinite(result.result), true);
  assert.equal(result instanceof Promise, false);
  return result;
}

function expectInvalid(expression, reason) {
  const result = calculate({ expression });
  assert.equal(result.status, "invalid_arguments", expression);
  assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
  assert.match(result.reason, /^[a-z][a-z0-9_]*$/);
  if (reason) assert.equal(result.reason, reason, expression);
  return result;
}

describe("Agent calculate numerical arithmetic", () => {
  it("returns a synchronous, finite numeric result and readable text", () => {
    expectOk("  (12 + 8) / 4  ", 5);
    expectOk("0", 0);
    expectOk("-0", 0);
    expectOk("\t1\n+\r2 ", 3);
  });

  it("supports decimal and scientific literals", () => {
    expectOk(".5 + 1.25", 1.75);
    expectOk("1. + .5", 1.5);
    expectOk("1e3 + 2.5E-1", 1000.25);
    expectOk("3e+2 / 1.5e2", 2);
    expectOk("1e-100", 1e-100);
  });

  it("uses arithmetic precedence, parentheses and right-associative powers", () => {
    expectOk("2 + 3 * 4", 14);
    expectOk("(2 + 3) * 4", 20);
    expectOk("20 / 5 / 2", 2);
    expectOk("10 - 3 - 2", 5);
    expectOk("2 ** 3 ** 2", 512);
    expectOk("(2 ** 3) ** 2", 64);
    expectOk("2 ** -2", 0.25);
    expectOk("(-2) ** 2", 4);
    expectOk("-(2 ** 2)", -4);
    expectOk("2 ** .5", Math.sqrt(2));
  });

  it("supports unary plus/minus without coercion", () => {
    expectOk("+3 + -2", 1);
    expectOk("-(-3)", 3);
    expectOk("1--2", 3);
    expectOk("1 + +2", 3);
  });

  it("supports remainder and explicit percentage arithmetic", () => {
    expectOk("17 % 5", 2);
    expectOk("-17 % 5", -2);
    expectOk("17 % -5", 2);
    expectOk("200 * 15 / 100", 30);
    expectOk("100 * (1 + 20 / 100)", 120);
    expectInvalid("15%");
  });

  it("allows only the fixed functions with numeric arguments", () => {
    expectOk("abs(-3)", 3);
    expectOk("min(3, -2, 4)", -2);
    expectOk("max(3, -2, 4)", 4);
    expectOk("min(7)", 7);
    expectOk("max(7)", 7);
    expectOk("round(2.6)", 3);
    expectOk("round(-2.5)", -2);
    expectOk("sqrt(81)", 9);
    expectOk("max (abs(-8), round(sqrt(10)), 2 ** 2)", 8);
    expectOk(`max(${Array.from({ length: 16 }, (_, index) => index).join(",")})`, 15);
  });

  it("does not mutate arguments or shared jsep configuration", () => {
    const before = { binary: { ...jsep.binary_ops }, unary: { ...jsep.unary_ops }, associative: [...jsep.right_associative] };
    const args = Object.freeze({ expression: "1 + 2" });
    assert.equal(calculate(args).result, 3);
    assert.deepEqual(args, { expression: "1 + 2" });
    assert.deepEqual({ binary: { ...jsep.binary_ops }, unary: { ...jsep.unary_ops }, associative: [...jsep.right_associative] }, before);
    assert.equal(calculate(Object.assign(Object.create(null), args)).result, 3);
  });
});

describe("Agent calculate argument and syntax boundaries", () => {
  it("rejects non-object, inherited, extra-key and non-string arguments", () => {
    const invalid = [
      undefined, null, false, 3, "1 + 2", [], () => 1, {},
      { expression: null }, { expression: 3 }, { expression: true },
      { expression: ["1"] }, { expression: new String("1") },
      { expression: { toString() { throw new Error("must not coerce"); } } },
      Object.create({ expression: "1 + 2" }),
      { expression: "1", extra: true }, { expression: "1", [Symbol("extra")]: true },
    ];
    for (const args of invalid) assert.deepEqual(calculate(args), { status: "invalid_arguments", reason: "invalid_arguments" });
  });

  it("rejects accessors without calling them and masks unexpected errors", () => {
    let reads = 0;
    const args = { get expression() { reads++; throw new Error("private-marker"); } };
    assert.deepEqual(calculate(args), { status: "invalid_arguments", reason: "invalid_arguments" });
    assert.equal(reads, 0);
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private-marker"); } });
    assert.deepEqual(calculate(hostile), { status: "invalid_arguments", reason: "invalid_arguments" });
  });

  it("bounds the original input to 256 characters, including whitespace", () => {
    expectOk("1" + " ".repeat(255), 1);
    expectInvalid("1" + " ".repeat(256), "expression_too_long");
    expectInvalid("1".repeat(257), "expression_too_long");
    expectInvalid("", "empty_expression");
    expectInvalid(" \t\n\r ", "empty_expression");
  });

  it("rejects malformed, compound and implicit-multiplication input", () => {
    for (const expression of [
      "1 +", "*2", "1 /", "1e", "1e+", "1..2", ".", "()", "(1", "1)",
      "1,2", "(1,2)", "1 2", "2(3)", "(2)(3)", "sqrt(4)(2)",
      "min(1 2)", "max(1 (2))", "min(1,)", "min(,1)", "abs(1 2)",
      "0x10", "0b10", "0o10", "1_000", "1n", "1/*2*/+3", "1//2",
    ]) expectInvalid(expression);
  });

  it("bounds fixed function arity", () => {
    for (const expression of [
      "abs()", "abs(1,2)", "sqrt()", "sqrt(1,2)", "round()", "round(1,2)",
      "min()", "max()", `max(${Array(17).fill("1").join(",")})`,
      `min(${Array(17).fill("1").join(",")})`,
    ]) expectInvalid(expression, "invalid_arity");
  });
});

describe("Agent calculate sandbox", () => {
  it("rejects strings, booleans, null, arrays and objects instead of coercing", () => {
    for (const expression of [
      '"1" + 2', "'1' * 2", "true + 1", "false * 2", "null + 1", "undefined + 1",
      "[1] + 2", "{} + 1", "abs('2')", "min(true, 1)", "sqrt(null)", "round([2])",
      "`1`", "NaN", "Infinity", "-Infinity",
    ]) expectInvalid(expression);
  });

  it("rejects members, indexing, constructors, unknown names and dynamic execution", () => {
    for (const expression of [
      "Math.abs(-1)", "Math.PI", "Math['sqrt'](4)", "abs.call(null, -1)",
      "abs.constructor('return 1')()", "constructor(1)", "__proto__(1)", "toString(1)",
      "prototype(1)", "sin(1)", "pow(2,3)", "random()", "ABS(1)", "abs", "x + 1",
      "this", "globalThis", "process.env", "require('fs')", "import('fs')",
      "eval('1+2')", "Function('return 1')()", "exec('whoami')", "spawn('sh')",
      "process.exit()", "(1).constructor", "[1][0]", "abs[0]", "sqrt?.(4)",
    ]) expectInvalid(expression);
  });

  it("rejects assignment, conditions, logical, comparison and bitwise operations", () => {
    for (const expression of [
      "x = 1", "x += 1", "x++", "1;2", "1 ? 2 : 3", "1 && 2", "1 || 2", "1 ?? 2",
      "!1", "~1", "1 < 2", "1 >= 2", "1 == 1", "1 === 1", "1 != 2",
      "1 | 2", "1 & 2", "1 ^ 2", "1 << 2", "1 >> 2", "1 >>> 2", "new abs(1)",
    ]) expectInvalid(expression);
  });

  it("never leaks input or parser error details in failures", () => {
    const marker = "private_marker_123";
    for (const expression of [marker, `eval('${marker}')`, `1 + ${marker}`, `sqrt(${marker})`]) {
      const result = expectInvalid(expression);
      assert.equal(JSON.stringify(result).includes(marker), false);
    }
  });
});

describe("Agent calculate resource and numeric budgets", () => {
  it("rejects division and remainder by computed, positive or negative zero", () => {
    for (const expression of ["1 / 0", "0 / 0", "1 / -0", "1 / (2 - 2)", "1 % 0", "0 % -0"]) {
      expectInvalid(expression, "division_by_zero");
    }
  });

  it("rejects nonfinite results and out-of-range literals or intermediate results", () => {
    expectOk("1e100", 1e100);
    expectOk("-1e100", -1e100);
    expectInvalid("9e100", "number_out_of_range");
    expectInvalid("9".repeat(102), "number_out_of_range");
    expectInvalid("1e100 * 10", "number_out_of_range");
    expectInvalid("(1e100 * 10) / 10", "number_out_of_range");
    expectInvalid("1e100 / 1e-100", "number_out_of_range");
    expectInvalid("1e100 ** 100", "non_finite_result");
    expectInvalid("0 ** -1", "non_finite_result");
    expectInvalid("(-1) ** .5", "non_finite_result");
    expectInvalid("sqrt(-1)", "non_finite_result");
  });

  it("bounds both power operands and scientific-notation exponents", () => {
    expectOk("1 ** 100", 1);
    expectOk("1 ** -100", 1);
    for (const expression of ["1 ** 101", "1 ** -101", "1 ** (50 + 51)", "1e101", "1e-101", "1e9999"]) {
      expectInvalid(expression, "exponent_out_of_range");
    }
  });

  it("bounds parenthesis and function nesting before parser recursion", () => {
    expectOk("(".repeat(32) + "1" + ")".repeat(32), 1);
    expectInvalid("(".repeat(33) + "1" + ")".repeat(33), "depth_limit");
    expectOk("abs(".repeat(31) + "1" + ")".repeat(31), 1);
    expectInvalid("abs(".repeat(32) + "1" + ")".repeat(32), "depth_limit");
    expectInvalid("abs(".repeat(33) + "1" + ")".repeat(33), "depth_limit");
  });

  it("bounds AST depth even without parentheses", () => {
    expectOk("-".repeat(31) + "1", -1);
    expectInvalid("-".repeat(32) + "1", "depth_limit");
    expectInvalid("-".repeat(255) + "1", "depth_limit");
    expectOk(Array(32).fill("1").join("+"), 32);
    expectInvalid(Array(33).fill("1").join("+"), "depth_limit");
    expectInvalid(Array(34).fill("1").join("**"), "depth_limit");
  });

  it("bounds node count for wide, shallow ASTs within the character budget", () => {
    const within = `max(${Array(14).fill("1+1+1+1+1").join(",")})`;
    const over = `max(${Array(15).fill("1+1+1+1+1").join(",")})`;
    assert.ok(over.length <= 256);
    expectOk(within, 5);
    expectInvalid(over, "node_limit");
  });
});
