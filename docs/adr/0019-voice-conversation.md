# ADR-0019: Voice conversation — on-device speech, follow-ups, barge-in, approvals by tap only

- Status: Accepted
- Date: 2026-11-04
- Design: [Phase D architecture](../architecture/phase-d.md) §3.1
- Builds on: [ADR-0005 realtime SSE](0005-realtime-sse.md), Phase B conversations and follow-ups

## Context

Milestone 1 voice mode dictates one request: the browser or iPhone recognises speech, the text
is sent as a task, and the result may be read aloud. Phase D asks for a natural conversation:
JARVIS answers aloud while the answer is still being written, the user can interrupt it at any
time, the conversation continues turn after turn, and everything stays honest — states reflect
what really happens, nothing is approved by voice, and no audio or transcript leaves the device
beyond the requests themselves. The constraints: no server-side speech pipeline exists (and
adding one would send the user's voice to another processor), the agent runtime already streams
answers (`task.answer.delta`) and runs follow-ups in a conversation, and risky actions must be
approved against the exact action shown.

## Decision

- **Speech stays on the client.** Recognition and synthesis are the platform's: web Speech API
  (`SpeechRecognition` continuous with interim results, `speechSynthesis`), iOS `SFSpeechRecognizer`
  (on-device when the device supports it) and `AVSpeechSynthesizer`. The server never receives
  audio; unsupported browsers say so and offer typing. Voices, rate and the end-of-utterance pause
  are user preferences (`Preferences.voice`), the pause adjustable for people who speak slowly
  (WCAG 2.2.1).
- **A conversation is a chain of ordinary requests.** Each utterance (final result + the configured
  silence) becomes a task — the first `POST /v1/tasks`, the rest follow-ups in the same
  conversation — so planning, policy, approvals, evidence and history are exactly those of typed
  requests. Each utterance carries its own Idempotency-Key until acknowledged: network retries
  never duplicate a request.
- **Low latency by sentence.** The client speaks each complete sentence of the streamed answer as
  soon as it exists (sentence segmentation on the client), then the result line or question.
- **Barge-in is immediate.** Recognition keeps running while JARVIS speaks (echo cancellation:
  iOS `.voiceChat` audio session, web `echoCancellation`); user speech that is not the echo of the
  current sentence cancels speaking at once and the turn passes to the user.
- **Approvals are never given by voice.** A task waiting for approval shows the ApprovalSheet and
  says so; spoken "yes" is not a decision. The approval stays bound to the action hash of the exact
  resolved input and is decided by a tap or click.
- **Honest states.** Listening, thinking, speaking and waiting-for-approval are driven by real
  signals (microphone level, task status over SSE, synthesis callbacks); Presence never animates
  work that is not happening. Network loss shows a reconnecting state, the stream resumes with
  `Last-Event-ID`, the task is refetched, and recognition restarts with bounded backoff.
- **Always a way out.** Text input at any time; End, Esc and spoken stop phrases ("stop",
  "stopp", "توقف", contracts `VOICE_LIMITS.stopPhrases`) end voice mode — never the task. Captions
  of everything spoken; keyboard operable.
- **Metadata only.** Voice sessions record mode, conversation, counters (requests, barge-ins,
  reconnects), outcome and end reason (`voice_sessions`, 0008) — never audio or transcripts.

## Consequences

- No new server component, processor or data category; the runtime is unchanged.
- Quality depends on the platform's recognisers (Chrome's Web Speech API uses Google's service;
  Safari / iOS on-device where available) — documented in the privacy notice; Firefox has no
  recognition and falls back to typing.
- Echo-induced false barge-ins are possible on speakers without echo cancellation; the client's
  echo guard (ignore recognition that matches the sentence being spoken) mitigates it.
- Follow-ups are serial: while a task runs or waits for approval, a new utterance is not sent
  (`CONVERSATION_BUSY` is said and the text kept), which keeps the conversation and its approvals
  unambiguous.

## Alternatives considered

- **Server-side streaming speech (STT/TTS provider, WebRTC).** Lower latency and consistent
  quality, but audio would leave the device to another processor, and it needs a realtime media
  stack. Deferred; the contract (metadata-only sessions) does not preclude it.
- **Voice approvals ("say yes to confirm").** Rejected: speech is spoofable (recordings, other
  people in the room, misrecognition) and cannot show the exact action; approvals stay visual.
- **One long-lived "voice task".** Rejected: it would bypass per-request planning, policy and
  evidence.
