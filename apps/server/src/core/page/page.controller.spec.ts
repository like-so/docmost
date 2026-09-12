import { PageController } from './page.controller';

describe('PageController', () => {
  let controller: PageController;

  beforeEach(() => {
    controller = new PageController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
