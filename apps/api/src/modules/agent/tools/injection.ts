/**
 * Prompt-injection detection for untrusted content (web pages, documents).
 * Detection only flags content — JARVIS never obeys instructions found in
 * data. Structural defences do the real work: plans are made before content
 * is fetched, email recipients must be literal addresses fixed at planning
 * time, and untrusted text is wrapped in data tags when shown to a model.
 * A flag additionally forces human approval for external side effects that
 * consume the content (see policy.ts, UNTRUSTED_CONTENT).
 *
 * Patterns are deliberately specific (e.g. "you are now" only counts when it
 * re-assigns an AI role) so ordinary pages ("you are now subscribed") are not
 * flagged.
 */

interface Signal {
  id: string;
  pattern: RegExp;
}

const AI = String.raw`(?:ai|a\.i\.|llms?|language\s+models?|chatbots?|ai\s+assistants?|ai\s+agents?|assistants?|claude|chatgpt|gpt|gemini|copilot|jarvis)`;

const SIGNALS: Signal[] = [
  // English
  {
    id: 'ignore_previous_instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|of\s+)*(?:(?:previous|prior|above|earlier|preceding|original|existing|system)\s+(?:instructions?|prompts?|directions|rules|guidelines|messages)|instructions?|prompts?)\b/i,
  },
  { id: 'system_prompt_reference', pattern: /\bsystem[\s_-]?prompt\b|\bdeveloper\s+message\b/i },
  {
    id: 'role_reassignment',
    pattern:
      /\byou\s+are\s+now\b[^.\n]{0,60}?\b(?:ai|assistant|model|bot|dan|mode|unrestricted|unfiltered|jailbroken|instructions?|rules)\b|\bfrom\s+now\s+on,?\s+you\s+(?:will|must|are)\b/i,
  },
  { id: 'new_instructions', pattern: /\b(?:new|updated|real|actual|hidden)\s+instructions?\s*:/i },
  {
    id: 'instructions_to_ai',
    pattern: new RegExp(
      String.raw`\b(?:attention|note|message|instructions?|reminder)\s+(?:to|for)\s+(?:the\s+|all\s+|any\s+)?${AI}\b|\b(?:dear|hey|hello)\s+${AI}\b`,
      'i',
    ),
  },
  {
    id: 'addressed_to_ai',
    pattern:
      /\b(?:if\s+you\s+are|as)\s+an?\s+(?:ai|llm|large\s+language\s+model|language\s+model|ai\s+assistant|ai\s+agent|automated\s+assistant)\b/i,
  },
  {
    id: 'exfiltration_request',
    pattern:
      /\b(?:send|e-?mail|forward|upload|leak|exfiltrate|reveal|transmit)\b[^.\n]{0,40}?\b(?:your|the\s+user'?s?|all|their|my)\s+(?:memories|memory|passwords?|credentials|api\s*keys?|secrets?|tokens?|contacts|conversations?|chat\s+history|system\s+prompt)\b/i,
  },
  {
    id: 'prompt_markup',
    pattern: /<\s*\/?\s*(?:system|instructions?|im_start|im_end)\s*>|\[\/?INST\]|<<\s*SYS\s*>>/i,
  },
  // German
  {
    id: 'ignore_previous_instructions_de',
    pattern:
      /\b(?:ignorier\w*|vergiss|vergessen\s+sie|missacht\w*|überschreib\w*)\s+(?:alle\s+|die\s+|deine\s+|ihre\s+)*(?:(?:vorherigen|bisherigen|obigen|vorigen|früheren|ursprünglichen)\s+(?:anweisungen|instruktionen|befehle|regeln|vorgaben)|anweisungen|instruktionen)\b/i,
  },
  { id: 'system_prompt_reference_de', pattern: /\bsystem-?(?:prompt|anweisungen?)\b/i },
  {
    id: 'role_reassignment_de',
    pattern:
      /\b(?:du\s+bist|sie\s+sind)\s+(?:jetzt|ab\s+sofort|nun)\b[^.\n]{0,60}?(?:\bki\b|assistent|modell|\bbot\b|modus|ohne\s+einschränkungen|regeln)/i,
  },
  {
    id: 'instructions_to_ai_de',
    pattern:
      /\b(?:an\s+die|an\s+den|liebe[rs]?|hinweis\s+für\s+(?:die|den))\s+(?:ki|k\.i\.|ki-assistent\w*|sprachmodell|assistent\w*|chatbot)\b/i,
  },
  // Arabic (no \b — JS word boundaries do not apply to Arabic script)
  {
    id: 'ignore_previous_instructions_ar',
    pattern:
      /(?:تجاهل|تجاهلي|انس|إنس|انسى|تخط|تجاوز)\s+(?:جميع\s+|كل\s+)?(?:التعليمات|الأوامر|التوجيهات|القواعد)/,
  },
  { id: 'system_prompt_reference_ar', pattern: /(?:موجه|تعليمات|رسالة)\s+النظام/ },
  {
    id: 'role_reassignment_ar',
    pattern: /(?:أنت|انت)\s+الآن[^.\n]{0,60}?(?:مساعد|نموذج|ذكاء|بدون\s+قيود|وضع)/,
  },
  {
    id: 'instructions_to_ai_ar',
    pattern: /(?:إلى|الى|أيها|عزيزي)\s+(?:الذكاء\s+الاصطناعي|المساعد|النموذج\s+اللغوي|الروبوت)/,
  },
];

export interface InjectionScan {
  suspectedInjection: boolean;
  injectionSignals: string[];
}

/** Scans text for instruction-like content addressed to AI systems. */
export function detectInjection(text: string): InjectionScan {
  // Normalise whitespace and common obfuscations (zero-width chars, bidi controls, NBSP).
  const normalized = text
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ');
  const found = new Set<string>();
  for (const s of SIGNALS) {
    if (s.pattern.test(normalized)) found.add(s.id.replace(/_(?:de|ar)$/, ''));
  }
  const injectionSignals = [...found].sort();
  return { suspectedInjection: injectionSignals.length > 0, injectionSignals };
}
