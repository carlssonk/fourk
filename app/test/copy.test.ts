import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const unwanted = /[—–]|\p{Extended_Pictographic}/u;

test("app copy contains no em dashes or decorative emojis", () => {
  const violations: string[] = [];
  function scan(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        scan(path);
        continue;
      }
      if (!/\.tsx?$/.test(path)) continue;
      const tree = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        // Check runtime copy, including tooltips and template fragments.
        // Comments, regexes, and functional symbols (close/check/refresh) are not copy.
        if (
          (ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)) &&
          unwanted.test(node.text)
        ) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          violations.push(`${path}:${line}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  scan(fileURLToPath(new URL("../src", import.meta.url)));
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(
    /<!--[\s\S]*?-->/g,
    "",
  );
  expect(html).not.toMatch(unwanted);
  expect(violations).toEqual([]);
});
