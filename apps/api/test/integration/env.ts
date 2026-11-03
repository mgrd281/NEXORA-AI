export const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://jarvis_app:jarvis_app_dev@localhost:5432/jarvis_test';
export const TEST_OWNER_URL =
  process.env.TEST_DATABASE_OWNER_URL ??
  'postgresql://jarvis_owner:jarvis_owner_dev@localhost:5432/jarvis_test';
