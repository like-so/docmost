import { Agent } from 'undici';
import {
  createPinnedLookup,
  OutboundAgentFactory,
} from './outbound-agent.factory';
import { OutboundUrlError } from './outbound-url.guard';

describe('OutboundAgentFactory', () => {
  it('validates the URL through the guard and returns a releasable undici Agent', async () => {
    const validate = jest.fn().mockResolvedValue({ hostname: 'siem.example.com', address: '203.0.113.5', family: 4 });
    const factory = new OutboundAgentFactory({ validate } as any);

    const lease = await factory.lease('https://siem.example.com/ingest', { caCert: undefined, rejectUnauthorized: true });

    expect(validate).toHaveBeenCalledWith(
      'https://siem.example.com/ingest',
      undefined,
    );
    expect(lease.dispatcher).toBeInstanceOf(Agent);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('forwards an explicit outbound validation policy to the guard', async () => {
    const validate = jest
      .fn()
      .mockResolvedValue({ hostname: 'idp.internal', address: '10.0.0.7', family: 4 });
    const factory = new OutboundAgentFactory({ validate } as any);
    const policy = {
      requireHttps: true,
      privateHostnames: ['idp.internal'],
      allowPrivateNetworks: false,
    };

    const lease = await factory.lease('https://idp.internal', undefined, policy);

    expect(validate).toHaveBeenCalledWith('https://idp.internal', policy);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('uses the validated address when a hostname attempts DNS rebinding', () => {
    const lookup = createPinnedLookup({
      hostname: 'idp.internal',
      address: '10.0.0.7',
      family: 4,
    });
    const callback = jest.fn();

    lookup('idp.internal', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: '10.0.0.7', family: 4 },
    ]);
  });

  it('propagates guard rejections', async () => {
    const validate = jest.fn().mockRejectedValue(new OutboundUrlError('Destination URL must use https'));
    const factory = new OutboundAgentFactory({ validate } as any);

    await expect(factory.lease('http://siem.example.com')).rejects.toThrow(OutboundUrlError);
  });
});
