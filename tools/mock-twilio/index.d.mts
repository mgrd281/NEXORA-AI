/** Types of the mock Twilio REST API and call simulator (index.mjs), for TypeScript tests. */

/** What the callee says when JARVIS listens (<Gather input="speech">). */
export type MockUtterance =
  | string
  | { say: string; confidence?: number }
  /** Nothing recognised (Gather posts without SpeechResult when actionOnEmptyResult="true"). */
  | { silence: true }
  /** The callee hangs up instead of answering. */
  | { hangup: true }
  | ((ctx: MockUtteranceContext) => MockUtterance);

export interface MockUtteranceContext {
  /** Everything JARVIS said so far (<Say>), oldest first. */
  heard: MockHeard[];
  gather: MockGather;
  call: TwilioCallResource;
}

export interface MockScenario {
  /**
   * answer (default) · busy · no-answer · failed (the carrier could not connect it: status
   * callback "failed") · reject (the create request is refused with a Twilio error) · machine
   * (an answering machine: AnsweredBy machine_end_beep) · timeout (the create request is
   * accepted and the call placed, but the answer comes after responseDelayMs) · error500 (the
   * call is placed, the create request answers 500 without a body).
   */
  outcome?:
    'answer' | 'busy' | 'no-answer' | 'failed' | 'reject' | 'machine' | 'timeout' | 'error500';
  /** The callee's answers to JARVIS's questions, in order. */
  turns?: MockUtterance[];
  /** When the turns run out: hang up (default) or stay silent. */
  whenDone?: 'hangup' | 'silence';
  ringMs?: number;
  /** How long the callee waits before each answer (a live call the UI can watch). */
  turnDelayMs?: number;
  amdDelayMs?: number;
  answeredBy?: string;
  responseDelayMs?: number;
  rejectStatus?: number;
  rejectCode?: number;
  rejectMessage?: string;
  sipResponseCode?: number;
  /** <Dial> to the account's own number: how that leg ends. */
  dial?: { outcome?: 'answered' | 'busy' | 'no-answer' | 'failed'; seconds?: number };
  /** Every status callback is delivered twice. */
  duplicateCallbacks?: boolean;
  /** The "ringing" callback arrives after the "answered" one. */
  outOfOrder?: boolean;
  /** Status callbacks carry a Timestamp an hour in the past. */
  staleTimestamps?: boolean;
  /** Webhooks are signed with a wrong key. */
  tamperSignature?: boolean;
  /** Webhooks carry another account's AccountSid (signed correctly). */
  wrongAccount?: boolean;
}

export interface MockHeard {
  text: string;
  language: string | null;
  voice: string | null;
}

export interface MockGather {
  input: string;
  language: string;
  action: string | null;
  speechTimeout: string | null;
  prompt: string[];
}

export interface MockCall {
  sid: string;
  to: string;
  from: string;
  url: string;
  params: Record<string, string | string[]>;
  status: string;
  answeredBy: string | null;
  duration: number;
  price: string | null;
  ended: boolean;
  scenario: MockScenario;
  heard: MockHeard[];
  gathers: MockGather[];
  said: (string | null)[];
  dials: {
    to: string;
    callerId: string | null;
    timeout: string | null;
    /** What the dialled party heard after answering, before being bridged (<Number url>). */
    whisper: MockHeard[];
  }[];
  updates: Record<string, string | string[]>[];
  errors: string[];
}

export interface MockRecording {
  sid: string;
  callSid: string;
  status: string;
  duration: number;
  media: Buffer | null;
  callback: string | null;
  deleted: boolean;
  params: Record<string, string | string[]>;
}

export interface MockRestRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string | string[]>;
  authorised: boolean;
  status: number;
  at: Date;
}

export interface MockWebhook {
  kind: string;
  url: string;
  params: Record<string, string>;
  status: number;
  body: string;
  callSid: string | null;
  signature: string;
}

export interface TwilioCallResource {
  sid: string;
  status: string;
  to: string;
  from: string;
  price: string | null;
  price_unit: string;
  duration: string | null;
  answered_by: string | null;
  uri: string;
  [key: string]: unknown;
}

export interface MockTwilio {
  url: string;
  port: number;
  accountSid: string;
  authToken: string;
  calls: Map<string, MockCall>;
  recordings: Map<string, MockRecording>;
  requests: MockRestRequest[];
  webhooks: MockWebhook[];
  setScenario(number: string, scenario: MockScenario): void;
  clearScenarios(): void;
  setDefaultScenario(scenario: MockScenario): void;
  failNextCreate(f: {
    status: number;
    code?: number;
    message?: string;
    body?: unknown;
    afterCreate?: boolean;
    delayMs?: number;
  }): void;
  callsTo(number: string): MockCall[];
  createRequests(number?: string): MockRestRequest[];
  recordingRequests(): MockRestRequest[];
  waitFor<T>(predicate: () => T, timeoutMs?: number): Promise<NonNullable<T>>;
  waitForEnded(sid: string, timeoutMs?: number): Promise<MockCall>;
  replay(record: MockWebhook): Promise<MockWebhook>;
  sendWebhook(
    url: string,
    params: Record<string, string>,
    opts?: { signWith?: string; signature?: string },
  ): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

export function startMockTwilio(opts: {
  authToken: string;
  accountSid?: string;
  /** Caller ids the account owns (From must be one of them; empty = any). */
  numbers?: string[];
  port?: number;
  host?: string;
  /** Pacing of the simulation in milliseconds per step (default 5). */
  stepMs?: number;
  defaultScenario?: MockScenario;
}): Promise<MockTwilio>;

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]>,
): string;
export function rfc2822(d?: Date): string;
export function newSid(prefix: string): string;

export interface TwimlElement {
  name: string;
  attrs: Record<string, string>;
  children: (TwimlElement | { text: string })[];
}
export function parseTwiml(xml: string): TwimlElement;
export function textOf(el: TwimlElement): string;
export function elements(el: TwimlElement): TwimlElement[];
