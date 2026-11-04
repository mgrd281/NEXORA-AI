/**
 * In-process SMTP sink (smtp-server) for email.send tests. Can be stopped and
 * restarted on the same port to simulate an outage.
 */
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';

export interface SinkMessage {
  from: string;
  to: string[];
  subject: string;
  messageId: string;
  raw: string;
}

export interface SmtpSink {
  readonly port: number;
  messages: SinkMessage[];
  /** Messages addressed to `address` (case-insensitive). */
  to(address: string): SinkMessage[];
  stop(): Promise<void>;
  start(): Promise<void>;
}

/**
 * The decoded plain-text body of a single-part message (quoted-printable,
 * base64 or 7/8bit, as nodemailer writes it).
 */
export function textBody(raw: string): string {
  const split = raw.indexOf('\r\n\r\n');
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split + 4);
  const encoding = header(head, 'Content-Transfer-Encoding').toLowerCase();
  if (encoding === 'base64')
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') {
    const bytes = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8').replace(/\r\n/g, '\n');
  }
  return body.replace(/\r\n/g, '\n');
}

function header(raw: string, name: string): string {
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(raw);
  return m?.[1]?.trim() ?? '';
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  let server: SMTPServer | null = null;
  let port = 0;

  const listen = async () => {
    const s = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          messages.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            subject: header(raw, 'Subject'),
            messageId: header(raw, 'Message-ID'),
            raw,
          });
          callback(null, `Message queued as sink-${messages.length}`);
        });
      },
    });
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => resolve());
    });
    port = (s.server.address() as AddressInfo).port;
    server = s;
  };

  await listen();
  return {
    get port() {
      return port;
    },
    messages,
    to: (address) =>
      messages.filter((m) => m.to.some((t) => t.toLowerCase() === address.toLowerCase())),
    async stop() {
      const s = server;
      server = null;
      if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    async start() {
      if (!server) await listen();
    },
  };
}
