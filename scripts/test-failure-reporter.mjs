import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_LOCATIONS = 20;
const MAX_COORDINATE = 10_000_000;

export default async function* reportTestFailures(source) {
  const seen = new Set();
  for await (const event of source) {
    if (seen.size >= MAX_LOCATIONS) continue;
    const location = failureLocation(event);
    if (!location) continue;
    const record = JSON.stringify(location);
    if (seen.has(record)) continue;
    seen.add(record);
    yield "[qqfriend-test-failure] " + record + "\n";
  }
}

function failureLocation(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || event.type !== "test:fail") return null;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { file, line, column } = data;
  if (typeof file !== "string" || !file || file.includes("\0")) return null;
  if (!validCoordinate(line) || !validCoordinate(column)) return null;

  const relative = path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join("/");
  if (!safeRelativeTestFile(relative)) return null;
  return { file: relative, line, column };
}

function safeRelativeTestFile(relative) {
  return relative.length <= 240 && !relative.includes("..") &&
    /^test\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:mjs|js)$/.test(relative) &&
    !relative.split("/").some(part => part === "." || part === "..");
}

function validCoordinate(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_COORDINATE;
}
