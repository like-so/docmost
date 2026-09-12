import { isOwnerRecovery } from './password-login';

describe('isOwnerRecovery', () => {
  it('marks password login as owner recovery only when SSO is enforced', () => {
    expect(isOwnerRecovery(true)).toBe(true);
    expect(isOwnerRecovery(false)).toBe(false);
  });
});
