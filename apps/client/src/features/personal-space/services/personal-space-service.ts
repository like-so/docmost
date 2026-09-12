import api from "@/lib/api-client";
import type { ISpace } from "@/features/space/types/space.types";

export async function getPersonalSpace(): Promise<ISpace> {
  return (await api.post<ISpace>("/personal-space")).data;
}
