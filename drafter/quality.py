"""Automatic quality checks for drafts. Pure functions: no API calls, nothing is sent."""

import re

SPAM = re.compile(
    r"(guarantee[d]?|100%|act now|limited time|click here|urgent|winner|risk[- ]free|"
    r"no obligation|buy now|cheap|earn money)",
    re.I,
)
PLACEHOLDER = re.compile(r"\{\s*[a-z_ ]+\s*\}", re.I)
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
LINK = re.compile(r"https?://|www\.", re.I)
SENTENCE_END = re.compile(r"[.!?۔؟]+(\s|$)")
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


AI_TELLS = re.compile(
    r"\b(delve|envision(?:ing|ed)?|leverag(?:e|ing)|seamless(?:ly)?|robust|elevate|tapestry|"
    r"game[- ]changer|streamline|crucial|holistic|testament|"
    r"i'?d be (?:more than )?happy to|feel free to|don'?t hesitate|reach out|hope this helps|"
    r"as an ai|certainly|absolutely|great question|in today'?s)\b|[\u2013\u2014]",
    re.I,
)


def comment_flags(comment, long=False):
    """Warnings for a drafted comment (empty list = clean). long=True uses the longer limits."""
    if not comment:
        return []
    flags = []
    if len(comment) > (900 if long else 320):
        flags.append("comment too long")
    if len(SENTENCE_END.findall(comment)) > (8 if long else 3):
        flags.append("comment over 8 sentences" if long else "comment over 3 sentences")
    if LINK.search(comment):
        flags.append("link in comment")
    if re.search(r"#\w", comment):
        flags.append("hashtag in comment")
    if len(EMOJI.findall(comment)) > 1:
        flags.append("too many emojis")
    if PLACEHOLDER.search(comment):
        flags.append("placeholder left in comment")
    if SPAM.search(comment):
        flags.append("salesy words in comment")
    tell = AI_TELLS.search(comment)
    if tell:
        flags.append("sounds like AI: " + tell.group(0).strip())
    return flags


COMMENT_FLAG_PREFIXES = (
    "comment", "longer version", "sounds like AI", "link in comment", "hashtag in comment",
    "too many emojis", "placeholder left in comment", "salesy words in comment",
)


def is_comment_flag(flag):
    return str(flag).strip().startswith(COMMENT_FLAG_PREFIXES)


def email_flags(subject, body, source_text, template_mode):
    """Warnings for a drafted email. source_text = everything the AI was allowed to use."""
    flags = []
    if not subject:
        flags.append("empty subject")
    if len(subject) > 70:
        flags.append("subject too long")
    if subject and re.search(r"[A-Z]", subject) and subject == subject.upper():
        flags.append("subject in ALL CAPS")
    if PLACEHOLDER.search(body) or PLACEHOLDER.search(subject):
        flags.append("placeholder left in email")
    if SPAM.search(body) or SPAM.search(subject):
        flags.append("spam words in email")
    if not template_mode:
        words = len(body.split())
        if words < 40 or words > 140:
            flags.append(f"email length {words} words")
        if body.count("!") > 1:
            flags.append("exclamation marks in email")
        bad = [n for n in NUMBER.findall(body) if n not in source_text]
        if bad:
            flags.append("number not in source: " + ",".join(bad[:2]))
    return flags


def priority(intent, has_comment):
    if not has_comment:
        return ""
    if intent >= 4:
        return "high"
    return "medium" if intent == 3 else "low"


def clamp_intent(value):
    try:
        return min(5, max(0, int(float(value))))
    except (TypeError, ValueError):
        return 0
