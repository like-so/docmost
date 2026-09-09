import { Button, Group, Stack, Text } from "@mantine/core";

export type Template = {
  id: string;
  title: string;
  description?: string | null;
};

type Props = {
  selectedId?: string;
  templates: Template[];
  onSelect: (templateId: string) => void;
};

export function TemplatePicker({ selectedId, templates, onSelect }: Props) {
  if (!templates.length) return <Text c="dimmed">No templates yet.</Text>;

  return (
    <Stack gap="xs">
      {templates.map((template) => (
        <Group key={template.id} justify="space-between">
          <div>
            <Text fw={template.id === selectedId ? 600 : 400}>
              {template.title}
            </Text>
            {template.description && (
              <Text c="dimmed" size="sm">
                {template.description}
              </Text>
            )}
          </div>
          <Button variant="default" onClick={() => onSelect(template.id)}>
            Select
          </Button>
        </Group>
      ))}
    </Stack>
  );
}
