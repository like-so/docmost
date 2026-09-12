import { BadRequestException } from '@nestjs/common';
import { load } from 'cheerio';

const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

export function validateSamlPost(
  response: string,
  callbackUrl: string,
  profile: Record<string, unknown>,
): void {
  const xml = Buffer.from(response, 'base64').toString('utf8');
  const document = load(xml, { xmlMode: true });
  const root = elements(document, 'Response').first();
  const responseTo = root.attr('InResponseTo');
  if (
    root.attr('Destination') !== callbackUrl ||
    !responseTo ||
    responseTo !== profile.inResponseTo
  ) {
    throw new BadRequestException('Invalid SAML response binding.');
  }
  const confirmation = elements(document, 'SubjectConfirmation')
    .filter((_, node) => document(node).attr('Method') === BEARER)
    .find('*')
    .filter(
      (_, node) =>
        hasLocalName(node, 'SubjectConfirmationData') &&
        document(node).attr('Recipient') === callbackUrl &&
        document(node).attr('InResponseTo') === responseTo,
    );
  if (!confirmation.length)
    throw new BadRequestException('Invalid SAML assertion binding.');
}

export function validateSamlIssuer(
  response: string,
  entityId: string,
  profile: Record<string, unknown>,
): void {
  const assertionXml = profile.getAssertionXml;
  if (typeof assertionXml !== 'function')
    throw new BadRequestException('Invalid SAML assertion issuer.');
  const assertion = assertionXml();
  const assertionIssuer = issuerValues(assertion, 'Assertion');
  const responseIssuer = issuerValues(
    Buffer.from(response, 'base64').toString('utf8'),
    'Response',
  );
  if (
    assertionIssuer.length !== 1 ||
    assertionIssuer[0] !== entityId ||
    responseIssuer.length > 1 ||
    (responseIssuer.length === 1 && responseIssuer[0] !== entityId)
  ) {
    throw new BadRequestException('Invalid SAML assertion issuer.');
  }
}

function elements(document: ReturnType<typeof load>, localName: string) {
  return document('*').filter(
    (_, node) => hasLocalName(node, localName),
  );
}

function hasLocalName(node: unknown, localName: string): boolean {
  if (!node || typeof node !== 'object' || !('name' in node)) return false;
  const name = (node as { name?: unknown }).name;
  if (typeof name !== 'string') return false;
  const parts = name.split(':');
  return parts[parts.length - 1] === localName;
}

function issuerValues(xml: string, rootName: string): string[] {
  const document = load(xml, { xmlMode: true });
  return elements(document, rootName)
    .first()
    .children('*')
    .filter((_, node) => hasLocalName(node, 'Issuer'))
    .map((_, node) => document(node).text())
    .get();
}
