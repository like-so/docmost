import { Button, Menu } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";

const actions = [
  "Improve writing",
  "Fix spelling and grammar",
  "Make longer",
  "Make shorter",
  "Continue writing",
  "Explain",
  "Summarize",
  "Professional tone",
  "Casual tone",
  "Friendly tone",
  "Translate",
];

export function EditorAiMenu({
  editor,
}: {
  editor: {
    state?: {
      doc?: {
        textBetween?: (
          from: number,
          to: number,
          blockSeparator?: string,
        ) => string;
      };
      selection?: { from: number; to: number };
    };
  };
}) {
  const navigate = useNavigate();
  const ask = (action: string) => {
    const selection = editor.state?.selection;
    const text =
      selection &&
      editor.state?.doc?.textBetween?.(selection.from, selection.to, " ");
    navigate("/ai", {
      state: { initialContent: text ? `${action}:\n${text}` : action },
    });
  };
  return (
    <Menu shadow="md">
      <Menu.Target>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconSparkles size={14} />}
        >
          Ask AI
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {actions.map((action) => (
          <Menu.Item key={action} onClick={() => ask(action)}>
            {action}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
