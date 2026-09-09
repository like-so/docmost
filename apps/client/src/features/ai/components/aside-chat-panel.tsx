import { Stack, Text } from "@mantine/core";
import { useNavigate } from "react-router-dom";
import ChatInput from "./chat-input";

export default function AsideChatPanel() {
  const navigate = useNavigate();
  return (
    <Stack>
      <Text fw={600}>AI Chat</Text>
      <ChatInput
        onSend={(content) =>
          navigate("/ai", { state: { initialContent: content } })
        }
      />
    </Stack>
  );
}
