import type { Root, PhrasingContent } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";

const ISSUE_REF_RE = /#(\d+)/g;

/**
 * remark plugin that converts `#123` patterns into GitHub issue/PR links.
 * Skips code spans and code blocks (via mdast ignore).
 */
export function remarkIssueLink({ ownerRepo }: { ownerRepo: string }) {
  return (tree: Root) => {
    findAndReplace(tree, [
      [
        ISSUE_REF_RE,
        (_match: string, number: string) => {
          return {
            type: "link",
            url: `https://github.com/${ownerRepo}/issues/${number}`,
            children: [{ type: "text", value: `#${number}` } as const],
          } satisfies PhrasingContent;
        },
      ],
    ], {
      ignore: ["code", "inlineCode"],
    });
  };
}
