import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from './environment.service';

describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnvironmentService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<EnvironmentService>(EnvironmentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('enables security controls by default without consulting licensing', () => {
    const config = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    const environment = new EnvironmentService(
      config as unknown as ConfigService,
    );

    expect(environment.isSecurityControlsEnabled()).toBe(true);
    expect(config.get).toHaveBeenCalledWith('SECURITY_CONTROLS_ENABLED', 'true');
  });

  it('uses the deployment capability setting to disable security controls', () => {
    const config = { get: jest.fn().mockReturnValue('false') };
    const environment = new EnvironmentService(
      config as unknown as ConfigService,
    );

    expect(environment.isSecurityControlsEnabled()).toBe(false);
  });
});
