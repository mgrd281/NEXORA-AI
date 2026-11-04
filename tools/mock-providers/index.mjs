/**
 * Mock Google and Microsoft providers for development and tests (never used
 * in production; apps/api refuses GOOGLE_BASE_URL_OVERRIDE /
 * MICROSOFT_BASE_URL_OVERRIDE there). See google.mjs and microsoft.mjs for
 * the endpoints and error cases each implements.
 */
export { startGoogleMock, googleError, GOOGLE_SCOPES } from './google.mjs';
export { startMicrosoftMock, graphError } from './microsoft.mjs';
export { pkceChallenge, parseRfc822 } from './common.mjs';
