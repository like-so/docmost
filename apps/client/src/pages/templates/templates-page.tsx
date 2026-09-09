import {
  Alert,
  Button,
  Card,
  Group,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  TemplatePicker,
  type Template,
} from "@/features/template/components/template-picker";
import {
  createTemplate,
  deleteTemplate,
  instantiateTemplate,
  listTemplates,
  updateTemplate,
} from "@/features/template/services/template-service";

export default function TemplatesPage() {
  const client = useQueryClient();
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: listTemplates,
  });
  const [selected, setSelected] = useState<Template>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [spaceId, setSpaceId] = useState("");

  useEffect(() => {
    setTitle(selected?.title ?? "");
    setDescription(selected?.description ?? "");
  }, [selected]);

  const refresh = () => client.invalidateQueries({ queryKey: ["templates"] });
  const create = useMutation({
    mutationFn: () =>
      createTemplate({ title, description: description || undefined }),
    onSuccess: (template) => {
      setSelected(template);
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: () =>
      updateTemplate(selected!.id, {
        title,
        description: description || undefined,
      }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: () => deleteTemplate(selected!.id),
    onSuccess: () => {
      setSelected(undefined);
      setTitle("");
      setDescription("");
      void refresh();
    },
  });
  const instantiate = useMutation({
    mutationFn: () => instantiateTemplate(selected!.id, spaceId),
  });

  return (
    <Stack maw={760} mx="auto" p="md">
      <Title order={1}>Templates</Title>
      {templates.isError && (
        <Alert color="red">Unable to load templates.</Alert>
      )}
      <Card withBorder>
        <TemplatePicker
          selectedId={selected?.id}
          templates={templates.data ?? []}
          onSelect={(id) =>
            setSelected(templates.data?.find((template) => template.id === id))
          }
        />
      </Card>
      <Card withBorder>
        <Stack>
          <TextInput
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <TextInput
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <Group>
            <Button
              disabled={!title || create.isPending}
              onClick={() => create.mutate()}
            >
              Create template
            </Button>
            {selected && (
              <>
                <Button
                  disabled={!title || update.isPending}
                  onClick={() => update.mutate()}
                >
                  Save changes
                </Button>
                <Button
                  color="red"
                  variant="default"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Delete template
                </Button>
              </>
            )}
          </Group>
        </Stack>
      </Card>
      {selected && (
        <Card withBorder>
          <Stack>
            <TextInput
              label="Destination space ID"
              value={spaceId}
              onChange={(event) => setSpaceId(event.currentTarget.value)}
            />
            <Button
              disabled={!spaceId || instantiate.isPending}
              onClick={() => instantiate.mutate()}
            >
              Create page from template
            </Button>
            {instantiate.isSuccess && (
              <Alert color="green">Page created from template.</Alert>
            )}
            {instantiate.isError && (
              <Alert color="red">Unable to create the page.</Alert>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
