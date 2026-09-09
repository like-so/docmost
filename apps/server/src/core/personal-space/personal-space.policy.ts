import { Space, Workspace } from '@docmost/db/types/entity.types';

export function allowsPersonalSpaces(workspace: Workspace | undefined): boolean {
  const settings = workspace?.settings as
    | { spaces?: { allowPersonal?: boolean } }
    | undefined;
  return settings?.spaces?.allowPersonal === true;
}

export function isVisiblePersonalSpace(
  space: Pick<Space, 'isPersonal'>,
  workspace: Workspace | undefined,
): boolean {
  return !space.isPersonal || allowsPersonalSpaces(workspace);
}
