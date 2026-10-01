import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ContentBlock } from '../contracts';

const markdownPlugins = [remarkGfm];

/** No legacy renderer, local-file resolution, remote images, or app-link actions. */
export const NativeMarkdown = React.memo(function NativeMarkdown({ text }: { readonly text: string }) {
  return <div className="markdown-content typography-markdown break-words [&_table]:block [&_table]:overflow-x-auto">
    <Markdown remarkPlugins={markdownPlugins} urlTransform={(url) => /^https?:\/\//i.test(url) ? url : ''}
      components={{
        img: ({ alt }) => <span className="typography-meta text-muted-foreground">{alt}</span>,
        a: ({ href, children }) => href
          ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--primary-text)] underline">{children}</a>
          : <span>{children}</span>,
        pre: ({ children }) => <pre className="oc-surface-code max-h-96 overflow-auto rounded-lg bg-[var(--syntax-background)] p-3 typography-code">{children}</pre>,
      }}>{text}</Markdown>
  </div>;
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

export function NativeContent({ content, toolArguments }: {
  readonly content: readonly ContentBlock[];
  readonly toolArguments?: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  return <div className="space-y-3">{content.map((block, index) => {
    switch (block.type) {
      case 'text': return <NativeMarkdown key={index} text={block.text} />;
      case 'thinking': return <details key={index} className="rounded-lg bg-surface-muted p-3" data-testid="omo-reasoning">
        <summary className="flex cursor-pointer items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="brain-ai-3" className="size-4" />{t('chat.reasoningTrace.thinking')}
        </summary>
        <div className="mt-3 max-h-80 overflow-auto"><NativeMarkdown text={block.thinking} /></div>
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
