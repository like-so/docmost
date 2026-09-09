import { SetMetadata } from '@nestjs/common';

export const ENFORCE_MCP_OAUTH_KEY = 'enforceMcpOauth';

export const EnforceMcpOauth = () => SetMetadata(ENFORCE_MCP_OAUTH_KEY, true);
