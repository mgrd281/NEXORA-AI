// Structural checks for the Swift sources, for environments without a Swift toolchain
// (this does NOT replace compiling with Xcode):
//
//   node apps/ios/scripts/check-swift.mjs
//   node apps/ios/scripts/check-swift.mjs --tree-sitter <dir>   # also a full syntax parse
//
// With --tree-sitter (or TREE_SITTER_SWIFT_DIR), <dir> is a node_modules folder that has
// `tree-sitter` and `tree-sitter-swift` installed outside the repository, e.g.
//   npm install --prefix /tmp/ts tree-sitter@0.22 tree-sitter-swift@0.7.1
//   node apps/ios/scripts/check-swift.mjs --tree-sitter /tmp/ts/node_modules
// Every file must then parse without ERROR or MISSING nodes.
//
// - (), [] and {} balance outside string literals and comments (incl. interpolations
//   and multi-line strings), with the line of the first mismatch.
// - App code (Jarvis/) contains no crash-prone shortcuts: try!, as!, fatalError,
//   preconditionFailure, implicitly unwrapped optionals, print().
// - Every file under Jarvis/ and JarvisTests/ ends with a newline and uses spaces.
// - With --tree-sitter also: no SwiftUI view-builder block (a `some View` body or function,
//   or the trailing closure of a view type such as VStack, Card or Section) has more than
//   ten children, so the code doesn't depend on the iOS 17 variadic ViewBuilder.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function swiftFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith('.swift') ? [path] : [];
  });
}

/** Returns the source with strings and comments blanked out (newlines kept). */
function stripLiterals(src, file) {
  let out = '';
  let i = 0;
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  const lineAt = (index) => src.slice(0, index).split('\n').length;

  function readString(start) {
    // Supports "…", """…""" and #"…"# raw strings with \( … ) interpolation.
    let hashes = 0;
    let j = start;
    while (src[j] === '#') {
      hashes++;
      j++;
    }
    const multi = src.startsWith('"""', j);
    const quote = multi ? '"""' : '"';
    j += quote.length;
    const close = quote + '#'.repeat(hashes);
    const escape = '\\' + '#'.repeat(hashes);
    while (j < src.length) {
      if (src.startsWith(close, j)) return j + close.length;
      if (!multi && src[j] === '\n') throw new Error(`unterminated string at line ${lineAt(start)}`);
      if (src.startsWith(escape + '(', j)) {
        j += escape.length + 1;
        let depth = 1;
        while (j < src.length && depth > 0) {
          if (src[j] === '"' || (src[j] === '#' && src[j + 1] === '"')) {
            j = readString(j);
            continue;
          }
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
          j++;
        }
        continue;
      }
      if (src.startsWith(escape, j)) {
        j += escape.length + 1;
        continue;
      }
      j++;
    }
    throw new Error(`unterminated string at line ${lineAt(start)}`);
  }

  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          if (src[i] === '\n') out += '\n';
          i++;
        }
      }
      continue;
    }
    if (c === '"' || (c === '#' && /^#+"/.test(src.slice(i, i + 8)))) {
      const end = readString(i);
      out += ' "S" ' + '\n'.repeat(src.slice(i, end).split('\n').length - 1);
      i = end;
      continue;
    }
    if (pairs[c]) stack.push([c, lineAt(i)]);
    else if (c === ')' || c === ']' || c === '}') {
      const open = stack.pop();
      if (!open || pairs[open[0]] !== c) {
        problems.push(`${file}:${lineAt(i)}: unexpected "${c}"${open ? ` (open "${open[0]}" from line ${open[1]})` : ''}`);
        return out;
      }
    }
    out += c;
    i++;
  }
  for (const [c, line] of stack) problems.push(`${file}:${line}: unclosed "${c}"`);
  return out;
}

const banned = [
  [/\btry!/, 'try!'],
  [/\bas!/, 'as!'],
  [/\bfatalError\(/, 'fatalError'],
  [/\bpreconditionFailure\(/, 'preconditionFailure'],
  [/\bprint\(/, 'print()'],
  [/:\s*[A-Z]\w*!\s*(?:[=\n{])/, 'implicitly unwrapped optional'],
];

const files = [...swiftFiles(join(root, 'Jarvis')), ...swiftFiles(join(root, 'JarvisTests'))];
let lines = 0;
for (const path of files) {
  const file = relative(root, path);
  const src = readFileSync(path, 'utf8');
  lines += src.split('\n').length;
  if (!src.endsWith('\n')) problems.push(`${file}: missing final newline`);
  if (/\t/.test(src)) problems.push(`${file}: contains tabs`);
  let code;
  try {
    code = stripLiterals(src, file);
  } catch (err) {
    problems.push(`${file}: ${err.message}`);
    continue;
  }
  if (file.startsWith('Jarvis/') && !file.endsWith('Tokens.swift')) {
    code.split('\n').forEach((line, index) => {
      for (const [pattern, name] of banned) {
        if (pattern.test(line)) problems.push(`${file}:${index + 1}: ${name} is not allowed in app code`);
      }
    });
  }
}

/** Full syntax parse with tree-sitter-swift, loaded from a folder outside the repository. */
function treeSitterCheck(dir) {
  const load = createRequire(join(resolve(dir), 'noop.js'));
  let Parser;
  let Swift;
  try {
    Parser = load('tree-sitter');
    Swift = load('tree-sitter-swift');
  } catch (err) {
    problems.push(`tree-sitter: cannot load tree-sitter / tree-sitter-swift from ${dir} (${err.message})`);
    return null;
  }
  const parser = new Parser();
  parser.setLanguage(Swift);
  for (const path of files) {
    const file = relative(root, path);
    const src = readFileSync(path, 'utf8');
    const tree = parser.parse(src, null, { bufferSize: 4 * 1024 * 1024 });
    const errors = [];
    const walk = (node) => {
      if (node.type === 'ERROR' || node.isMissing) {
        errors.push(`${node.isMissing ? `missing ${node.type}` : 'syntax error'} at ${node.startPosition.row + 1}:${node.startPosition.column + 1}`);
        if (node.type === 'ERROR') return;
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);
    for (const e of errors.slice(0, 5)) problems.push(`${file}: ${e} (tree-sitter-swift)`);
    if (errors.length === 0) checkBuilderChildren(file, src, tree.rootNode);
  }
  return load('tree-sitter-swift/package.json').version;
}

/** Imperative closures that start with a capital letter (not view types). */
const NOT_VIEWS = new Set(['Task', 'DispatchQueue', 'Binding', 'AsyncStream', 'Result']);
const MAX_BUILDER_CHILDREN = 10;

/** True when a `statements` node is the body of a SwiftUI view builder. */
function isViewBuilder(node, src) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'lambda_literal') {
    let call = parent.parent;
    while (call && call.type !== 'call_expression') call = call.parent;
    if (!call || !call.firstChild) return false;
    const callee = src.slice(call.firstChild.startIndex, call.firstChild.endIndex).split(/[\s(<]/)[0];
    const name = callee.split('.').pop() ?? '';
    return /^[A-Z]/.test(name) && !NOT_VIEWS.has(name);
  }
  if (parent.type === 'function_body' || parent.type === 'computed_property') {
    let decl = parent.parent;
    while (decl && decl.type !== 'function_declaration' && decl.type !== 'property_declaration') decl = decl.parent;
    if (!decl) return false;
    const header = src.slice(decl.startIndex, parent.startIndex);
    return /\bsome View\b/.test(header);
  }
  return false;
}

function checkBuilderChildren(file, src, root) {
  const walk = (node) => {
    if (node.type === 'statements' && isViewBuilder(node, src)) {
      let children = 0;
      for (const child of node.namedChildren) {
        if (child.type === 'property_declaration' || child.type.endsWith('comment')) continue;
        children++;
      }
      if (children > MAX_BUILDER_CHILDREN) {
        problems.push(
          `${file}:${node.startPosition.row + 1}: view builder block has ${children} children (at most ${MAX_BUILDER_CHILDREN}; group them)`,
        );
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
}

const flag = process.argv.indexOf('--tree-sitter');
const treeSitterDir = flag >= 0 ? process.argv[flag + 1] : process.env.TREE_SITTER_SWIFT_DIR;
const grammarVersion = treeSitterDir ? treeSitterCheck(treeSitterDir) : null;

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ ${files.length} Swift files (${lines} lines): delimiters balanced, no banned constructs in app code.`);
if (grammarVersion) {
  console.log(
    `✓ every file parses with tree-sitter-swift ${grammarVersion} (no ERROR or MISSING nodes); ` +
      `no view builder block has more than ${MAX_BUILDER_CHILDREN} children.`,
  );
} else {
  console.log('  (syntax parse skipped: pass --tree-sitter <node_modules dir> to run it)');
}
