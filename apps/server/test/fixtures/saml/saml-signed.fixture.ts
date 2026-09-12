import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

export const TEST_IDP_PRIVATE_KEY = String.raw`-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCrysGsL8cBZny5
ktwGJon55V4Q1W2pauEGiYcrH9mjskRrwwpzBMl4OBWNQ9Pcf8LoRL+q5CDVcqZw
AXZSexqG22R8h+XaTWBaHYfCCGo3Y3EAM3bQZzTRxjO7rPB4QVXqztz6roCMaGD8
bzYmuV1rtVD8swp10yW08fYH6DAGUVRciGd2XNl3pH0X2oIS8d1aEsMpisYS2wZe
ITK3n5+unURGqm+HzsdUmf2v14ub4yF+0bMnxd4AyDdpWhmb2LixOFUEwySycS4D
Z0NCLP/SgsUXjX35Ob3YSn/5AFiSs0DfQJyLl4Yw3Ot0e1OZZkhbWOO1YSSeOume
XFog2nBHAgMBAAECggEAMXZsA/0voc4V7EKGGjk/cdWiG1uwOt7ckorHgdmmStUZ
kSNzn0FKFtSjE+zrE6ovfrvIqdYMRBjCJi6tmDr8nMaPbLGeMxgjPV8SRwIwPulh
UEsBEykcEqgsHgXBqQY6zCQqiPz0Yzjsb9I/d6/YX5oxisisItecHDise4NVTIPm
P0VMgnaauL/DqfnIVmDOp3MJvDGosZXGguFhDnJe3n7rtCuldujfrK5UYpwUgFv2
SjLdC5+HGPTfNLv3JZKG8DCNdyYYyK+/38mb6c4vqiG0qDe+8eiRQuV12eUubp/j
08VK5JMUe0weDWp9j6Q+ueOKrLacxeZJh4SZVorobQKBgQDd5gb+I9RUKhjtFvKY
KyWaDkzrcq0FKr3wzblol5mTi2vQuzh5j6d1ywDjOml1ElZF12mq1/BaUjE9Y5KJ
N33WazPUl4d9pQshzAn70BdK0emnRHS9vFmlBhlBqjwB1YxvhNoehlf5VLihLP1O
31TrP0Efp1GbwM4FTkA4/a5c9QKBgQDGMW3fDxPIN3jZI6bBKzPyfP2lvpEdpzy9
wBunNNKXPYk9ZeoZsmpRPP/dXHQyyod7yA9LiS4hUon6NgjZcvbT/c7c6oPxy47j
08NxECvecd6hFArnWxM28KPjCCFv38bVNfHO5rPrVZ/7N8f/uAdVMszVzb/1VrLi
YCFvoGeSywKBgQC6yYozXfe7DWDEGyAFBbT2VHldbL/GbK9Mx+/94jdN4vvTzfWB
JnLBjivmGuJwwQnMasMxI+rYLP3z/iB4zzRnTQBpQVC1bDvNrFLvHMCuo7q6qb5X
hPg1GMgj5Wfz5037BesR7OabJDzyt8tXHFoAWNO6EH96y7bg8njPQIQJDQKBgQC3
/RsqgCy1KgoeSmJ74UeQTUiLnaXKCX7yCG2jg/4cORw2y23P/TmFwUMmlLWqkSnF
V6wbS3ZvqNg+V/tPItLRakWoAG4NAhPcnLJLO9/92Wf70UduD7Z+wlbiZKHl4bAM
LtAUa0eLqSmjZd1dH9Ju3YIa2a7ia2IVlXh00ExWkQKBgQDY3GFtsBlTrBOIDW1+
clOZCgOG3oYKmfWx4rhNr64gdArgbWHtMHl55+qzYtomM2CBE9IwWXI3rTeQAnnt
FBXfSUcwXFtHdkrd9dl7FLVA2dbylJ4RoIsBgLnx/79sYhf1DSeWj9JBv3GKWAv0
A2+hhWSd+vHmDkkxyGW321hiVg==
-----END PRIVATE KEY-----`;
export const TEST_IDP_CERTIFICATE = String.raw`-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUR7+Kt4o0ntoh3OK3PPSjwJ73vQ8wDQYJKoZIhvcNAQEL
BQAwRTEaMBgGA1UEAwwRTElLRS0xNTcgVGVzdCBJZFAxGjAYBgNVBAoMEURvY21v
c3QgVGVzdCBPbmx5MQswCQYDVQQGEwJVUzAeFw0yNjA5MTAwNjM1MTFaFw0zNjA5
MDcwNjM1MTFaMEUxGjAYBgNVBAMMEUxJS0UtMTU3IFRlc3QgSWRQMRowGAYDVQQK
DBFEb2Ntb3N0IFRlc3QgT25seTELMAkGA1UEBhMCVVMwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCrysGsL8cBZny5ktwGJon55V4Q1W2pauEGiYcrH9mj
skRrwwpzBMl4OBWNQ9Pcf8LoRL+q5CDVcqZwAXZSexqG22R8h+XaTWBaHYfCCGo3
Y3EAM3bQZzTRxjO7rPB4QVXqztz6roCMaGD8bzYmuV1rtVD8swp10yW08fYH6DAG
UVRciGd2XNl3pH0X2oIS8d1aEsMpisYS2wZeITK3n5+unURGqm+HzsdUmf2v14ub
4yF+0bMnxd4AyDdpWhmb2LixOFUEwySycS4DZ0NCLP/SgsUXjX35Ob3YSn/5AFiS
s0DfQJyLl4Yw3Ot0e1OZZkhbWOO1YSSeOumeXFog2nBHAgMBAAGjUzBRMB0GA1Ud
DgQWBBRjWf321B5MSLE+s4NKatsluyFZRDAfBgNVHSMEGDAWgBRjWf321B5MSLE+
s4NKatsluyFZRDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCB
l0Ib8uoMn3nUPuQyGuAKTtOqbr0CI465483IujvcuB08sdUKceMHQeFu1LEK2tKX
HbG42Y03U5hU+tNjF6HTwq3p01LnZwC2MxdRvE18ozCA0fVabZic5aKS8uxBPRW9
QEfqVzcoKOTb3ckuPvGjglYGPee4wjyJAgwr49unzLTXC+guJzbCwhsNjPZdbiuu
yjQbFSzDAphxbkY+bQTUth2aM/nmoROmzRCMWAbZ4M4gi4kC94ODN8oJb1EhRdJn
EsUUnKmz8MVKMiEEL+YyTmkvlXuaHingv1a3OPlkT5duy8ogvXcplIskA3A8qYcG
QZF3Rn6lhDC50scjRwpv
-----END CERTIFICATE-----`;

export const SAML_FIXTURE_PROVENANCE = {
  certificateSha256: '8d9a301fe64e2a0f15d3e0c1ed80d61d034a66d5a5a55e12e0e29ae2174af5b5',
  generation: 'openssl req -x509 -newkey rsa:2048 -nodes -days 3650',
  identity: 'LIKE-157 Test IdP',
  privateKeySha256: '692ac86dd30e7910c3350fc7e2ffc06b394db535715a8a03e36d38e217ea8ad4',
  scope: 'test-only',
};

type ResponseInput = {
  audience: string;
  destination: string;
  inResponseTo: string;
  notBefore: string;
  notOnOrAfter: string;
  recipient: string;
  assertionIssuer?: string | string[] | null;
  responseIssuer?: string | string[] | null;
  responseInResponseTo?: string;
  omitResponseInResponseTo?: boolean;
  subjectInResponseTo?: string;
};

export function requestId(authorizeUrl: string): string {
  const request = new URL(authorizeUrl).searchParams.get('SAMLRequest');
  if (!request) throw new Error('Missing SAML request.');
  return inflateRawSync(Buffer.from(request, 'base64')).toString('utf8').match(/ID="([^"]+)"/)?.[1] ?? '';
}

export function signedResponse(input: ResponseInput): string {
  const assertion = sign(
    assertionXml(input),
    "//*[local-name(.)='Assertion']",
    input.assertionIssuer === null
      ? "/*[local-name(.)='Assertion']/*[local-name(.)='Subject']"
      : "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
  );
  const response = sign(
    responseXml(input, assertion),
    "//*[local-name(.)='Response']",
    input.responseIssuer === null
      ? "/*[local-name(.)='Response']/*[local-name(.)='Status']"
      : "/*[local-name(.)='Response']/*[local-name(.)='Issuer']",
  );
  return Buffer.from(response).toString('base64');
}

function assertionXml(input: ResponseInput): string {
  const issuer = issuerXml(input.assertionIssuer);
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${input.notBefore}">${issuer}<saml:Subject><saml:NameID>subject-id</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${input.subjectInResponseTo ?? input.inResponseTo}" Recipient="${input.recipient}" NotOnOrAfter="${input.notOnOrAfter}" /></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${input.notBefore}" NotOnOrAfter="${input.notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${input.notBefore}" /><saml:AttributeStatement><saml:Attribute Name="mail"><saml:AttributeValue>person@example.com</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Person</saml:AttributeValue></saml:Attribute><saml:Attribute Name="email_verified"><saml:AttributeValue>true</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>Engineering</saml:AttributeValue><saml:AttributeValue>Admins</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
}

function responseXml(input: ResponseInput, assertion: string): string {
  const responseTo = input.omitResponseInResponseTo
    ? ''
    : ` InResponseTo="${input.responseInResponseTo ?? input.inResponseTo}"`;
  const responseIssuer = issuerXml(input.responseIssuer);
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${input.notBefore}" Destination="${input.destination}"${responseTo}>${responseIssuer}<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success" /></samlp:Status>${assertion}</samlp:Response>`;
}

function issuerXml(issuer: string | string[] | null | undefined): string {
  if (issuer === null) return '';
  return (Array.isArray(issuer) ? issuer : [issuer ?? 'https://idp.example.test'])
    .map((value) => `<saml:Issuer>${value}</saml:Issuer>`)
    .join('');
}

function sign(xml: string, xpath: string, location: string): string {
  const signer = new SignedXml({
    privateKey: TEST_IDP_PRIVATE_KEY,
    publicCert: TEST_IDP_CERTIFICATE,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signer.addReference({
    xpath,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signer.computeSignature(xml, { location: { reference: location, action: 'after' } });
  return signer.getSignedXml();
}
