import { BadRequestException } from '@nestjs/common';
import { buildCallbackUrl } from './callback-url.util';

describe('SSO callback URLs', () => {
  it('uses the self-hosted application URL', () => {
    expect(
      buildCallbackUrl(
        'https://self.example',
        false,
        undefined,
        'ignored',
        'provider id',
      ),
    ).toBe('https://self.example/api/sso/provider%20id/callback');
  });

  it('uses the current cloud workspace subdomain', () => {
    expect(
      buildCallbackUrl(
        'https://acme.docmost.example',
        true,
        'docmost.example',
        'acme',
        'provider',
      ),
    ).toBe('https://acme.docmost.example/api/sso/provider/callback');
  });

  it('rejects malformed or mismatched cloud hosts', () => {
    expect(() =>
      buildCallbackUrl(
        'https://other.docmost.example',
        true,
        'docmost.example',
        'acme',
        'provider',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      buildCallbackUrl(
        'https://acme.docmost.example',
        true,
        'docmost.example',
        'acme.evil',
        'provider',
      ),
    ).toThrow(BadRequestException);
  });
});
