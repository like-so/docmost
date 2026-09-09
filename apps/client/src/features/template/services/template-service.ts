import api from "@/lib/api-client";
import type { Template } from "@/features/template/components/template-picker";

export type TemplateInput = {
  title: string;
  description?: string;
  icon?: string;
  spaceId?: string;
  content?: object;
};
type TemplateList = { items?: Template[] } | Template[];

export async function listTemplates(): Promise<Template[]> {
  const response = await api.post<TemplateList>("/templates", {});
  return Array.isArray(response.data)
    ? response.data
    : (response.data.items ?? []);
}

export async function createTemplate(
  template: TemplateInput,
): Promise<Template> {
  return (await api.post<Template>("/templates/create", template)).data;
}

export async function updateTemplate(
  templateId: string,
  template: TemplateInput,
): Promise<void> {
  await api.post("/templates/update", { templateId, ...template });
}

export async function deleteTemplate(templateId: string): Promise<void> {
  await api.post("/templates/delete", { templateId });
}

export async function instantiateTemplate(
  templateId: string,
  spaceId: string,
  parentPageId?: string,
) {
  return (
    await api.post("/templates/instantiate", {
      templateId,
      spaceId,
      parentPageId,
    })
  ).data;
}
