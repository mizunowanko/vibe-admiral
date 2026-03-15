import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Send, X, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ImageAttachment } from "@/types";

const ACCEPTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type ImageMediaType = ImageAttachment["mediaType"];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
const MAX_IMAGES = 10;

function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip "data:<mime>;base64," prefix
      const base64 = dataUrl.split(",")[1]!;
      resolve({ base64, mediaType: file.type as ImageMediaType });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface BridgeInputProps {
  onSend: (message: string, images?: ImageAttachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

const MAX_ROWS = 6;
const LINE_HEIGHT = 20;
const PADDING_Y = 8;

export function BridgeInput({
  onSend,
  disabled,
  placeholder = "Send a command to the Bridge...",
}: BridgeInputProps) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING_Y;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    resetHeight();
  }, [value, resetHeight]);

  const addImages = useCallback(async (files: File[]) => {
    const valid = files.filter(
      (f) => ACCEPTED_TYPES.has(f.type) && f.size <= MAX_IMAGE_BYTES,
    );
    if (valid.length === 0) return;
    const attachments = await Promise.all(valid.map(fileToAttachment));
    setImages((prev) => [...prev, ...attachments].slice(0, MAX_IMAGES));
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    onSend(trimmed || "(image)", images.length > 0 ? images : undefined);
    setValue("");
    setImages([]);
  }, [value, images, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && ACCEPTED_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        addImages(imageFiles);
      }
    },
    [addImages],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      addImages(files);
    },
    [addImages],
  );

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      addImages(files);
      // Reset so re-selecting the same file works
      e.target.value = "";
    },
    [addImages],
  );

  const canSend = !disabled && (value.trim() || images.length > 0);

  return (
    <div
      className={cn(
        "border-t border-border",
        dragOver && "bg-primary/5 border-primary/30",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Image Previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-3 pb-1 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={`data:${img.mediaType};base64,${img.base64}`}
                alt={`Attachment ${i + 1}`}
                className="h-16 w-16 rounded border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input Row */}
      <div className="flex gap-2 p-3 items-end">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={handleFileSelect}
          disabled={disabled}
          title="Attach image"
          className="shrink-0"
        >
          <ImageIcon className="h-4 w-4" />
        </Button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
            "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <Button
          onClick={handleSend}
          disabled={!canSend}
          size="icon"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
