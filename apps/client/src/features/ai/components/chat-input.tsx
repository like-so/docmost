import {
  ActionIcon,
  Button,
  Group,
  Pill,
  Popover,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { IconPaperclip } from "@tabler/icons-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { searchAttachments } from "@/features/search/services/search-service";
import { IAttachmentSearch } from "@/features/search/types/search.types";
import { getFileUploadSizeLimit } from "@/lib/config";
import { userAtom } from "@/features/user/atoms/current-user-atom";

export type ChatAttachment = {
  id: string;
  fileName: string;
  fileExt?: string;
  fileSize?: number;
  mimeType?: string | null;
};
export type PageMention = { id: string; slugId: string; title: string };

const maxAttachments = 10;

export default function ChatInput({
  onSend,
  onUpload,
  disabled = false,
  placeholder = "Ask anything...",
}: {
  onSend: (
    content: string,
    mentions: PageMention[],
    attachments: ChatAttachment[],
  ) => void | Promise<void>;
  onUpload?: (file: File) => Promise<ChatAttachment>;
  disabled?: boolean;
  placeholder?: string;
  isStreaming?: boolean;
  onStop?: () => void;
  autofocus?: boolean;
}) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IAttachmentSearch[]>([]);
  const [sending, setSending] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const user = useAtomValue(userAtom);
  const fileInput = useRef<HTMLInputElement>(null);
  const canAttach = attachments.length < maxAttachments && !disabled && !sending;

  useEffect(() => {
    if (!pickerOpen || !query.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      searchAttachments({ query })
        .then((items) => active && setResults(items))
        .catch(() => active && setResults([]));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [pickerOpen, query]);

  const addAttachment = (attachment: ChatAttachment) => {
    setAttachments((current) =>
      current.some(({ id }) => id === attachment.id) ||
      current.length >= maxAttachments
        ? current
        : [...current, attachment],
    );
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !onUpload || !canAttach) return;
    if (file.size > getFileUploadSizeLimit()) {
      setUploadError("File exceeds the attachment limit");
      return;
    }
    try {
      addAttachment(await onUpload(file));
      setUploadError(undefined);
    } catch {
      setUploadError("Unable to upload this file");
    }
  };
  const send = async () => {
    if ((!content.trim() && attachments.length === 0) || disabled || sending)
      return;
    setSending(true);
    try {
      await onSend(content, [], attachments);
      setContent("");
      setAttachments([]);
    } finally {
      setSending(false);
    }
  };
  const removeAttachment = (id: string) => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  };
  return (
    <Stack gap="xs">
      {attachments.length > 0 && (
        <Group gap="xs">
          {attachments.map((attachment) => (
            <Pill
              key={attachment.id}
              withRemoveButton
              onRemove={() => removeAttachment(attachment.id)}
            >
              {attachment.fileName}
            </Pill>
          ))}
        </Group>
      )}
      {uploadError && (
        <Text c="red" size="sm">
          {uploadError}
        </Text>
      )}
      <Group align="end" wrap="nowrap">
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          hidden
          onChange={upload}
        />
        <Popover
          opened={pickerOpen}
          onChange={setPickerOpen}
          position="top-start"
        >
          <Popover.Target>
            <ActionIcon
              aria-label="Attach file"
              variant="default"
              disabled={!canAttach}
              onClick={() => setPickerOpen((open) => !open)}
            >
              <IconPaperclip size={16} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="xs" w={280}>
              {onUpload && (
                <Button
                  variant="light"
                  onClick={() => fileInput.current?.click()}
                >
                  Upload chat file
                </Button>
              )}
              <Text size="sm">Attach an accessible file</Text>
              <TextInput
                aria-label="Find existing attachment"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              {results
                .filter((result) => !user || result.creatorId === user.id)
                .map((result) => (
                  <Button
                    key={result.id}
                    variant="subtle"
                    justify="start"
                    onClick={() => {
                      addAttachment({ id: result.id, fileName: result.fileName });
                      setPickerOpen(false);
                    }}
                  >
                    {result.fileName}
                  </Button>
                ))}
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <Textarea
          aria-label="AI message"
          placeholder={placeholder}
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          style={{ flex: 1 }}
        />
        <Button
          onClick={() => void send()}
          disabled={
            disabled || sending || (!content.trim() && attachments.length === 0)
          }
        >
          Send
        </Button>
      </Group>
    </Stack>
  );
}
