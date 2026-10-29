/**
 * Dependency-free YAML subset parser, ported from
 * `templates/workflow/scripts/common/trellis_config.py`.
 *
 * Supported: `key: value` scalars (all strings), indented mappings, `- `
 * lists of scalars **or flat mappings** (`- path: x` / `  mode: symlink`),
 * whole-line and inline `#` comments outside quotes, and one layer of matching
 * quotes.
 *
 * Unsupported (reported, skipped): block scalars, anchors, aliases, merge
 * keys, flow collections, nested lists inside a list-item mapping.
 */

export type YamlValue = string | YamlValue[] | YamlObject;

export interface YamlObject {
  [key: string]: YamlValue;
}

export interface YamlWarning {
  line: number;
  reason: string;
  text: string;
}

export interface YamlParseResult {
  value: YamlObject;
  warnings: YamlWarning[];
}

export function parseSimpleYaml(content: string): YamlParseResult {
  const lines = content.split(/\r\n|\r|\n/);
  const value: YamlObject = {};
  const warnings: YamlWarning[] = [];
  parseBlock(lines, 0, 0, value, warnings);
  return { value, warnings };
}

function parseBlock(
  lines: readonly string[],
  start: number,
  minIndent: number,
  target: YamlObject,
  warnings: YamlWarning[],
): number {
  let index = start;
  let currentList: YamlValue[] | null = null;
  let listOwnerIndent = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const stripped = line.trim();

    if (stripped.length === 0 || stripped.startsWith("#")) {
      index += 1;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) {
      break;
    }

    if (stripped.startsWith("- ")) {
      if (currentList !== null) {
        const content = stripped.slice(2).trim();
        const mappingKey = listItemMappingKey(content);
        if (mappingKey === null) {
          currentList.push(unquote(content));
          index += 1;
          continue;
        }
        const item: YamlObject = {};
        currentList.push(item);
        index = parseListItem(
          lines,
          index,
          indent,
          content,
          item,
          warnings,
        );
        continue;
      }
      index += 1;
      continue;
    }

    if (!stripped.includes(":")) {
      index += 1;
      continue;
    }

    if (currentList !== null && indent > listOwnerIndent) {
      warnings.push({
        line: index + 1,
        reason: "mappings inside a list are not supported",
        text: line,
      });
      index += 1;
      continue;
    }

    const separator = stripped.indexOf(":");
    const key = stripped.slice(0, separator).trim();
    const rawValue = stripped.slice(separator + 1);
    let value = stripInlineComment(rawValue).trim();
    const wasQuoted =
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'");

    if (!wasQuoted) {
      const reason = unsupportedValue(key, value);
      if (reason !== null) {
        warnings.push({ line: index + 1, reason, text: line });
        currentList = null;
        index = skipIndentedBody(lines, index + 1, indent);
        continue;
      }
    }

    value = unquote(value);
    currentList = null;

    if (value.length > 0 || wasQuoted) {
      target[key] = value;
      index += 1;
      continue;
    }

    const next = nextContentLine(lines, index + 1);
    if (next.index >= lines.length) {
      target[key] = {};
      index = next.index;
      continue;
    }
    if (next.line.trim().startsWith("- ")) {
      currentList = [];
      listOwnerIndent = indent;
      target[key] = currentList;
      index += 1;
      continue;
    }
    const nextIndent = next.line.length - next.line.trimStart().length;
    if (nextIndent > indent) {
      const nested: YamlObject = {};
      target[key] = nested;
      index = parseBlock(lines, index + 1, nextIndent, nested, warnings);
      continue;
    }
    target[key] = {};
    index += 1;
  }

  return index;
}

/**
 * Detect `key: value` on a `- ` list item. A quoted scalar (`- "a: b"`) and a
 * bare `a:b` scalar stay scalars, matching YAML's `: ` requirement.
 */
function listItemMappingKey(content: string): string | null {
  if (content === "" || content.startsWith('"') || content.startsWith("'")) {
    return null;
  }
  const separator = content.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const key = content.slice(0, separator).trim();
  if (!/^[A-Za-z0-9_.\-/ ]+$/.test(key)) {
    return null;
  }
  const after = content.slice(separator + 1);
  if (after !== "" && !after.startsWith(" ")) {
    return null;
  }
  return key;
}

/**
 * Parse one `- key: value` item and its continuation lines into `item`.
 * The first pair lives on the dash line; the body is parsed by `parseBlock`
 * with the item as its target so nested mappings keep working.
 */
function parseListItem(
  lines: readonly string[],
  index: number,
  dashIndent: number,
  content: string,
  item: YamlObject,
  warnings: YamlWarning[],
): number {
  const separator = content.indexOf(":");
  const key = content.slice(0, separator).trim();
  const rawValue = content.slice(separator + 1);
  let value = stripInlineComment(rawValue).trim();
  const wasQuoted =
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'");

  if (!wasQuoted) {
    const reason = unsupportedValue(key, value);
    if (reason !== null) {
      warnings.push({ line: index + 1, reason, text: lines[index] ?? "" });
      return skipIndentedBody(lines, index + 1, dashIndent);
    }
  }

  value = unquote(value);
  let next = index + 1;
  if (value.length > 0 || wasQuoted) {
    item[key] = value;
  } else {
    const followed = nextContentLine(lines, next);
    if (followed.index >= lines.length) {
      item[key] = {};
      return followed.index;
    }
    const contentIndent = dashIndent + 2;
    const followedIndent = indentOf(followed.line);
    if (followedIndent > contentIndent) {
      if (followed.line.trim().startsWith("- ")) {
        warnings.push({
          line: followed.index + 1,
          reason: "nested lists inside a list item are not supported",
          text: followed.line,
        });
        item[key] = {};
        return skipIndentedBody(lines, followed.index, contentIndent);
      }
      const nested: YamlObject = {};
      item[key] = nested;
      next = parseBlock(lines, followed.index, followedIndent, nested, warnings);
    } else {
      item[key] = {};
    }
  }

  return parseBlock(lines, next, dashIndent + 1, item, warnings);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'")
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stripInlineComment(value: string): string {
  let inQuote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inQuote !== null) {
      if (char === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function nextContentLine(
  lines: readonly string[],
  start: number,
): { index: number; line: string } {
  let index = start;
  while (index < lines.length) {
    const stripped = (lines[index] ?? "").trim();
    if (stripped.length > 0 && !stripped.startsWith("#")) {
      return { index, line: lines[index] ?? "" };
    }
    index += 1;
  }
  return { index, line: "" };
}

function isBlockScalar(value: string): boolean {
  if (value.length === 0 || (value[0] !== "|" && value[0] !== ">")) {
    return false;
  }
  return [...value.slice(1)].every((char) => "+-0123456789".includes(char));
}

function unsupportedValue(key: string, value: string): string | null {
  if (key === "<<") {
    return "YAML merge keys are not supported";
  }
  if (isBlockScalar(value)) {
    return "block scalars are not supported";
  }
  if (value.startsWith("&")) {
    return "YAML anchors are not supported";
  }
  if (value.startsWith("*")) {
    return "YAML aliases are not supported";
  }
  if (value.startsWith("[")) {
    return "flow sequences are not supported (use `- ` list items)";
  }
  if (value.startsWith("{")) {
    return "flow mappings are not supported (use an indented mapping)";
  }
  return null;
}

function skipIndentedBody(
  lines: readonly string[],
  start: number,
  indent: number,
): number {
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const stripped = line.trim();
    if (stripped.length > 0 && line.length - line.trimStart().length <= indent) {
      break;
    }
    index += 1;
  }
  return index;
}
