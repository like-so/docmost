import api from "@/lib/api-client";

export type PageVerification = {
  id: string;
  pageId: string;
  status: string;
  requestedAt: string;
  expiresAt: string | null;
  type: string;
  canVerify: boolean;
};

export async function listPageVerifications(): Promise<PageVerification[]> {
  return (await api.post<PageVerification[]>("/page-verifications/list")).data;
}

export const requestVerification = (
  pageId: string,
  verifierIds: string[],
  periodDays?: number,
) =>
  api.post("/page-verifications/request", { pageId, verifierIds, periodDays });
export const verifyPage = (verificationId: string) =>
  api.post("/page-verifications/verify", { verificationId });
export const rejectPage = (verificationId: string, comment?: string) =>
  api.post("/page-verifications/reject", { verificationId, comment });
export const acknowledgePageRead = (pageId: string) =>
  api.post("/page-verifications/read", { pageId });
