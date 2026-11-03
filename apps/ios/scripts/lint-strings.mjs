// Lints the iOS String Catalogs without Xcode:
//
//   node apps/ios/scripts/lint-strings.mjs          # check
//   node apps/ios/scripts/lint-strings.mjs --list   # print keys extracted from Swift
//
// 1. Localizable.xcstrings, InfoPlist.xcstrings and AppShortcuts.xcstrings are valid
//    JSON String Catalogs with a translated, non-empty en/de/ar value for every key.
// 2. Every translation keeps the key's format specifiers (%@, positional %1$@, ${param}).
// 3. Every localizable literal in the Swift sources has a catalog entry. Literals are
//    found in the positions where SwiftUI/Foundation/App Intents localize them
//    (Text("…"), Button("…"), String(localized: "…"), IntentDialog("…"), …).
//    Interpolations become %@ — the app interpolates only String values into
//    localized text (numbers are pre-formatted), matching what Xcode extracts.
// 4. The InfoPlist catalog's English usage descriptions equal Info.plist.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'Jarvis/Resources');
const LOCALES = ['en', 'de', 'ar'];
const problems = [];
const warnings = [];

function swiftFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith('.swift') && name !== 'Tokens.swift' ? [path] : [];
  });
}

/** Reads a Swift string literal starting at the opening quote; returns [key, endIndex]. */
function readLiteral(src, start) {
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return [out, i + 1];
    if (c === '\n') throw new Error('unterminated string literal');
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '(') {
        // Interpolation: find the matching ")" (skipping nested literals).
        let depth = 1;
        let j = i + 2;
        const exprStart = j;
        while (j < src.length && depth > 0) {
          if (src[j] === '"') {
            j = readLiteral(src, j)[1];
            continue;
          }
          if (src[j] === '(') depth++;
          if (src[j] === ')') depth--;
          j++;
        }
        const expr = src.slice(exprStart, j - 1).trim();
        const param = /^\\\.\$(\w+)$/.exec(expr); // App Intents parameter: \(\.$request)
        const appName = expr === '.applicationName';
        out += param ? `\${${param[1]}}` : appName ? '${applicationName}' : '%@';
        i = j;
        continue;
      }
      const escapes = { n: '\n', t: '\t', '"': '"', "'": "'", '\\': '\\', 0: '\0' };
      if (n === 'u') {
        const m = /^\\u\{([0-9a-fA-F]+)\}/.exec(src.slice(i));
        out += String.fromCodePoint(parseInt(m[1], 16));
        i += m[0].length;
        continue;
      }
      out += escapes[n] ?? n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  throw new Error('unterminated string literal');
}

const CALLS =
  /(?:\b(?:Text|Button|Label|Toggle|Section|TextField|SecureField|ProgressView|Picker|LabeledContent|ContentUnavailableView|Link|Menu|IntentDescription|IntentDialog|Summary|LocalizedStringResource)\(\s*|String\(localized:\s*|\.(?:navigationTitle|accessibilityLabel|accessibilityHint|accessibilityValue|help|confirmationDialog|alert)\(\s*|\b(?:title|shortTitle):\s*|LocalizedStringResource\s*(?:\{|=)\s*)"/g;

function extract() {
  const keys = new Map(); // key -> [locations]
  const phrases = new Map();
  for (const file of swiftFiles(join(root, 'Jarvis'))) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(root, file);
    for (const m of src.matchAll(CALLS)) {
      const quote = m.index + m[0].length - 1;
      if (src.slice(quote, quote + 3) === '"""') continue;
      const [key] = readLiteral(src, quote);
      const line = src.slice(0, m.index).split('\n').length;
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key).push(`${rel}:${line}`);
    }
    // App Shortcut phrases live in AppShortcuts.xcstrings.
    for (const block of src.matchAll(/phrases:\s*\[([\s\S]*?)\]/g)) {
      const body = block[1];
      for (let i = body.indexOf('"'); i !== -1; ) {
        const [key, end] = readLiteral(body, i);
        phrases.set(key, rel);
        i = body.indexOf('"', end);
      }
    }
  }
  for (const key of phrases.keys()) keys.delete(key);
  return { keys, phrases };
}

/** Format specifiers, normalised so %1$@ and %@ compare equal by position. */
function specifiers(text) {
  const list = [];
  let next = 0;
  for (const m of text.matchAll(/%(?:(\d+)\$)?(@|lld|ld|d|lf|f|%)|\$\{(\w+)\}/g)) {
    if (m[2] === '%') continue;
    if (m[3]) {
      list.push(`\${${m[3]}}`);
      continue;
    }
    const position = m[1] ? Number(m[1]) : ++next;
    list.push(`${position}:${m[2]}`);
  }
  return list.sort();
}

function checkCatalog(file, { requiredKeys = [], extraCheck } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(join(resources, file), 'utf8'));
  } catch (err) {
    problems.push(`${file}: not valid JSON (${err.message})`);
    return null;
  }
  if (catalog.sourceLanguage !== 'en') problems.push(`${file}: sourceLanguage must be "en"`);
  if (typeof catalog.version !== 'string') problems.push(`${file}: missing version`);
  const strings = catalog.strings ?? {};
  for (const key of requiredKeys) {
    if (!(key in strings)) problems.push(`${file}: missing key ${JSON.stringify(key)}`);
  }
  for (const [key, entry] of Object.entries(strings)) {
    const expected = specifiers(key);
    for (const locale of LOCALES) {
      const unit = entry.localizations?.[locale]?.stringUnit;
      if (!unit) {
        problems.push(`${file}: ${JSON.stringify(key)} has no ${locale} translation`);
        continue;
      }
      if (unit.state !== 'translated') problems.push(`${file}: ${JSON.stringify(key)} [${locale}] state is ${unit.state}`);
      if (typeof unit.value !== 'string' || unit.value.trim() === '') {
        problems.push(`${file}: ${JSON.stringify(key)} [${locale}] is empty`);
        continue;
      }
      const got = specifiers(unit.value);
      if (file !== 'InfoPlist.xcstrings' && JSON.stringify(got) !== JSON.stringify(expected)) {
        problems.push(`${file}: ${JSON.stringify(key)} [${locale}] specifiers ${JSON.stringify(got)} ≠ ${JSON.stringify(expected)}`);
      }
      extraCheck?.(key, locale, unit.value);
    }
  }
  return strings;
}

const { keys, phrases } = extract();

if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ keys: [...keys.keys()].sort(), phrases: [...phrases.keys()] }, null, 2));
  process.exit(0);
}

const localizable = checkCatalog('Localizable.xcstrings') ?? {};
for (const [key, where] of keys) {
  if (!(key in localizable)) problems.push(`Localizable.xcstrings: missing ${JSON.stringify(key)} (used at ${where[0]})`);
  if (/%(?!@|\d+\$@|lld)/.test(key.replaceAll('%@', ''))) problems.push(`literal contains a bare %: ${JSON.stringify(key)} (${where[0]})`);
}
for (const key of Object.keys(localizable)) {
  if (!keys.has(key)) warnings.push(`Localizable.xcstrings: ${JSON.stringify(key)} is not used in the Swift sources`);
}

const info = readFileSync(join(resources, 'Info.plist'), 'utf8');
const plistValue = (k) => new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(info)?.[1];
const infoKeys = ['CFBundleDisplayName', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription'];
const infoStrings = checkCatalog('InfoPlist.xcstrings', { requiredKeys: infoKeys }) ?? {};
for (const key of infoKeys) {
  const en = infoStrings[key]?.localizations?.en?.stringUnit?.value;
  const plist = plistValue(key)?.replaceAll('&apos;', "'");
  if (en !== undefined && plist !== undefined && en !== plist) {
    problems.push(`InfoPlist.xcstrings: en ${key} differs from Info.plist`);
  }
}

checkCatalog('AppShortcuts.xcstrings', {
  requiredKeys: [...phrases.keys()],
  extraCheck: (key, locale, value) => {
    if (!value.includes('${applicationName}')) {
      problems.push(`AppShortcuts.xcstrings: ${JSON.stringify(key)} [${locale}] must contain \${applicationName}`);
    }
  },
});

for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `✓ ${keys.size} Swift literals localized; ${Object.keys(localizable).length} Localizable keys, ` +
    `${infoKeys.length} InfoPlist keys, ${phrases.size} App Shortcut phrases — all with en, de and ar.`,
);
