// Structural checks for the Swift sources, for environments without a Swift toolchain
// (this does NOT replace compiling with Xcode):
//
//   node apps/ios/scripts/check-swift.mjs
//
// - (), [] and {} balance outside string literals and comments (incl. interpolations
//   and multi-line strings), with the line of the first mismatch.
// - App code (Jarvis/) contains no crash-prone shortcuts: try!, as!, fatalError,
//   preconditionFailure, implicitly unwrapped optionals, print().
// - Every file under Jarvis/ and JarvisTests/ ends with a newline and uses spaces.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ ${files.length} Swift files (${lines} lines): delimiters balanced, no banned constructs in app code.`);
