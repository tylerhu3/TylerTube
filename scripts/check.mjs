// Fast static check (no build): parses all source, flags undefined identifiers,
// unused imports/top-level bindings and unresolvable relative imports.
// Run: npm run check  (uses @babel/* already installed via @vitejs/plugin-react)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const ROOTS = ["src", "server", "scripts", "tests", "vite.config.js"];
const EXTS = [".js", ".jsx", ".mjs"];
const BROWSER_AND_NODE_GLOBALS = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  "window", "document", "navigator", "localStorage", "location", "screen",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia",
  "ResizeObserver", "IntersectionObserver", "MutationObserver", "HTMLElement", "Element",
  "Image", "Audio", "AudioContext", "webkitAudioContext", "alert", "self",
  "process", "Buffer", "__dirname", "__filename",
  "__APP_VERSION__", "__BUILD_TIME__", "__BUILD_CODE__", "__GIT_COMMIT__"
]);

function listFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return EXTS.includes(path.extname(p)) ? [p] : [];
  return fs.readdirSync(p).flatMap((n) => (n.startsWith(".") ? [] : listFiles(path.join(p, n))));
}

function resolves(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  return [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, "index" + e))]
    .some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

let problems = 0;
const report = (f, msg) => { problems++; console.log(`${f}: ${msg}`); };

for (const file of ROOTS.filter((r) => fs.existsSync(r)).flatMap(listFiles)) {
  let ast;
  try {
    ast = parser.parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["jsx"] });
  } catch (e) {
    report(file, `parse error: ${e.message}`);
    continue;
  }
  traverse(ast, {
    Program(p) {
      const undef = Object.keys(p.scope.globals).filter((n) => !BROWSER_AND_NODE_GLOBALS.has(n));
      if (undef.length) report(file, `undefined: ${undef.join(", ")}`);
      const unused = Object.entries(p.scope.bindings)
        .filter(([name, b]) => !b.referenced && name !== "React" &&
          !b.path.findParent((q) => q.isExportNamedDeclaration() || q.isExportDefaultDeclaration()))
        .map(([name]) => name);
      if (unused.length) report(file, `unused: ${unused.join(", ")}`);
    },
    ImportDeclaration(p) {
      const spec = p.node.source.value;
      if (spec.startsWith(".") && !resolves(file, spec)) report(file, `cannot resolve import "${spec}"`);
    }
  });
}

console.log(problems ? `\n${problems} problem(s)` : "check: ok");
process.exitCode = problems ? 1 : 0;
