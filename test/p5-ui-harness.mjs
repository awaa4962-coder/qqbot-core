import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import vm from "node:vm";

export const flush = () => setImmediate();
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const root = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));

export class Element {
  constructor(tag = "div", id = "") {
    this.tagName = tag; this.id = id; this.value = ""; this.checked = false; this.dataset = {}; this.attributes = {};
    this.children = []; this.listeners = new Map(); this.disabled = false; this.hidden = false; this.selectors = new Map(); this.style = { setProperty() {} };
    this.classes = new Set(); this._text = ""; this._html = "";
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name), toggle: (name, yes) => { if (yes ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(" "); }
  set textContent(value) { this._text = String(value); this._html = ""; this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this._text = ""; this.children = []; }
  append(...children) { this.children.push(...children); if (this.tagName === "select" && !this.value) this.value = children[0]?.value || ""; }
  replaceChildren(...children) { this._text = ""; this._html = ""; this.children = []; if (this.tagName === "select") this.value = ""; this.append(...children); }
  insertRow() { const row = new Element("tr"); row.cells = row.children; this.append(row); return row; }
  insertCell() { const cell = new Element("td"); this.append(cell); return cell; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async fire(type, value = {}) { for (const callback of this.listeners.get(type) || []) await callback({ preventDefault() {}, target: this, ...value }); }
  querySelector(selector) { if (!this.selectors.has(selector)) this.selectors.set(selector, new Element("button")); return this.selectors.get(selector); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(",").includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
  closest() { return this.querySelector("parent"); }
  focus() {}
}

export function consoleHarness() {
  const nodes = new Map(); const selectors = new Map(); const listeners = new Map(); const windowListeners = new Map(); const observers = [];
  const calls = []; const confirmations = []; const confirmationAnswers = []; const events = []; const session = new Map(); const timers = new Map(); let timerId = 0;
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(/(?:Scope|Status|Type|Case|Review|Compare|Topic|Revision|Days|Model|Protocol|Preset|Auth)$/.test(id) ? "select" : "div", id));
    nodes.get(id).ownerDocument = document;
    return nodes.get(id);
  };
  const select = selector => { if (!selectors.has(selector)) selectors.set(selector, new Element("button")); return selectors.get(selector); };
  const apiRows = ["group_chat", "private_chat"].map(task => {
    const row = new Element("article"); row.dataset.apiTask = task;
    for (const name of ["primary", "fallback", "reasoning"]) row.selectors.set(`[data-route-${name}]`, new Element("select"));
    if (task === "group_chat") row.querySelector("[data-route-fallback]").setAttribute("data-protected", "");
    return row;
  });
  const editors = [];
  const document = {
    body: new Element(), documentElement: new Element(), visibilityState: "visible", getElementById: get, createElement: tag => {
      const node = new Element(tag); node.ownerDocument = document; return node;
    },
    querySelector(selector) { return select(selector); },
    querySelectorAll(selector) {
      if (selector === "[data-list-editor-for]") return editors;
      if (selector === "[data-api-task]") return apiRows;
      if (selector === "[data-route-reasoning]:not(:disabled)") return apiRows.map(row => row.querySelector("[data-route-reasoning]")).filter(node => !node.disabled);
      if (selector.startsWith("[data-action=")) return [select(selector)];
      return [];
    },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
  };
  const host = { mode: "browser", onEvent() {}, async call(action, payload) { calls.push({ action, payload }); return reply(action, payload); } };
  let reply = () => { throw new Error("Unexpected mocked host action"); };
  const window = {
    QQFriendHost: host, URLSearchParams, confirm(message) { confirmations.push(message); return confirmationAnswers.shift() ?? true; }, prompt: () => "",
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, String(value)), removeItem: key => session.delete(key) },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); if (ms < 10000) Promise.resolve().then(() => { if (timers.delete(id)) callback(); }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {}, scrollTo() {},
    addEventListener(type, callback) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(callback); },
    dispatchEvent(event) { events.push(event); for (const callback of windowListeners.get(event.type) || []) callback(event); },
  };
  const context = vm.createContext({ window, document, URL, MutationObserver: class { constructor(callback) { this.callback = callback; } observe(target) { observers.push({ target, callback: this.callback }); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  const modules = new Map();
  const load = filename => {
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), { context, identifier: filename }));
    return modules.get(filename);
  };
  get("memoryScope").value = "group"; get("memoryGroup").value = "2000000001"; get("memoryUser").value = "1000000002"; get("memoryTtl").value = "30";
  get("apiUsageDays").value = "7"; get("traceStatus").value = "all";
  return {
    host, window, document, context, get, select, calls, session, events, editors, apiRows, confirmations, confirmationAnswers,
    setReply(fn) { reply = fn; },
    runHost() { vm.runInContext(fs.readFileSync(path.join(root, "host-client.js"), "utf8"), context); return window.QQFriendHost; },
    fireTimer(ms) { const timer = [...timers].find(([, value]) => value.ms === ms); if (!timer) throw new Error("Expected timer missing: " + ms); timers.delete(timer[0]); timer[1].callback(); },
    show(view, visible = true) {
      const target = select(`[data-view-panel="${view}"]`); target.hidden = !visible;
      observers.filter(observer => observer.target === target).forEach(observer => observer.callback());
    },
    click(attribute, action) {
      for (const callback of listeners.get("click") || []) callback({ target: { closest: selector => selector === `[${attribute}]` ? { dataset: { [attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]: action } } : null } });
    },
    async imports(names) {
      const entry = new vm.SourceTextModule(names.map((name, index) => `import * as m${index} from ${JSON.stringify("./" + name)}; export {m${index}};`).join("\n"), { context, identifier: path.join(root, "p5-test-entry.js") });
      await entry.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
      await entry.evaluate(); return names.map((_, index) => entry.namespace["m" + index]);
    },
  };
}
