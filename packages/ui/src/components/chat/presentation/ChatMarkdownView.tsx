// allow: SIZE_OK - The original block-render lifecycle stays intact under one DOM owner; splitting its cache, revision and reveal state would obscure the extraction.
import React from 'react';
import morphdom from 'morphdom';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import { FadeInOnReveal } from '../message/FadeInOnReveal';
import { getCachedMarkdownBlocks, renderMarkdownBlocks, renderMarkdownSync, type MarkdownImageMode, type MarkdownRawHtmlMode } from '../markdown/markdownCore';
import { ensureMarkdownShikiTheme } from '../markdown/markdownTheme';
import { getMarkdownSyntaxVars } from '../markdown/markdownSyntaxVars';
import { attachMarkdownInteractions, applyMarkdownCodeBlockWrapState, decorateMarkdown, stabilizeMarkdownTableWidths, type DecorateContext, type DecorateLabels } from '../markdown/decorate';
import { createMermaidViewerRegistry, shouldRefreshMermaidViewers } from '../markdown/mermaidViewer';
import { detachedMarkdownDomCache, type DetachedMarkdownDomKey } from '../markdown/detachedMarkdownDomCache';
import { TimelineRevealGateContext } from '../timelineRevealGate';
import { streamPerfCount } from '@/stores/utils/streamDebug';

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

const MARKDOWN_DECORATION_ID_ATTR = 'data-md-decoration-id';

// True when the container already holds exactly these settled blocks with the
// current decoration. The first paint of a remounted message is served from
// the block cache; when that paint is already final, the async render would
// only parse, highlight, sanitize, and morph the same HTML into place again.
/**
 * Marks the last block wrapper so CSS can trim its trailing margin by
 * attribute. `[data-md-block]:last-child` in a non-subject position made
 * Chrome restyle the whole subtree of any element that stopped being a last
 * child, which included the app root every time a tooltip or menu portal was
 * appended to <body>.
 */
const markLastMarkdownBlock = (target: HTMLElement): void => {
  const last = target.lastElementChild;
  for (const child of Array.from(target.children)) {
    if (child !== last && child.hasAttribute('data-md-last')) child.removeAttribute('data-md-last');
  }
  if (last?.hasAttribute('data-md-block') && !last.hasAttribute('data-md-last')) {
    last.setAttribute('data-md-last', '');
  }
};

const domMatchesRenderedBlocks = (
  target: HTMLElement,
  blocks: ReadonlyArray<{ id: string }>,
  decorationId: string,
): boolean => {
  const children = target.children;
  if (children.length !== blocks.length) return false;
  for (let index = 0; index < blocks.length; index += 1) {
    const child = children[index];
    if (
      !child
      || child.getAttribute('data-md-id') !== blocks[index]?.id
      || child.getAttribute(MARKDOWN_DECORATION_ID_ATTR) !== decorationId
    ) {
      return false;
    }
  }
  return true;
};
const MARKDOWN_DECORATION_IDS = new WeakMap<DecorateContext, string>();
let nextMarkdownDecorationId = 0;
export const MARKDOWN_DOM_CACHE_MAX_SOURCE_CHARS = 200_000;

const getMarkdownDecorationId = (ctx: DecorateContext): string => {
  const existing = MARKDOWN_DECORATION_IDS.get(ctx);
  if (existing) return existing;
  const id = `decoration-${nextMarkdownDecorationId}`;
  nextMarkdownDecorationId += 1;
  MARKDOWN_DECORATION_IDS.set(ctx, id);
  return id;
};

const useMorphdomMarkdown = ({
  containerRef,
  text,
  streaming,
  imageMode = 'inline',
  rawHtml = 'escape',
  syntaxVars,
  ctx,
  domCacheKey,
  tableLayoutSettled,
  safeLinks,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  text: string;
  streaming: boolean;
  imageMode?: MarkdownImageMode;
  rawHtml?: MarkdownRawHtmlMode;
  syntaxVars: Record<string, string>;
  ctx: DecorateContext;
  domCacheKey?: DetachedMarkdownDomKey | null;
  tableLayoutSettled: boolean;
  safeLinks: boolean;
}) => {
  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  const decorateBlock = React.useCallback((root: HTMLElement) => {
    // The original decorator adds favicons when an external href is present.
    // Hide native hrefs during decoration so no detached image can start a fetch.
    const links = safeLinks ? Array.from(root.querySelectorAll('a')).map((anchor) => ({ anchor, href: anchor.getAttribute('href') })) : [];
    for (const { anchor } of links) anchor.removeAttribute('href');
    decorateMarkdown(root, ctx);
    for (const { anchor, href } of links) {
      if (href && /^https?:\/\//i.test(href)) {
        anchor.setAttribute('href', href); anchor.setAttribute('target', '_blank'); anchor.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (safeLinks) {
      for (const image of root.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
    }
  }, [ctx, safeLinks]);

  const mermaidViewerRef = React.useRef<ReturnType<typeof createMermaidViewerRegistry> | null>(null);
  const renderRevisionRef = React.useRef(0);
  const tableLayoutFrameRef = React.useRef<number | null>(null);
  // A provisional first paint (blocks not in the settled cache) holds the
  // timeline reveal until the async render lands, so the session opens with
  // final code highlighting instead of a visible restyle.
  const revealGate = React.useContext(TimelineRevealGateContext);
  const releaseRevealHoldRef = React.useRef<(() => void) | null>(null);
  const releaseRevealHold = React.useCallback(() => {
    releaseRevealHoldRef.current?.();
    releaseRevealHoldRef.current = null;
  }, []);
  React.useEffect(() => releaseRevealHold, [releaseRevealHold]);
  // Only DOM that was actually restored or completed by the async pipeline is
  // eligible for capture. A fallback from an earlier content revision is not.
  const mountedDomRef = React.useRef<{
    key: DetachedMarkdownDomKey;
    copiedLabel: string;
  } | null>(null);
  const refreshMermaidViewers = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!mermaidViewerRef.current) {
      if (!shouldRefreshMermaidViewers(container)) {
        return;
      }
      mermaidViewerRef.current = createMermaidViewerRegistry(container);
      return;
    }
    mermaidViewerRef.current.refresh();
  }, [containerRef]);
  const scheduleTableLayout = React.useCallback(() => {
    if (!tableLayoutSettled) return;
    const previousFrame = tableLayoutFrameRef.current;
    if (previousFrame !== null) window.cancelAnimationFrame(previousFrame);
    const renderRevision = renderRevisionRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (tableLayoutFrameRef.current !== frame) return;
      tableLayoutFrameRef.current = null;
      if (renderRevisionRef.current !== renderRevision) return;
      const container = containerRef.current;
      const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
      if (target) stabilizeMarkdownTableWidths(target);
    });
    tableLayoutFrameRef.current = frame;
  }, [containerRef, tableLayoutSettled]);

  React.useEffect(() => () => {
    const frame = tableLayoutFrameRef.current;
    if (frame === null) return;
    window.cancelAnimationFrame(frame);
    tableLayoutFrameRef.current = null;
  }, []);

  React.useLayoutEffect(() => {
    renderRevisionRef.current += 1;
    mountedDomRef.current = null;
  }, [ctx, imageMode, rawHtml, streaming, text]);

  React.useLayoutEffect(() => {
    if (!domCacheKey) return;
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target || target.childNodes.length > 0) return;

    const cached = detachedMarkdownDomCache.take(domCacheKey);
    if (cached) {
      target.appendChild(cached);
      markLastMarkdownBlock(target);
      const decorationId = getMarkdownDecorationId(ctx);
      for (const block of Array.from(target.children)) {
        block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
      }
      for (const [key, value] of Object.entries(syntaxVars)) target.style.setProperty(key, value);
      applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
      mountedDomRef.current = {
        key: domCacheKey,
        copiedLabel: ctx.labels.copied,
      };
      streamPerfCount('ui.markdown_renderer.dom_cache.hit');
    }
  }, [containerRef, ctx, domCacheKey, syntaxVars, text.length]);

  // Restoration follows the cache identity above, but capture must only happen
  // when this renderer lifecycle ends. Combining both in one keyed effect would
  // detach the live DOM on ordinary content, theme, or locale updates.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    return () => {
      const mountedDom = mountedDomRef.current;
      if (!mountedDom) return;
      // Viewer controllers and transient interaction state belong to the
      // current renderer instance and must not cross the cache boundary.
      if (target.childNodes.length === 0 || shouldRefreshMermaidViewers(target)) return;
      if (Array.from(target.children).some((block) => !block.hasAttribute('data-md-id'))) return;
      if (target.querySelector('[data-md-copy-pending]')) return;
      const selection = window.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(target)) return;
      const openMenu = target.querySelector<HTMLElement>('[data-md-menu]:not(.hidden)');
      const copiedButton = Array.from(target.querySelectorAll<HTMLButtonElement>('[data-md-action]'))
        .some((button) => button.getAttribute('title') === mountedDom.copiedLabel);
      if (openMenu || copiedButton) return;

      const fragment = document.createDocumentFragment();
      fragment.append(...Array.from(target.childNodes));
      detachedMarkdownDomCache.store({ ...mountedDom.key, fragment });
      streamPerfCount('ui.markdown_renderer.dom_cache.capture');
    };
  }, [containerRef]);

  // Synchronous first paint: while the async parse is in-flight, show escaped
  // plain text immediately so there is no blank frame on initial mount. Only
  // runs when the target is empty — subsequent updates keep the prior rich DOM
  // until the next async render morphs in (no flash). Mirrors OpenCode's
  // `initialValue: fallback(text)` resource pattern.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    const decorationId = getMarkdownDecorationId(ctx);
    if (text && target.childNodes.length === 0) {
      const cachedBlocks = !streaming ? getCachedMarkdownBlocks(text, imageMode, rawHtml) : null;
      if (cachedBlocks) {
        let hasMermaidBlock = false;
        for (const cachedBlock of cachedBlocks) {
          const block = document.createElement('div');
          block.setAttribute('data-md-block', '');
          block.style.display = 'contents';
          block.innerHTML = cachedBlock.html;
decorateBlock(block);
          block.setAttribute('data-md-id', cachedBlock.id);
          block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
          hasMermaidBlock ||= shouldRefreshMermaidViewers(block);
          target.appendChild(block);
        }
        if (hasMermaidBlock) refreshMermaidViewers();
      } else {
        if (!streaming && !releaseRevealHoldRef.current) {
          releaseRevealHoldRef.current = revealGate?.hold() ?? null;
        }
        const block = document.createElement('div');
        block.setAttribute('data-md-block', '');
        block.style.display = 'contents';
        block.innerHTML = renderMarkdownSync(text, imageMode, rawHtml);
        decorateBlock(block);
        block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
        target.appendChild(block);
        if (shouldRefreshMermaidViewers(block)) refreshMermaidViewers();
      }
      markLastMarkdownBlock(target);
    } else if (!mermaidViewerRef.current && shouldRefreshMermaidViewers(target)) {
      // StrictMode re-runs this setup after the cleanup probe. The DOM remains,
      // but the viewer registry does not, so recreate it without reinstalling
      // or re-decorating ordinary blocks.
      refreshMermaidViewers();
    }
  }, [containerRef, text, streaming, imageMode, rawHtml, ctx, decorateBlock, refreshMermaidViewers, revealGate]);

  React.useEffect(() => () => {
    mermaidViewerRef.current?.cleanup();
    mermaidViewerRef.current = null;
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    let active = true;
    const renderRevision = renderRevisionRef.current;
    const decorationId = getMarkdownDecorationId(ctx);

    if (!streaming) {
      const cachedBlocks = getCachedMarkdownBlocks(text, imageMode, rawHtml);
      if (cachedBlocks && domMatchesRenderedBlocks(target, cachedBlocks, decorationId)) {
        mountedDomRef.current = domCacheKey
          ? { key: domCacheKey, copiedLabel: ctx.labels.copied }
          : null;
        streamPerfCount('ui.markdown_renderer.settled_paint.reused');
        scheduleTableLayout();
        releaseRevealHold();
        return;
      }
    }

    void renderMarkdownBlocks(text, streaming, imageMode, rawHtml).then((blocks) => {
      if (!active || renderRevisionRef.current !== renderRevision) return;
      const existing = Array.from(target.children).filter((element): element is HTMLElement => element instanceof HTMLElement);
      // Capture before block reconciliation: streaming completion changes the
      // wrapper layout, and theme changes can replace entire decorated blocks.
      // Match by disclosure order plus heading so unrelated replacements cannot
      // inherit the previous disclosure's state. No persistent/global state.
      const disclosureStates = Array.from(target.querySelectorAll<HTMLDetailsElement>('details[data-md-details]'))
        .map((details) => ({ summary: details.querySelector('summary')?.textContent, open: details.open }));

      // Reconcile per block: only re-morph blocks whose content changed, leaving
      // stable leading blocks untouched. Keeps per-stream-step DOM work bounded
      // to the trailing (growing) block instead of the whole message.
      let enteredThisPass = 0;
      blocks.forEach((block, index) => {
        let el = existing[index];
        let isNewBlock = false;
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-md-block', '');
          el.style.display = 'contents';
          target.appendChild(el);
          isNewBlock = true;
        }
        if (el.getAttribute('data-md-id') === block.id) {
          if (el.getAttribute(MARKDOWN_DECORATION_ID_ATTR) !== decorationId) {
            const hasMermaidBlock = shouldRefreshMermaidViewers(el);
            if (hasMermaidBlock) {
              mermaidViewerRef.current?.cleanup();
              mermaidViewerRef.current = null;
            }
            const replacement = document.createElement('div');
            replacement.setAttribute('data-md-block', '');
            replacement.style.display = 'contents';
            replacement.innerHTML = block.html;
decorateBlock(replacement);
            replacement.setAttribute('data-md-id', block.id);
            replacement.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
            el.replaceWith(replacement);
            if (hasMermaidBlock || shouldRefreshMermaidViewers(replacement)) refreshMermaidViewers();
          }
          if (!mermaidViewerRef.current && shouldRefreshMermaidViewers(el)) {
            refreshMermaidViewers();
          }
          return;
        }

        const temp = document.createElement('div');
        temp.innerHTML = block.html;
decorateBlock(temp);
        if (isNewBlock && streaming && index > 0) {
          // A freshly committed block enters with a short reveal. The class
          // goes on the block's children — the wrapper is display:contents
          // and cannot animate — and the transform never changes layout, so
          // row measurement stays exact. Skipped for the first block so a
          // full initial render does not shimmer. Several blocks committed
          // in one tick cascade with a small stagger instead of popping in
          // together.
          const delayMs = Math.min(enteredThisPass, 4) * 55;
          enteredThisPass += 1;
          for (const child of Array.from(temp.children)) {
            child.classList.add('oc-md-block-enter');
            if (delayMs > 0 && child instanceof HTMLElement) {
              child.style.setProperty('--oc-md-enter-delay', `${delayMs}ms`);
            }
          }
        }
        const hadMermaidBlock = shouldRefreshMermaidViewers(el);
        const tempHasMermaidBlock = shouldRefreshMermaidViewers(temp);
        morphdom(el, temp, {
          childrenOnly: true,
          onBeforeElUpdated: (fromEl, toEl) => {
            if (fromEl.matches('details[data-md-details]') && toEl.matches('details[data-md-details]')
              && fromEl.querySelector('summary')?.textContent === toEl.querySelector('summary')?.textContent) {
              toEl.toggleAttribute('open', fromEl.hasAttribute('open'));
            }
            return !fromEl.isEqualNode(toEl);
          },
        });
        el.setAttribute('data-md-id', block.id);
        el.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
        if (hadMermaidBlock || tempHasMermaidBlock || shouldRefreshMermaidViewers(el)) {
          refreshMermaidViewers();
        }
      });

      const hadMermaidBeforeTrailingCleanup = shouldRefreshMermaidViewers(target);
      let removedMermaidBlock = false;
      for (let i = existing.length - 1; i >= blocks.length; i -= 1) {
        const removed = existing[i];
        if (removed && shouldRefreshMermaidViewers(removed)) {
          removedMermaidBlock = true;
        }
        removed?.remove();
      }
      markLastMarkdownBlock(target);
      if (removedMermaidBlock || (existing.length > blocks.length && hadMermaidBeforeTrailingCleanup)) {
        refreshMermaidViewers();
      }
      if (disclosureStates.length > 0) {
        target.querySelectorAll<HTMLDetailsElement>('details[data-md-details]').forEach((details, index) => {
          const previous = disclosureStates[index];
          if (previous && previous.summary === details.querySelector('summary')?.textContent) {
            details.open = previous.open;
          }
        });
      }
      mountedDomRef.current = domCacheKey
        ? { key: domCacheKey, copiedLabel: ctx.labels.copied }
        : null;
      scheduleTableLayout();
      releaseRevealHold();
    });

    return () => {
      active = false;
    };
  }, [containerRef, ctx, decorateBlock, domCacheKey, imageMode, rawHtml, refreshMermaidViewers, releaseRevealHold, scheduleTableLayout, streaming, text]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachMarkdownInteractions(container, ctx);
  }, [containerRef, ctx]);

  // Apply syntax CSS variables imperatively so they survive morphdom updates.
  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    for (const [key, value] of Object.entries(syntaxVars)) {
      target.style.setProperty(key, value);
    }
  }, [containerRef, syntaxVars]);

  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (ctx.deferCodeLineNumberSync) return;
    applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
  }, [containerRef, ctx.codeBlockLineWrap, ctx.deferCodeLineNumberSync, ctx.labels]);

};

const markdownContentClassName = (variant: MarkdownVariant): string =>
  variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';


export interface ChatMarkdownViewProps {
  readonly content: string;
  readonly containerRef?: React.RefObject<HTMLDivElement | null>;
  readonly className?: string;
  readonly isStreaming?: boolean;
  readonly variant?: MarkdownVariant;
  readonly imageMode?: MarkdownImageMode;
  readonly rawHtml?: MarkdownRawHtmlMode;
  readonly ctx?: DecorateContext;
  readonly syntaxVars?: Record<string, string>;
  readonly domCacheKey?: DetachedMarkdownDomKey | null;
  readonly isAnimated?: boolean;
  readonly skipFadeIn?: boolean;
  readonly fadeKey?: string;
  /** Native output never binds app/file links or runtime asset handlers. */
  readonly safeLinks?: boolean;
}

export function ChatMarkdownView({ content, containerRef: suppliedRef, className, isStreaming = false,
  variant = 'assistant', imageMode = 'label', rawHtml = 'escape', ctx: suppliedContext, syntaxVars: suppliedSyntax, domCacheKey,
  isAnimated = false, skipFadeIn = false, fadeKey, safeLinks = false }: ChatMarkdownViewProps) {
  const innerRef = React.useRef<HTMLDivElement>(null);
  const containerRef = suppliedRef ?? innerRef;
  const themeSystem = useOptionalThemeSystem();
  const theme = themeSystem?.currentTheme ?? getDefaultTheme(false);
  const { t } = useI18n();
  const labels: DecorateLabels = React.useMemo(() => ({
    copy: t('markdownRenderer.code.actions.copyTitle'),
    copied: t('markdownRenderer.code.actions.copiedTitle'),
    enableCodeWrap: t('markdownRenderer.code.actions.enableWrapTitle'),
    disableCodeWrap: t('markdownRenderer.code.actions.disableWrapTitle'),
    copyTable: t('markdownRenderer.table.actions.copyTitle'),
    downloadTable: t('markdownRenderer.table.actions.downloadTitle'),
    copyDiagram: t('markdownRenderer.mermaid.actions.copySourceTitle'),
    downloadDiagram: t('markdownRenderer.mermaid.actions.downloadSvgTitle'),
    zoomInDiagram: t('markdownRenderer.mermaid.actions.zoomInTitle'),
    zoomOutDiagram: t('markdownRenderer.mermaid.actions.zoomOutTitle'),
    resetDiagramView: t('markdownRenderer.mermaid.actions.resetViewTitle'),
    previewLabel: t('terminalView.preview.open'),
    previewTitle: t('terminalView.preview.openTitle'),
  }), [t]);


  const defaultContext = React.useMemo<DecorateContext>(() => ({ labels,
    mermaidControls: { download: false, copy: true, showPanZoomControls: false },
    codeBlockLineWrap: false, deferCodeLineNumberSync: isStreaming,
    renderMermaid: (source) => {
      try { return { svg: renderMermaidSVG(source, { bg: theme.colors.surface.elevated, fg: theme.colors.surface.foreground, transparent: true }) }; }
      catch { return { ascii: source }; }
    },
  }), [labels, isStreaming, theme]);
  const syntaxVars = React.useMemo(() => suppliedSyntax ?? getMarkdownSyntaxVars(theme), [suppliedSyntax, theme]);
  const ctx = suppliedContext ?? defaultContext;
  useMorphdomMarkdown({ containerRef, text: content, streaming: isStreaming, imageMode, rawHtml, syntaxVars, ctx, domCacheKey, tableLayoutSettled: !isStreaming, safeLinks });
  React.useLayoutEffect(() => {
    if (!safeLinks || !containerRef.current) return;
    const guard = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor) return;
      if (!/^https?:\/\//i.test(anchor.getAttribute('href') ?? '')) { event.preventDefault(); event.stopPropagation(); }
    };
    const node = containerRef.current;
    node.addEventListener('click', guard, true);
    return () => node.removeEventListener('click', guard, true);
  }, [safeLinks, containerRef]);
  const body = <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
    <div className={markdownContentClassName(variant)} data-markdown-content data-markdown-html={rawHtml === 'sanitize' ? '' : undefined} />
  </div>;
  return isAnimated ? <FadeInOnReveal key={fadeKey} skipAnimation={skipFadeIn}>{body}</FadeInOnReveal> : body;
}
