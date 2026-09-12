import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ScimTokenService } from '../services/scim-token.service';

@Injectable()
export class ScimBearerGuard implements CanActivate {
  constructor(private readonly tokens: ScimTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token)
      throw new UnauthorizedException('Invalid SCIM bearer token');
    request.scimWorkspaceId = await this.tokens.authenticate(token);
    return true;
  }
}
