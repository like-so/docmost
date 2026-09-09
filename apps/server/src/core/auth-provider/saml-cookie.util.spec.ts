import { samlBindingCookie } from './saml-cookie.util';

describe('SAML binding cookie', () => {
  it('permits the cross-site HTTPS IdP POST only on the callback path', () => {
    expect(samlBindingCookie('provider id')).toEqual({
      httpOnly: true,
      sameSite: 'none',
      path: '/api/sso/provider id/callback',
      maxAge: 600,
      secure: true,
    });
  });
});
