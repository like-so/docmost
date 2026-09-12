import { Injectable } from '@nestjs/common';
import { Agent, Dispatcher } from 'undici';
import {
  OutboundUrlGuard,
  OutboundValidationOptions,
  PinnedAddress,
} from './outbound-url.guard';

export const OUTBOUND_REQUEST_TIMEOUT_MS = 10_000;

export type OutboundTlsOptions = {
  caCert?: string; // PEM encoded
  rejectUnauthorized?: boolean; // Defaults to true; self-hosted only when false.
};

export type AgentLease = {
  dispatcher: Dispatcher;
  release: () => Promise<void>;
};

export type IOutboundAgentFactory = {
  lease(
    url: string,
    tls?: OutboundTlsOptions,
    validation?: OutboundValidationOptions,
  ): Promise<AgentLease>;
};

export function createPinnedLookup(pinned: PinnedAddress) {
  return (_hostname: string, options: any, callback: any) => {
    if (options?.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

/** Creates a per-request agent pinned to the address validated by the SSRF guard. */
@Injectable()
export class OutboundAgentFactory implements IOutboundAgentFactory {
  constructor(private readonly urlGuard: OutboundUrlGuard) {}

  async lease(
    url: string,
    tls?: OutboundTlsOptions,
    validation?: OutboundValidationOptions,
  ): Promise<AgentLease> {
    const pinned = await this.urlGuard.validate(url, validation);

    const agent = new Agent({
      connect: {
        ca: tls?.caCert || undefined,
        rejectUnauthorized: tls?.rejectUnauthorized ?? true,
        lookup: createPinnedLookup(pinned) as any,
        timeout: OUTBOUND_REQUEST_TIMEOUT_MS,
      },
      headersTimeout: OUTBOUND_REQUEST_TIMEOUT_MS,
      bodyTimeout: OUTBOUND_REQUEST_TIMEOUT_MS,
    });

    return {
      dispatcher: agent,
      release: async () => {
        await agent.close();
      },
    };
  }
}
