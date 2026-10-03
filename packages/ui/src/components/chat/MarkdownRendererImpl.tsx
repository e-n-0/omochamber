import React from 'react';
import { ChatMarkdownView, MARKDOWN_DOM_CACHE_MAX_SOURCE_CHARS } from './presentation/ChatMarkdownView';

import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import type { Part } from '@/lib/opencode/model';

import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { openAppLinkWithConfirmation } from './appLinkConfirmation';
import { attachAppLinkInteractions } from './appLinkInteractions';
import { attachFileRefClickGuard, FILE_REFERENCE_LINK_SELECTOR } from './fileRefClickGuard';
import type { ToolPopupContent } from './message/types';

import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import type { MarkdownImageMode } from './markdown/markdownCore';

import { getMarkdownSyntaxVars } from './markdown/markdownSyntaxVars';
import {



  getMarkdownCodeText,

  type DecorateContext,
  type DecorateLabels,
  type MermaidControlOptions,
  type MermaidRender,
} from './markdown/decorate';
import { findTextPosition } from './markdown/textPosition';
import { MERMAID_BLOCK_SELECTOR } from './markdown/mermaidViewer';
import {
  BLOCK_PATH_TOKEN_RE,
  isAbsoluteReferencePath,
  localPathFromFileUrl,
  normalizeReferencePath,
  parseFileReference,
  type ParsedFileReference,
} from './fileReferenceParser';
import { fileReferenceExists } from './fileReferenceStat';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import type { DetachedMarkdownDomKey } from './markdown/detachedMarkdownDomCache';

import { getRuntimeKey } from '@/lib/runtime-switch';

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
};

const useLinkInteractions = ({
  containerRef,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    return attachAppLinkInteractions(container, {
      allowExternalHttp: enabled !== false,
      openAppLink: (href) => void openAppLinkWithConfirmation(href),
      openExternalHttp: (href) => void openExternalUrl(href),
    });
  }, [containerRef, enabled]);
};

const DEFAULT_MERMAID_CONTROLS: MermaidControlOptions = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};
const DEFAULT_MERMAID_FULLSCREEN_ENABLED = true;

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const BLOCK_PATH_TOKEN_ATTR = 'data-openchamber-block-path-token';
const BLOCK_PATH_TOKEN_SELECTOR = `[${BLOCK_PATH_TOKEN_ATTR}]`;
const CODE_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-block-paths-scanned';
// Matches `path[:line[:col]]` or `path:start-end` inside shell/grep-style
// output. The regex is defined in `./fileReferenceParser`; the inline-code
// pipeline reads full text content rather than using this regex.
const MAX_BLOCK_CODE_SCAN_LENGTH = 200_000;
const FILE_REFERENCE_LINK_LIMIT = 80;
const VSCODE_FILE_REFERENCE_LINK_LIMIT = 40;
const FILE_REFERENCE_ANNOTATION_DELAY_MS = 160;

const getFileReferenceLinkLimit = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_LINK_LIMIT : FILE_REFERENCE_LINK_LIMIT
);

const KNOWN_FILE_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  '.env',
  '.gitignore',
  '.npmrc',
]);

const normalizePath = (value: string): string => {
  return normalizeReferencePath(value);
};

const isAbsolutePath = (value: string): boolean => {
  return isAbsoluteReferencePath(value);
};

const toAbsolutePath = (basePath: string, targetPath: string): string => {
  return toAbsoluteFilePath(basePath, targetPath);
};

const hasFileExtension = (path: string): boolean => {
  const base = path.split('/').filter(Boolean).pop() ?? '';
  if (!base || base.endsWith('.')) {
    return false;
  }
  return /\.[A-Za-z0-9_-]{1,16}$/.test(base);
};

const isLikelyFilePathValue = (path: string): boolean => {
  if (!path || path.startsWith('--') || path.includes('://')) {
    return false;
  }

  if (/[<>]/.test(path) || /\s{2,}/.test(path)) {
    return false;
  }

  const normalized = normalizePath(path);
  const baseName = normalized.split('/').filter(Boolean).pop() ?? normalized;
  if (!baseName || baseName === '.' || baseName === '..') {
    return false;
  }

  const base = baseName.toLowerCase();
  if (KNOWN_FILE_BASENAMES.has(base) || (base.startsWith('.') && base.length > 1)) {
    return true;
  }

  return hasFileExtension(normalized);
};

const isLikelyFilePath = (value: string): boolean => {
  const parsed = parseFileReference(value);
  if (!parsed) {
    return false;
  }
  return isLikelyFilePathValue(parsed.path);
};

const unwrapBlockCodePathTokens = (container: HTMLElement): void => {
  const tokenSpans = container.querySelectorAll<HTMLElement>(BLOCK_PATH_TOKEN_SELECTOR);
  for (const span of Array.from(tokenSpans)) {
    span.replaceWith(container.ownerDocument.createTextNode(span.textContent ?? ''));
  }

  const scannedBlocks = container.querySelectorAll<HTMLElement>(`code[${CODE_BLOCK_PATH_SCANNED_ATTR}]`);
  for (const codeBlock of Array.from(scannedBlocks)) {
    codeBlock.removeAttribute(CODE_BLOCK_PATH_SCANNED_ATTR);
    codeBlock.normalize();
  }
};

const extractPathCandidateFromElement = (element: HTMLElement): string => {
  if (element.tagName.toLowerCase() === 'a') {
    const href = element.getAttribute('href')?.trim();
    const fileUrlPath = href ? localPathFromFileUrl(href) : null;
    if (fileUrlPath) {
      return fileUrlPath;
    }
    if (href && isLikelyFilePath(href)) {
      return href;
    }
  }

  return (element.textContent || '').trim();
};

// A click can land before the async annotation marks a file reference
// (debounce + filesystem stat per candidate). Extract the href-derived
// candidate so the click guard can still route it to the file viewer instead
// of letting the renderer's `target="_blank"` open a new app window.
// Unlike `extractPathCandidateFromElement`, this never falls back to the link
// text: a link whose *text* is a path but whose href is a real URL keeps its
// URL behavior.
const extractHrefFileReferenceCandidate = (anchor: HTMLAnchorElement): string | null => {
  const href = anchor.getAttribute('href')?.trim();
  if (!href) {
    return null;
  }
  const fileUrlPath = localPathFromFileUrl(href);
  if (fileUrlPath) {
    return fileUrlPath;
  }
  return isLikelyFilePath(href) ? href : null;
};

// Walks text nodes inside `<pre><code>` subtrees and wraps any substring that
// looks like a `path[:line[:col]]` reference in a span carrying
// `data-openchamber-block-path-token`. `annotateFileLinks` then promotes those
// spans into clickable file links via the same existing pipeline used for
// inline code (parseFileReference → fileReferenceExists → openFileReference).
//
// Idempotent: each `<code>` node is marked with
// `data-openchamber-block-paths-scanned` once processed so the walk is not
// repeated on the same element. When the renderer replaces the `<code>` subtree
// (e.g. on content change during streaming), the new element lacks the marker and
// will be rescanned on the next mutation-observer callback.
const wrapBlockCodePathTokens = (container: HTMLElement): void => {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre code');
  if (codeBlocks.length === 0) {
    return;
  }

  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  for (const codeBlock of Array.from(codeBlocks)) {
    if (codeBlock.getAttribute(CODE_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }

    // Skip absurdly large code blocks to keep DOM work bounded.
    if ((codeBlock.textContent ?? '').length > MAX_BLOCK_CODE_SCAN_LENGTH) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      const textNode = currentNode as Text;
      if (!textNode.parentElement?.closest('[data-md-code-line-number]')) {
        textNodes.push(textNode);
      }
      currentNode = walker.nextNode();
    }

    const fullText = getMarkdownCodeText(codeBlock);
    if (!fullText.includes('.')) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    BLOCK_PATH_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; raw: string }> = [];
    let match: RegExpExecArray | null = BLOCK_PATH_TOKEN_RE.exec(fullText);
    while (match) {
      const raw = match[0];
      if (raw && isLikelyFilePath(raw)) {
        matches.push({ start: match.index, end: match.index + raw.length, raw });
      }
      match = BLOCK_PATH_TOKEN_RE.exec(fullText);
    }

    for (const { start, end, raw } of matches.reverse()) {
      const startPosition = findTextPosition(textNodes, start, 'right');
      const endPosition = findTextPosition(textNodes, end, 'left');
      if (!startPosition || !endPosition) {
        continue;
      }

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;

      range.deleteContents();
      range.insertNode(span);
    }

    codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

const getResolvedReference = (rawValue: string, effectiveDirectory: string): (ParsedFileReference & { resolvedPath: string }) | null => {
  const parsed = parseFileReference(rawValue);
  if (!parsed || !isLikelyFilePathValue(parsed.path)) {
    return null;
  }

  const resolvedPath = isAbsolutePath(parsed.path)
    ? normalizePath(parsed.path)
    : toAbsolutePath(effectiveDirectory, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  return {
    ...parsed,
    resolvedPath,
  };
};

const getContextDirectory = (effectiveDirectory: string, resolvedPath: string): string => {
  return effectiveDirectory || getDirectoryForFilePath(effectiveDirectory, resolvedPath);
};

const useFileReferenceInteractions = ({
  containerRef,
  effectiveDirectory,
  editor,
  preferRuntimeEditor,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  editor?: EditorAPI;
  preferRuntimeEditor?: boolean;
  enabled: boolean;
}) => {
  const annotationDebounceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // Wait for the real directory: annotating against an empty/fallback
    // directory issues stat probes under the wrong cache key (and the wrong
    // server directory), and the pass reruns anyway once the directory
    // resolves — every link ended up verified twice.
    if (enabled && !effectiveDirectory) {
      return;
    }
    let cancelled = false;
    const fileReferenceLinkLimit = getFileReferenceLinkLimit();
    // On mobile surfaces, file-reference highlighting is disabled entirely — not
    // just visually. The annotation pass is what issues the filesystem `stat`
    // probes (fileReferenceExists → /api/fs/stat), so skipping it here guarantees
    // no probe requests are ever sent from a mobile runtime.
    const fileReferencesEnabled = enabled && !isMobileSurfaceRuntime();

    const clearFileLinkAttributes = (candidate: HTMLElement) => {
      candidate.removeAttribute('data-openchamber-file-link');
      candidate.removeAttribute('data-openchamber-file-ref');
      candidate.removeAttribute('data-openchamber-file-path');
      if (candidate.getAttribute('title') === 'Open file') {
        candidate.removeAttribute('title');
      }
      if (candidate.tagName.toLowerCase() !== 'a') {
        candidate.removeAttribute('role');
        candidate.removeAttribute('tabindex');
      }
    };

    const clearAnnotatedFileLinks = () => {
      const annotated = container.querySelectorAll<HTMLElement>(FILE_REFERENCE_LINK_SELECTOR);
      for (const candidate of Array.from(annotated)) {
        clearFileLinkAttributes(candidate);
      }
      unwrapBlockCodePathTokens(container);
    };

    const openFileReference = async (sourceElement: HTMLElement) => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const resolved = getResolvedReference(raw, effectiveDirectory);
      if (!resolved) {
        return;
      }

      const contextDirectory = getContextDirectory(effectiveDirectory, resolved.resolvedPath);
      if (preferRuntimeEditor && editor) {
        void editor.openFile(
          resolved.resolvedPath,
          Number.isFinite(resolved.line ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.line as number))
            : undefined,
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : undefined,
        );
        return;
      }

      const uiStore = useUIStore.getState();
      if (Number.isFinite(resolved.line ?? Number.NaN)) {
        uiStore.openContextFileAtLine(
          contextDirectory,
          resolved.resolvedPath,
          Math.max(1, Math.trunc(resolved.line as number)),
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : 1,
        );
      } else {
        uiStore.openContextFile(contextDirectory, resolved.resolvedPath);
      }
    };

    const attachClickGuard = () => attachFileRefClickGuard(container, {
      hrefCandidate: extractHrefFileReferenceCandidate,
      isResolvable: (raw) => getResolvedReference(raw, effectiveDirectory) !== null,
      openFileReference,
    });

    if (!fileReferencesEnabled) {
      clearAnnotatedFileLinks();
      if (!enabled) {
        return;
      }
      // Mobile skips the probing annotation pass, but a markdown link whose
      // href is a file path still has to open the file viewer: left to its
      // default, the WebView navigates to the path as a URL and fails.
      return attachClickGuard();
    }

    const scheduleAnnotation = (delayMs = 0) => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      if (typeof window === 'undefined') {
        annotateFileLinks();
        return;
      }
      annotationDebounceRef.current = window.setTimeout(() => {
        annotationDebounceRef.current = null;
        window.requestAnimationFrame(() => {
          if (!cancelled) {
            annotateFileLinks();
          }
        });
      }, delayMs);
    };

    const annotateFileLinks = () => {
      annotationWriteDepth += 1;
      try {
        annotateFileLinksInner();
      } finally {
        // Let the mutation events from our own writes flush before the
        // observer starts listening for real content changes again.
        queueMicrotask(() => {
          annotationWriteDepth -= 1;
        });
      }
    };

    const annotateFileLinksInner = () => {
      if (fileReferencesEnabled) {
        wrapBlockCodePathTokens(container);
      }
      const candidates = container.querySelectorAll<HTMLElement>(
        `[data-markdown="inline-code"], a, ${BLOCK_PATH_TOKEN_SELECTOR}`,
      );
      let linkedCount = 0;

      for (const candidate of Array.from(candidates)) {
        const rawCandidate = extractPathCandidateFromElement(candidate);
        const resolved = getResolvedReference(rawCandidate, effectiveDirectory);
        clearFileLinkAttributes(candidate);

        if (!resolved) {
          continue;
        }

        if (linkedCount >= fileReferenceLinkLimit) {
          continue;
        }

        linkedCount += 1;

        const outsideWorkspace = !isFilePathWithinDirectory(resolved.resolvedPath, effectiveDirectory);
        const existsPromise = outsideWorkspace
          ? Promise.resolve(true)
          : fileReferenceExists(resolved.resolvedPath, effectiveDirectory);

        void existsPromise.then((exists) => {
          if (cancelled || !exists || !container.contains(candidate)) {
            return;
          }

          const latestRawCandidate = extractPathCandidateFromElement(candidate);
          const latestResolved = getResolvedReference(latestRawCandidate, effectiveDirectory);
          if (!latestResolved || latestResolved.resolvedPath !== resolved.resolvedPath) {
            return;
          }

          candidate.setAttribute('data-openchamber-file-link', 'true');
          candidate.setAttribute('data-openchamber-file-ref', latestRawCandidate);
          candidate.setAttribute('data-openchamber-file-path', latestResolved.resolvedPath);
          candidate.setAttribute('title', 'Open file');
          if (candidate.tagName.toLowerCase() !== 'a') {
            candidate.setAttribute('role', 'button');
            candidate.setAttribute('tabindex', '0');
          }
        });
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getAttribute('data-openchamber-file-link') !== 'true') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void openFileReference(target);
    };

    scheduleAnnotation(FILE_REFERENCE_ANNOTATION_DELAY_MS);

    // Our own annotation writes (path-token wrapping, attribute updates) fire
    // childList mutations too; observing them re-ran the whole pass — every
    // link was scanned and verified twice per render.
    let annotationWriteDepth = 0;
    const observer = new MutationObserver(() => {
      if (annotationWriteDepth > 0) return;
      scheduleAnnotation(FILE_REFERENCE_ANNOTATION_DELAY_MS);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    container.addEventListener('keydown', handleKeyDown);
    const removeClickGuard = attachClickGuard();

    return () => {
      cancelled = true;
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      removeClickGuard();
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, preferRuntimeEditor, enabled]);
};

const useMermaidInlineInteractions = ({
  containerRef,
  onShowPopup,
  enableFullscreen,
  enablePanZoom,
  allowMermaidWheelEvents,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFullscreen?: boolean;
  enablePanZoom?: boolean;
  allowMermaidWheelEvents?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleMermaidClick = (event: MouseEvent) => {
      if (!enableFullscreen || !onShowPopup) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('button, a, [role="button"]')) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      if (block instanceof HTMLElement && block.hasAttribute('data-mermaid-suppress-click')) {
        block.removeAttribute('data-mermaid-suppress-click');
        return;
      }

      const renderedBlocks = Array.from(container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR));
      const blockIndex = renderedBlocks.indexOf(block as HTMLElement);
      if (blockIndex < 0) {
        return;
      }

      const source = block instanceof HTMLElement ? block.getAttribute('data-md-source') : null;
      if (!source || source.trim().length === 0) {
        return;
      }

      const filename = `Diagram ${blockIndex + 1}`;
      onShowPopup({
        open: true,
        title: filename,
        content: '',
        metadata: {
          tool: 'mermaid-preview',
          filename,
        },
        mermaid: {
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
          source,
          filename,
        },
      });
    };

    const handleInlineWheel = (event: WheelEvent) => {
      if (allowMermaidWheelEvents || ((event.ctrlKey || event.metaKey) && enablePanZoom)) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      // Keep regular page scroll while preventing Streamdown inline wheel-zoom handlers.
      event.stopPropagation();
    };

    container.addEventListener('click', handleMermaidClick);
    container.addEventListener('wheel', handleInlineWheel, { capture: true, passive: true });

    return () => {
      container.removeEventListener('click', handleMermaidClick);
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
  }, [allowMermaidWheelEvents, containerRef, enableFullscreen, enablePanZoom, onShowPopup]);
};

// ---------------------------------------------------------------------------
// Rendering core: marked -> math -> shiki -> sanitize -> decorate -> morphdom
// ---------------------------------------------------------------------------

// Mermaid layout is expensive; `decorate` would otherwise re-render every
// diagram on every paced-stream step (~40/sec). Memoize by theme+mode+source
// so a stable diagram is laid out once and served from cache thereafter.
const MERMAID_RENDER_CACHE = new Map<string, MermaidRender>();
const MERMAID_RENDER_CACHE_MAX = 100;


const cachedMermaidRender = (key: string, compute: () => MermaidRender): MermaidRender => {
  const existing = MERMAID_RENDER_CACHE.get(key);
  if (existing) {
    MERMAID_RENDER_CACHE.delete(key);
    MERMAID_RENDER_CACHE.set(key, existing);
    return existing;
  }
  const value = compute();
  MERMAID_RENDER_CACHE.set(key, value);
  if (MERMAID_RENDER_CACHE.size > MERMAID_RENDER_CACHE_MAX) {
    const oldest = MERMAID_RENDER_CACHE.keys().next().value;
    if (oldest) MERMAID_RENDER_CACHE.delete(oldest);
  }
  return value;
};

const mermaidColorsFromTheme = (theme: Theme) => ({
  bg: theme.colors.surface.elevated,
  fg: theme.colors.surface.foreground,
  line: theme.colors.interactive.border,
  accent: theme.colors.primary.base,
  muted: theme.colors.surface.mutedForeground,
  surface: theme.colors.surface.muted,
  border: theme.colors.interactive.border,
  transparent: true,
  font: 'system-ui, sans-serif',
});

const useDecorateContext = (
  currentTheme: Theme,
  deferCodeLineNumberSync: boolean,
  onPreviewLoopback?: (url: string) => void,
  mermaidControls: MermaidControlOptions = DEFAULT_MERMAID_CONTROLS,
): DecorateContext => {
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

  const codeBlockLineWrap = useUIStore((state) => state.codeBlockLineWrap);
  const setCodeBlockLineWrap = useUIStore((state) => state.setCodeBlockLineWrap);
  const toggleCodeBlockLineWrap = React.useCallback(() => {
    setCodeBlockLineWrap(!useUIStore.getState().codeBlockLineWrap);
  }, [setCodeBlockLineWrap]);

  return React.useMemo<DecorateContext>(() => {
    const colors = mermaidColorsFromTheme(currentTheme);
    const mode = useUIStore.getState().mermaidRenderingMode;
    const themeId = currentTheme.metadata?.id ?? 'theme';
    const renderMermaid = (source: string): MermaidRender =>
      cachedMermaidRender(`${themeId}:${mode}:${source}`, () => {
        try {
          if (mode === 'ascii') return { ascii: renderMermaidASCII(source) };
          return { svg: renderMermaidSVG(source, colors) };
        } catch {
          return {};
        }
      });
    return { labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, onToggleCodeBlockLineWrap: toggleCodeBlockLineWrap, renderMermaid, onPreviewLoopback };
  }, [currentTheme, labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, toggleCodeBlockLineWrap, onPreviewLoopback]);
};

// Runs the async render pipeline into the container and keeps a stable
// delegated interaction listener attached.


const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  streamPerfCount('ui.markdown_renderer.render');
  if (isStreaming) streamPerfCount('ui.markdown_renderer.render.streaming');
  streamPerfObserve('ui.markdown_renderer.content_len', content.length);
  const currentTheme = useCurrentMermaidTheme();
  const { editor, runtime } = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const handlePreviewLoopback = React.useCallback((url: string) => {
    if (!effectiveDirectory) return;
    openContextPreview(effectiveDirectory, url);
  }, [effectiveDirectory, openContextPreview]);

  const live = isStreaming && !disableStreamAnimation;

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: DEFAULT_MERMAID_CONTROLS.showPanZoomControls,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences && !isStreaming,
  });
  useLinkInteractions({ containerRef });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, live, effectiveDirectory ? handlePreviewLoopback : undefined, DEFAULT_MERMAID_CONTROLS);
  const { locale } = useI18n();
  const imageMode: MarkdownImageMode = variant === 'assistant' ? 'label' : 'inline';
  const settledPart = part
    && (part.type === 'text' || part.type === 'reasoning')
    && part.time?.end !== undefined
    ? part
    : null;
  const runtimeKey = getRuntimeKey();
  // Memoized on scalar identities, not the part object: sync-store reducers
  // recreate part objects on unrelated updates, and an object-identity dep
  // re-ran the async render pipeline for identical content.
  const settledSessionID = settledPart?.sessionID;
  const settledMessageID = settledPart?.messageID;
  const settledPartID = settledPart?.id;
  const domCacheKey = React.useMemo<DetachedMarkdownDomKey | null>(() => {
    // Streaming, unfinished, oversized, and identity-less Markdown continues
    // through the normal rendering pipeline and never retains detached DOM.
    if (isStreaming || !settledSessionID || !settledMessageID || !settledPartID || content.length === 0 || content.length > MARKDOWN_DOM_CACHE_MAX_SOURCE_CHARS) return null;
    // content.length is a cheap fingerprint: an edited or reverted part that
    // re-materializes under the same id must not restore the old DOM.
    return {
      scope: `${runtimeKey}\0${settledSessionID}`,
      id: `${settledMessageID}\0${settledPartID}\0${imageMode}\0${content.length}`,
      locale,
      directory: effectiveDirectory,
    };
  }, [content.length, effectiveDirectory, imageMode, isStreaming, locale, runtimeKey, settledSessionID, settledMessageID, settledPartID]);
  // Identity for the fade-in wrapper: a new part/message restarts the animation.
  const fadeKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;

  return <ChatMarkdownView content={content} containerRef={containerRef} className={className}
    isStreaming={live} variant={variant} imageMode={imageMode} syntaxVars={syntaxVars} ctx={ctx}
    domCacheKey={domCacheKey} isAnimated={isAnimated} skipFadeIn={skipFadeIn} fadeKey={fadeKey} />;
};

export const MarkdownRenderer = React.memo(MarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.enableFileReferences === next.enableFileReferences
    && prev.part?.id === next.part?.id;
});

const SimpleMarkdownRendererImpl: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  // App links remain confirmed even where ordinary HTTP link handling is off.
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelEvents?: boolean;
  enableFileReferences?: boolean;
  /** Render the document's raw HTML through the allowlist; only for documents a user opens to read. */
  allowRawHtml?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  mermaidControls = DEFAULT_MERMAID_CONTROLS,
  allowMermaidWheelEvents = false,
  enableFileReferences = true,
  allowRawHtml = false,
}) => {
  const { editor, runtime } = useRuntimeAPIs();
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';

  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: mermaidControls.showPanZoomControls,
    allowMermaidWheelEvents,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences,
  });
  useLinkInteractions({ containerRef, enabled: !disableLinkSafety });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, false, undefined, mermaidControls);

  return <ChatMarkdownView content={renderedContent} containerRef={containerRef} className={className}
    variant={variant} imageMode="inline" rawHtml={allowRawHtml ? 'sanitize' : 'escape'} syntaxVars={syntaxVars} ctx={ctx} />;
};

export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  const prevMermaidControls = prev.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;
  const nextMermaidControls = next.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;

  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.stripFrontmatter === next.stripFrontmatter
    && prev.onShowPopup === next.onShowPopup
    && prevMermaidControls.download === nextMermaidControls.download
    && prevMermaidControls.copy === nextMermaidControls.copy
    && prevMermaidControls.showPanZoomControls === nextMermaidControls.showPanZoomControls
    && prev.allowMermaidWheelEvents === next.allowMermaidWheelEvents
    && prev.enableFileReferences === next.enableFileReferences
    && prev.allowRawHtml === next.allowRawHtml;
});
