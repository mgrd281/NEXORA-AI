import { z } from 'zod';

/**
 * Zod's JIT compiles object parsers with `new Function`, which the nonce-based CSP forbids
 * (script-src has no 'unsafe-eval'). jitless skips both the compilation and the eval probe,
 * so no CSP violation is reported. Imported first by the client providers.
 */
z.config({ jitless: true });
