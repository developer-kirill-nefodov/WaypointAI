import type { Citation } from "@waypoint-ai/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const CITE_PREFIX = "#cite-";

/**
 * Renders an answer. Refs the server verified (`[E1]`, `[P2]`) become chips that show the cited row on the map;
 * other bracketed text stays as written.
 */
export default function MarkdownMessage({ text, citations, onCite }: { text: string; citations?: Citation[]; onCite?: (citation: Citation) => void }) {
  const byRef = new Map((citations ?? []).map((citation) => [citation.ref, citation]));
  const source = byRef.size ? text.replace(/\[([EP]\d{1,3})\]/g, (match, ref: string) => (byRef.has(ref) ? `[${ref}](${CITE_PREFIX}${ref})` : match)) : text;
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => {
    const citation = href?.startsWith(CITE_PREFIX) ? byRef.get(href.slice(CITE_PREFIX.length)) : undefined;
    if (citation) return <button type="button" className="citation-chip" title={citation.label} onClick={() => onCite?.(citation)}>{citation.ref}</button>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  } }}>{source}</ReactMarkdown>;
}
