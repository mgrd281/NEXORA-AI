import { AgentError } from '../agent/errors';

export const threadNotFound = () =>
  new AgentError('TOOL_FAILED', 'That email conversation was not found in the mailbox.', {
    retryable: false,
    reason: 'EMAIL_THREAD_NOT_FOUND',
  });
