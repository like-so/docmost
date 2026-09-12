import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AuthController } from './auth.controller';
import { SetupGuard } from './guards/setup.guard';
import { SessionService } from '../session/session.service';
import { AuthService } from './services/auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: SessionService, useValue: {} },
        { provide: EnvironmentService, useValue: {} },
        { provide: AUDIT_SERVICE, useValue: auditService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SetupGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('waits for audit persistence before completing logout', async () => {
    let resolveAudit!: () => void;
    auditService.log.mockImplementation(
      () => new Promise<void>((resolve) => (resolveAudit = resolve)),
    );
    const reply = { clearCookie: jest.fn() } as any;
    const logout = controller.logout(
      { id: 'user-id', workspaceId: 'workspace-id' } as any,
      { raw: {} } as any,
      reply,
    );

    let completed = false;
    void logout.then(() => (completed = true));
    await Promise.resolve();
    expect(completed).toBe(false);

    resolveAudit();
    await logout;
    expect(reply.clearCookie).toHaveBeenCalledWith('authToken');
  });

  it('propagates durable audit failures from logout', async () => {
    auditService.log.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      controller.logout(
        { id: 'user-id', workspaceId: 'workspace-id' } as any,
        { raw: {} } as any,
        { clearCookie: jest.fn() } as any,
      ),
    ).rejects.toThrow('audit unavailable');
  });
});
