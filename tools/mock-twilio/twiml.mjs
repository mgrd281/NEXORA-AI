/**
 * A small, strict XML reader for the TwiML the call simulator executes (dev and tests only).
 * Supports what TwiML uses: elements, attributes in single or double quotes, text, the five
 * predefined entities and numeric character references, comments and the XML declaration.
 * Anything else (DTDs, CDATA, processing instructions other than <?xml …?>) is rejected, as a
 * real TwiML parser would reject malformed documents (Twilio error 12100).
 */

/** @typedef {{ name: string, attrs: Record<string, string>, children: Node[] }} Element */
/** @typedef {Element | { text: string }} Node */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (!(ref in ENTITIES)) throw new Error(`TwiML: unknown entity ${whole}`);
    return ENTITIES[ref];
  });
}

/** Parses a TwiML document; returns the root element (must be <Response>). */
export function parseTwiml(xml) {
  let i = 0;
  const s = String(xml);
  const skipSpace = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const expect = (str) => {
    if (!s.startsWith(str, i)) throw new Error(`TwiML: expected "${str}" at ${i}`);
    i += str.length;
  };
  const name = () => {
    const m = /^[A-Za-z_][\w.-]*/.exec(s.slice(i));
    if (!m) throw new Error(`TwiML: expected a name at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) throw new Error('TwiML: unterminated comment');
        i = end + 3;
      } else if (s.startsWith('<?xml', i)) {
        const end = s.indexOf('?>', i);
        if (end < 0) throw new Error('TwiML: unterminated declaration');
        i = end + 2;
      } else return;
    }
  };

  function element() {
    expect('<');
    const tag = name();
    const attrs = {};
    for (;;) {
      skipSpace();
      if (s.startsWith('/>', i)) {
        i += 2;
        return { name: tag, attrs, children: [] };
      }
      if (s[i] === '>') {
        i++;
        break;
      }
      const key = name();
      skipSpace();
      expect('=');
      skipSpace();
      const quote = s[i];
      if (quote !== '"' && quote !== "'") throw new Error(`TwiML: unquoted attribute ${key}`);
      const end = s.indexOf(quote, i + 1);
      if (end < 0) throw new Error(`TwiML: unterminated attribute ${key}`);
      attrs[key] = decode(s.slice(i + 1, end));
      i = end + 1;
    }
    const children = [];
    for (;;) {
      if (i >= s.length) throw new Error(`TwiML: <${tag}> is not closed`);
      if (s.startsWith('</', i)) {
        i += 2;
        const closing = name();
        if (closing !== tag) throw new Error(`TwiML: </${closing}> closes <${tag}>`);
        skipSpace();
        expect('>');
        return { name: tag, attrs, children };
      }
      if (s.startsWith('<!--', i)) {
        skipMisc();
        continue;
      }
      if (s.startsWith('<![CDATA[', i) || s.startsWith('<!', i))
        throw new Error('TwiML: CDATA and declarations are not supported');
      if (s[i] === '<') {
        children.push(element());
        continue;
      }
      const next = s.indexOf('<', i);
      const raw = s.slice(i, next < 0 ? s.length : next);
      i = next < 0 ? s.length : next;
      const text = decode(raw);
      if (text.trim()) children.push({ text: text.trim() });
    }
  }

  skipMisc();
  const root = element();
  skipMisc();
  if (i !== s.length) throw new Error('TwiML: content after the root element');
  if (root.name !== 'Response')
    throw new Error(`TwiML: the root is <${root.name}>, not <Response>`);
  return root;
}

/** The text content of an element (its text children joined). */
export function textOf(el) {
  return el.children
    .filter((c) => 'text' in c)
    .map((c) => c.text)
    .join(' ')
    .trim();
}

/** Element children only. */
export const elements = (el) => el.children.filter((c) => 'name' in c);
