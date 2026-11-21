import type { DefaultTreeAdapterTypes as Tree } from 'parse5';

const MAX_TEXT_NODES_VISITED = 2_000;
const SKIPPED_TAGS = ['script', 'style', 'template'];

export type HtmlElement = Tree.Element;
export type HtmlNode = Tree.Node;

function htmlElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

export function htmlAttr(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value;
}

export function descendants(root: HtmlNode, limit: number): HtmlElement[] {
  const elements: HtmlElement[] = [];
  const pending: HtmlNode[] = [root];
  while (pending.length && elements.length < limit) {
    const node = pending.pop()!;
    if (htmlElement(node)) {
      if (SKIPPED_TAGS.includes(node.tagName)) continue;
      elements.push(node);
    }

    if ('childNodes' in node)
      for (const child of node.childNodes.toReversed()) pending.push(child);
  }

  return elements;
}

export function htmlText(node: HtmlNode, max: number): string | null {
  const parts: string[] = [];
  const pending: HtmlNode[] = [node];
  let visited = 0;

  while (pending.length && visited++ < MAX_TEXT_NODES_VISITED) {
    const current = pending.pop()!;
    if (current.nodeName === '#text') {
      parts.push((current as Tree.TextNode).value);
    } else if ('childNodes' in current) {
      for (const child of current.childNodes.toReversed()) pending.push(child);
    }
  }
  if (pending.length) return null;

  const text = parts.join('').replace(/\s+/gu, ' ').trim();

  return text && text.length <= max ? text : null;
}
