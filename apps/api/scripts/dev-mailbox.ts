/**
 * Local development mailbox: an SMTP sink on 127.0.0.1:2525 that stores
 * messages in memory and lists them at http://127.0.0.1:2580/messages.
 * Lets the owner exercise the real email.send path without a provider account.
 * Connect it in the app as host 127.0.0.1, port 2525, security "none"
 * (requires SMTP_ALLOW_INSECURE_LOCALHOST=true; refused in production).
 */
import { createServer } from 'node:http';
import { SMTPServer } from 'smtp-server';

interface Stored {
  id: number;
  from: string;
  to: string[];
  raw: string;
  receivedAt: string;
}
const messages: Stored[] = [];
let seq = 0;

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    stream.on('end', () => {
      messages.push({
        id: ++seq,
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
        to: session.envelope.rcptTo.map((r) => r.address),
        raw,
        receivedAt: new Date().toISOString(),
      });
      callback(null, `Message queued as dev-${seq}`);
    });
  },
});
smtp.listen(Number(process.env.MAILBOX_SMTP_PORT ?? 2525), '127.0.0.1', () =>
  console.log('dev mailbox SMTP on 127.0.0.1:2525'),
);

createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/messages')
    return res.end(
      JSON.stringify(
        messages.map(({ raw, ...m }) => ({
          ...m,
          size: raw.length,
          subject: /^Subject: (.*)$/m.exec(raw)?.[1] ?? '',
        })),
      ),
    );
  const m = req.url?.match(/^\/messages\/(\d+)$/);
  if (m) return res.end(JSON.stringify(messages.find((x) => x.id === Number(m[1])) ?? null));
  res.statusCode = 404;
  res.end('{}');
}).listen(Number(process.env.MAILBOX_HTTP_PORT ?? 2580), '127.0.0.1', () =>
  console.log('dev mailbox HTTP on http://127.0.0.1:2580/messages'),
);
