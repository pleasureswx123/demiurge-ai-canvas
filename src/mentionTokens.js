const IMAGE_MENTION_TOKEN_PATTERN = /@(?:\u56fe\u7247|\u89c6\u9891)\d+/g;

function getImageMentionSegments(value) {
  return Array.from(value.matchAll(IMAGE_MENTION_TOKEN_PATTERN), (match) => {
    const tokenStart = match.index ?? 0;
    const tokenEnd = tokenStart + match[0].length;
    const segmentEnd = value[tokenEnd] === ' ' ? tokenEnd + 1 : tokenEnd;

    return {
      token: match[0],
      tokenStart,
      tokenEnd,
      segmentEnd,
    };
  });
}

export function protectImageMentionTokens(text) {
  const tokens = [];
  const protectedText = text.replace(IMAGE_MENTION_TOKEN_PATTERN, (match) => {
    const placeholder = `__IMG_REF_${tokens.length}__`;
    tokens.push(match);
    return placeholder;
  });

  return { protectedText, tokens };
}

export function restoreImageMentionTokens(text, tokens) {
  return tokens.reduce(
    (result, token, index) => result.replaceAll(`__IMG_REF_${index}__`, token),
    text
  );
}

export function getMentionCaretNavigationTarget(value, selectionStart, selectionEnd, key) {
  if (selectionStart !== selectionEnd) return null;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;

  for (const { tokenStart, segmentEnd } of getImageMentionSegments(value)) {
    if (key === 'ArrowLeft' && selectionStart > tokenStart && selectionStart <= segmentEnd) {
      return tokenStart;
    }

    if (key === 'ArrowRight' && selectionStart >= tokenStart && selectionStart < segmentEnd) {
      return segmentEnd;
    }
  }

  return null;
}

export function getMentionDeletionRange(value, selectionStart, selectionEnd) {
  if (selectionStart === selectionEnd) return null;

  let nextStart = selectionStart;
  let nextEnd = selectionEnd;
  let touchedMention = false;

  for (const { tokenStart, segmentEnd } of getImageMentionSegments(value)) {
    const overlapsSelection =
      Math.max(selectionStart, tokenStart) < Math.min(selectionEnd, segmentEnd);

    if (!overlapsSelection) continue;

    touchedMention = true;
    nextStart = Math.min(nextStart, tokenStart);
    nextEnd = Math.max(nextEnd, segmentEnd);
  }

  if (!touchedMention) return null;

  return { start: nextStart, end: nextEnd };
}
