import { canManageScim } from './scim-access';

describe('canManageScim', () => {
  it('allows only workspace owners to manage SCIM tokens', () => {
    expect(canManageScim(true)).toBe(true);
    expect(canManageScim(false)).toBe(false);
  });
});
