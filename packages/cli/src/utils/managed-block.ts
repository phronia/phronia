import fs from "node:fs";
import path from "node:path";

import { FILE_NAMES } from "../constants/paths.js";
import { agentsMdContent } from "../templates/markdown/index.js";
import {
  LEGACY_BLOCK_END,
  LEGACY_BLOCK_START,
  PHRONIA_BLOCK_END,
  PHRONIA_BLOCK_START,
} from "./managed-paths.js";

/** Extract a managed block, including its markers. */
export function getManagedBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = content.indexOf(startMarker);
  if (start === -1) {
    return null;
  }

  const end = content.indexOf(endMarker, start);
  if (end === -1) {
    return null;
  }

  return content.slice(start, end + endMarker.length);
}

/** Read either the current or the pre-rename managed block. */
export function getTrellisManagedBlock(content: string): string | null {
  return (
    getManagedBlock(content, PHRONIA_BLOCK_START, PHRONIA_BLOCK_END) ??
    getManagedBlock(content, LEGACY_BLOCK_START, LEGACY_BLOCK_END)
  );
}

/** Replace an existing managed block with the template's block. */
export function replaceManagedBlock(
  existingContent: string,
  templateContent: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const existingStart = existingContent.indexOf(startMarker);
  if (existingStart === -1) {
    return null;
  }

  const existingEnd = existingContent.indexOf(endMarker, existingStart);
  if (existingEnd === -1) {
    return null;
  }

  const templateBlock = getManagedBlock(
    templateContent,
    startMarker,
    endMarker,
  );
  if (!templateBlock) {
    return null;
  }

  return (
    existingContent.slice(0, existingStart) +
    templateBlock +
    existingContent.slice(existingEnd + endMarker.length)
  );
}

/** Merge a template's managed block into user-owned surrounding content. */
export function mergeManagedBlockContent(
  existingContent: string,
  templateContent: string,
  startMarker: string,
  endMarker: string,
): string {
  // Pre-rename projects carry TRELLIS markers. Replace that block in place so
  // the file migrates to PHRONIA markers without duplicating content.
  const existingStart = existingContent.indexOf(startMarker);
  if (existingStart === -1) {
    const templateBlock = getManagedBlock(templateContent, startMarker, endMarker);
    const legacyStartMarker = startMarker.replace("PHRONIA", "TRELLIS");
    const legacyEndMarker = endMarker.replace("PHRONIA", "TRELLIS");
    const legacyStart = existingContent.indexOf(legacyStartMarker);
    const legacyEnd =
      legacyStart === -1
        ? -1
        : existingContent.indexOf(legacyEndMarker, legacyStart);
    if (templateBlock && legacyStart !== -1 && legacyEnd !== -1) {
      return (
        existingContent.slice(0, legacyStart) +
        templateBlock +
        existingContent.slice(legacyEnd + legacyEndMarker.length)
      );
    }
  }

  const replaced = replaceManagedBlock(
    existingContent,
    templateContent,
    startMarker,
    endMarker,
  );
  if (replaced !== null) {
    return replaced;
  }

  const templateBlock = getManagedBlock(
    templateContent,
    startMarker,
    endMarker,
  );
  if (!templateBlock) {
    return templateContent;
  }

  const trimmed = existingContent.replace(/\s+$/, "");
  return `${trimmed}\n\n${templateBlock}\n`;
}

/** Render a template file, preserving content outside its managed block. */
export function buildManagedBlockTemplate(
  cwd: string,
  relativePath: string,
  templateContent: string,
  startMarker: string,
  endMarker: string,
): string {
  const fullPath = path.join(cwd, ...relativePath.split("/"));
  if (!fs.existsSync(fullPath)) {
    return templateContent;
  }

  const existingContent = fs.readFileSync(fullPath, "utf-8");
  return mergeManagedBlockContent(
    existingContent,
    templateContent,
    startMarker,
    endMarker,
  );
}

/** Render AGENTS.md, migrating a legacy TRELLIS block if present. */
export function buildAgentsMdTemplate(cwd: string): string {
  return buildManagedBlockTemplate(
    cwd,
    FILE_NAMES.AGENTS,
    agentsMdContent,
    PHRONIA_BLOCK_START,
    PHRONIA_BLOCK_END,
  );
}
