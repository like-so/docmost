import { Button, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listChats, type AiChat } from "../services/ai-service";

export default function AiChatSidebar() {
  const [chats, setChats] = useState<AiChat[]>([]);
  useEffect(() => {
    listChats()
      .then(setChats)
      .catch(() => setChats([]));
  }, []);
  return (
    <Stack p="md">
      <Button component={Link} to="/ai">
        New chat
      </Button>
      {chats.map((chat) => (
        <Text component={Link} to={`/ai/chat/${chat.id}`} key={chat.id}>
          {chat.title || "Untitled chat"}
        </Text>
      ))}
    </Stack>
  );
}
