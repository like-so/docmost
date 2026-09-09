import 'reflect-metadata';
import { McpController } from './mcp.controller';
import { OAUTH_SCOPE_KEY } from '../../common/decorators/oauth-scope.decorator';
import { ENFORCE_MCP_OAUTH_KEY } from '../../common/decorators/enforce-mcp-oauth.decorator';

describe('McpController programmatic authorization', () => {
  it('marks MCP calls as a read-scoped route for sessions, API keys, and OAuth', () => {
    expect(
      Reflect.getMetadata(OAUTH_SCOPE_KEY, McpController.prototype.call),
    ).toBe('read');
    expect(
      Reflect.getMetadata(ENFORCE_MCP_OAUTH_KEY, McpController.prototype.call),
    ).toBe(true);
  });
});
