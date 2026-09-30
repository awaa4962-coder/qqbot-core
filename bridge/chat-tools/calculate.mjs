import jsep from "jsep";

const MAX_CHARS = 256;
const MAX_NODES = 128;
const MAX_DEPTH = 32;
const MAX_MAGNITUDE = 1e100;
const MAX_EXPONENT = 100;
const BINARY_OPERATORS = new Set(["+", "-", "*", "/", "%", "**"]);
const NUMERIC_LITERAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;
const FUNCTIONS = new Map([
  ["abs", { run: Math.abs, min: 1, max: 1 }],
  ["min", { run: Math.min, min: 1, max: 16 }],
  ["max", { run: Math.max, min: 1, max: 16 }],
  ["round", { run: Math.round, min: 1, max: 1 }],
  ["sqrt", { run: Math.sqrt, min: 1, max: 1 }],
]);

class CalculationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function reject(reason) {
  throw new CalculationError(reason);
}

export function calculate(args) {
  try {
    const expression = readExpression(args);
    checkTokens(expression);
    const ast = parseExpression(expression);
    const value = evaluate(ast, { nodes: 0 }, 1);
    const result = Object.is(value, -0) ? 0 : value;
    return { status: "ok", expression, result, text: `${expression} = ${result}` };
  } catch (error) {
    return { status: "invalid_arguments", reason: error instanceof CalculationError ? error.reason : "invalid_arguments" };
  }
}

function readExpression(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return reject("invalid_arguments");
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) return reject("invalid_arguments");
  const keys = Reflect.ownKeys(args);
  const descriptor = Object.getOwnPropertyDescriptor(args, "expression");
  if (keys.length !== 1 || keys[0] !== "expression" || typeof descriptor?.value !== "string") {
    return reject("invalid_arguments");
  }
  if (descriptor.value.length > MAX_CHARS) return reject("expression_too_long");
  const expression = descriptor.value.trim();
  if (!expression) return reject("empty_expression");
  return expression;
}

function parseExpression(expression) {
  try {
    return jsep(expression);
  } catch {
    return reject("invalid_expression");
  }
}

function checkTokens(expression) {
  const tokens = /[ \t\r\n]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*|[+\-*/%(),]/gy;
  let position = 0;
  let previous = "";
  let nesting = 0;
  while (position < expression.length) {
    tokens.lastIndex = position;
    const match = tokens.exec(expression);
    if (!match) reject("unsupported_syntax");
    position = tokens.lastIndex;
    const token = match[0];
    if (/^[ \t\r\n]+$/.test(token)) continue;
    const kind = tokenKind(token);
    checkTokenAdjacency(kind, previous);
    nesting = nextNesting(token, nesting);
    previous = kind;
  }
  if (nesting !== 0) reject("invalid_expression");
}

function tokenKind(token) {
  if (/^[\d.]/.test(token)) return "number";
  if (/^[A-Za-z_]/.test(token)) return "identifier";
  return token;
}

function checkTokenAdjacency(kind, previous) {
  const operand = kind === "number" || kind === "identifier";
  // Jsep accepts space-separated call arguments; require explicit commas.
  if (operand && ["number", "identifier", ")"].includes(previous)) reject("invalid_expression");
  if (kind === "(" && ["number", ")"].includes(previous)) reject("invalid_expression");
}

function nextNesting(token, nesting) {
  if (token === "(") {
    nesting++;
    if (nesting > MAX_DEPTH) return reject("depth_limit");
  } else if (token === ")") {
    nesting--;
    if (nesting < 0) return reject("invalid_expression");
  }
  return nesting;
}

function visit(node, budget, depth) {
  if (!node || typeof node !== "object") reject("unsupported_syntax");
  if (depth > MAX_DEPTH) reject("depth_limit");
  if (++budget.nodes > MAX_NODES) reject("node_limit");
}

function boundedNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return reject("non_finite_result");
  if (Math.abs(value) > MAX_MAGNITUDE) return reject("number_out_of_range");
  return value;
}

function evaluate(node, budget, depth) {
  visit(node, budget, depth);
  switch (node.type) {
    case "Literal": return evaluateLiteral(node);
    case "UnaryExpression": return evaluateUnary(node, budget, depth);
    case "BinaryExpression": return evaluateBinary(node, budget, depth);
    case "CallExpression": return evaluateCall(node, budget, depth);
    default:
      return reject("unsupported_syntax");
  }
}

function evaluateLiteral(node) {
  if (typeof node.value !== "number" || typeof node.raw !== "string") return reject("unsupported_syntax");
  const match = NUMERIC_LITERAL.exec(node.raw);
  if (!match) return reject("unsupported_syntax");
  if (match[1] !== undefined && Math.abs(Number(match[1])) > MAX_EXPONENT) return reject("exponent_out_of_range");
  return boundedNumber(node.value);
}

function evaluateUnary(node, budget, depth) {
  if (node.operator !== "+" && node.operator !== "-") return reject("unsupported_syntax");
  const argument = evaluate(node.argument, budget, depth + 1);
  return boundedNumber(node.operator === "-" ? -argument : argument);
}

function evaluateBinary(node, budget, depth) {
  if (!BINARY_OPERATORS.has(node.operator)) return reject("unsupported_syntax");
  const left = evaluate(node.left, budget, depth + 1);
  const right = evaluate(node.right, budget, depth + 1);
  return boundedNumber(binaryResult(node.operator, left, right));
}

function evaluateCall(node, budget, depth) {
  visit(node.callee, budget, depth + 1);
  if (node.callee.type !== "Identifier" || node.optional) return reject("unsupported_syntax");
  const fn = FUNCTIONS.get(node.callee.name);
  if (!fn) return reject("unknown_function");
  if (!Array.isArray(node.arguments) || node.arguments.length < fn.min || node.arguments.length > fn.max) {
    return reject("invalid_arity");
  }
  const values = node.arguments.map(argument => evaluate(argument, budget, depth + 1));
  return boundedNumber(fn.run(...values));
}

function binaryResult(operator, left, right) {
  switch (operator) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/":
      if (right === 0) return reject("division_by_zero");
      return left / right;
    case "%":
      if (right === 0) return reject("division_by_zero");
      return left % right;
    case "**":
      if (Math.abs(right) > MAX_EXPONENT) return reject("exponent_out_of_range");
      return left ** right;
    default:
      return reject("unsupported_syntax");
  }
}
