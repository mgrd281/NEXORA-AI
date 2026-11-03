import { describe, expect, it } from 'vitest';
import { viewAuditThrottle } from '../../../src/modules/admin/routes';

describe('admin view audit throttle', () => {
  it('audits a view once per admin and list per window', () => {
    let now = 0;
    const should = viewAuditThrottle(10 * 60_000, () => now);
    expect(should('admin-1', 'admin.users_viewed')).toBe(true);
    now += 30_000; // a refresh
    expect(should('admin-1', 'admin.users_viewed')).toBe(false);
    expect(should('admin-1', 'admin.audit_viewed')).toBe(true);
    expect(should('admin-2', 'admin.users_viewed')).toBe(true);
    now += 10 * 60_000; // the next visit
    expect(should('admin-1', 'admin.users_viewed')).toBe(true);
  });
});
