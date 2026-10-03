import React from 'react';
import { ChatMarkdownView } from '@/components/chat/presentation/ChatMarkdownView';
import { ChatAssistantTextView, ChatUserTextView, ChatReasoningTextView } from '@/components/chat/presentation/ChatTranscriptView';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ContentBlock } from '../contracts';

/** The original pipeline without legacy file probes, application links or runtime assets. */
export const NativeMarkdown = React.memo(function NativeMarkdown({ text, variant = 'assistant', isStreaming = false }: { readonly text: string; readonly variant?: 'user' | 'assistant' | 'reasoning'; readonly isStreaming?: boolean }) {
  const content = <ChatMarkdownView content={text} isStreaming={isStreaming} variant={variant === 'user' ? 'assistant' : variant} imageMode="label" safeLinks />;
  return variant === 'user' ? <ChatUserTextView>{content}</ChatUserTextView> : <ChatAssistantTextView>{content}</ChatAssistantTextView>;
});

function NativeImage({ block }: { readonly block: Extract<ContentBlock, { type: 'image' }> }) {
  const { t } = useI18n();
  const [failed, setFailed] = React.useState(false);
  // Native inline media is negotiated by the client; never load an arbitrary URI.
  if (failed || !/^image\/(?:png|jpeg|gif|webp)$/i.test(block.mimeType)) {
    return <p role="status" className="typography-meta text-muted-foreground">{t('omo.chat.imageUnavailable')}</p>;
  }
  return <img src={`data:${block.mimeType};base64,${block.data}`} alt={t('omo.chat.imageAlt')}
    className="max-h-96 max-w-full rounded-lg object-contain" onError={() => setFailed(true)} />;
}

export function NativeContent({ content, toolArguments, variant = 'assistant', isStreaming = false }: {
  readonly content: readonly ContentBlock[];
  readonly toolArguments?: ReadonlyMap<string, string>;
  readonly variant?: 'user' | 'assistant';
  readonly isStreaming?: boolean;
}) {
  const { t } = useI18n();
  return <div className="space-y-3">{content.map((block, index) => {
    switch (block.type) {
      case 'text': return <NativeMarkdown key={index} text={block.text} variant={variant} isStreaming={isStreaming} />;
      case 'thinking': return <details key={index} className="rounded-lg bg-surface-muted p-3" data-testid="omo-reasoning">
        <summary className="flex cursor-pointer items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="brain-ai-3" className="size-4" />{t('chat.reasoningTrace.thinking')}
        </summary>
        <ChatReasoningTextView outerClassName="max-h-80"><NativeMarkdown text={block.thinking} variant="reasoning" isStreaming={isStreaming} /></ChatReasoningTextView>
      </details>;
      case 'image': return <NativeImage key={`${index}:${block.mimeType}:${block.data}`} block={block} />;
      case 'toolCall': return <details key={block.id} className="rounded-lg border border-border p-3" data-tool-call-id={block.id}>
        <summary className="cursor-pointer break-words typography-meta font-medium">{block.name}</summary>
        <pre className="oc-surface-code mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words typography-code">
          {toolArguments?.get(block.id) ?? JSON.stringify(block.arguments, null, 2)}
        </pre>
      </details>;
      default: return block satisfies never;
    }
  })}</div>;
}
