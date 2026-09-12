import { UserRole } from '../../common/helpers/types/permission';
import { canUsePasswordLogin } from './auth.util';

describe('canUsePasswordLogin', () => {
  it('keeps an owner recovery path when SSO is enforced', () => {
    expect(canUsePasswordLogin(true, UserRole.OWNER)).toBe(true);
    expect(canUsePasswordLogin(true, UserRole.ADMIN)).toBe(false);
  });

  it('allows password recovery when the deployment disables SSO capability', () => {
    expect(canUsePasswordLogin(true, UserRole.MEMBER, false)).toBe(true);
  });
});
