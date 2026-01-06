/**
 * Extracts meaningful text from assistant responses, filtering out noise.
 * 
 * Assistant messages contain meta-content we want to filter:
 * - Tool announcements ("Let me search for...")
 * - Status updates ("I'm checking...")
 * - Thinking blocks
 * - Command outputs
 * 
 * This module extracts only substantive knowledge/explanations.
 */

// Lines matching these patterns are noise - skip entirely
const SKIP_LINE_STARTS = [
  // Tool announcements
  'let me check', 'let me read', 'let me search', 'let me look', 'let me find',
  'let me explore', 'let me analyze', 'let me examine', 'let me use', 'let me run',
  "i'll check", "i'll read", "i'll search", "i'll look", "i'll find",
  "i'm going to check", "i'm going to read", "i'm going to search",
  'searching', 'reading', 'checking', 'looking', 'finding', 'analyzing',
  'now let me', "now i'll", "now i'm going to",
  'first, let me', 'next, let me', 'then, let me',
  // Status updates  
  'done.', 'complete.', 'finished.', 'success.',
  'that worked', 'that succeeded', 'that completed',
  'starting', 'beginning', 'initiating',
  // Tool result references
  'the results show', 'the result shows', 'output shows', 'this shows',
  "here's what", 'here are the', 'let me show',
  'found 0 ', 'found 1 ', 'found 2 ', 'found 3 ',
];

// Regex patterns for lines to skip
const SKIP_LINE_PATTERNS = [
  /^→\s*(Read|Edit|Write|Glob|Grep|List)/i,
  /^⚙\s/,
  /^#\s.*\$\s/,  // Shell command lines like "# Check git status\n$ git status"
  /^thinking:/i,
  /^\[.*\]$/,  // Status indicators like [search-mode]
  /^\$ /,  // Command outputs
  /^```/,  // Code fence markers
];

// Patterns to remove from within lines (inline noise)
const INLINE_NOISE_PATTERNS = [
  /\[BACKGROUND TASK[^\]]*\]/gi,
  /\[search-mode\]|\[\/search-mode\]/gi,
  /\[analyze-mode\]|\[\/analyze-mode\]/gi,
];

/**
 * Check if a line should be skipped entirely
 */
function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  
  // Check prefix matches
  for (const prefix of SKIP_LINE_STARTS) {
    if (trimmed.startsWith(prefix)) {
      return true;
    }
  }
  
  // Check regex patterns
  for (const pattern of SKIP_LINE_PATTERNS) {
    if (pattern.test(line)) {
      return true;
    }
  }
  
  // Skip very short lines (likely fragments)
  if (trimmed.length < 10) {
    return true;
  }
  
  return false;
}

/**
 * Clean inline noise from a line
 */
function cleanLine(line: string): string {
  let cleaned = line;
  for (const pattern of INLINE_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}

/**
 * Extract clean, meaningful text from assistant message parts.
 * Filters out tool calls, announcements, and meta-content.
 */
export function extractAssistantText(parts: Array<{ type: string; text?: string }>): string {
  // Only process text parts, skip tool calls entirely
  const textParts = parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text as string);
  
  if (textParts.length === 0) {
    return '';
  }
  
  const lines: string[] = [];
  let inCodeBlock = false;
  
  for (const part of textParts) {
    for (const line of part.split('\n')) {
      // Track code blocks to skip them
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      
      // Skip lines inside code blocks
      if (inCodeBlock) {
        continue;
      }
      
      // Skip noise lines
      if (shouldSkipLine(line)) {
        continue;
      }
      
      // Clean and add meaningful lines
      const cleaned = cleanLine(line);
      if (cleaned.length >= 10) {
        lines.push(cleaned);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Check if assistant text is substantive enough to store as memory.
 * Requires minimum length and actual content.
 */
export function isSubstantiveAssistantText(text: string): boolean {
  if (text.length < 50) {
    return false;
  }
  
  // Must have multiple sentences or clear knowledge content
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
  return sentences.length >= 2;
}
