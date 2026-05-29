import re
import unicodedata

# ── Markdown / formatting ─────────────────────────────────────────────────────
_MD_CODE_BLOCK  = re.compile(r"```[\s\S]*?```")
_MD_INLINE_CODE = re.compile(r"`[^`]+`")
_MD_BOLD_ITALIC = re.compile(r"\*{1,3}(.*?)\*{1,3}")
_MD_HEADING     = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_MD_BULLET      = re.compile(r"^\s*[-*•]\s+", re.MULTILINE)
_MD_NUMBERED    = re.compile(r"^\s*\d+\.\s+", re.MULTILINE)
_MD_LINK        = re.compile(r"\[([^\]]+)\]\([^\)]+\)")   # [text](url) → text
_MD_IMAGE       = re.compile(r"!\[[^\]]*\]\([^\)]+\)")    # ![alt](url) → ""
_MD_BLOCKQUOTE  = re.compile(r"^>\s+", re.MULTILINE)
_MD_HR          = re.compile(r"^[-*_]{3,}\s*$", re.MULTILINE)
_MD_TABLE_ROW   = re.compile(r"\|[^\n]+\|")
_MD_TABLE_SEP   = re.compile(r"^\|?[-:| ]+\|$", re.MULTILINE)

# ── URLs and technical strings ────────────────────────────────────────────────
_URL            = re.compile(r"https?://\S+|www\.\S+")
_EMAIL          = re.compile(r"[\w.+-]+@[\w-]+\.[a-z]{2,}")
_FILE_PATH      = re.compile(r"(?:[A-Za-z]:\\|/)[^\s\"'<>]+")
_HEX_COLOR      = re.compile(r"#[0-9a-fA-F]{3,8}\b")
_UUID           = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)

# ── Symbols that TTS mispronounces or chokes on ───────────────────────────────
_SYMBOL_MAP = {
    "&":  " and ",
    "%":  " percent ",
    "+":  " plus ",
    "=":  " equals ",
    "→":  " to ",
    "←":  " from ",
    "↔":  " to and from ",
    "≥":  " greater than or equal to ",
    "≤":  " less than or equal to ",
    "≠":  " not equal to ",
    "×":  " times ",
    "÷":  " divided by ",
    "°":  " degrees ",
    "©":  "",
    "®":  "",
    "™":  "",
    "…":  "...",
    "\t": " ",
    "—":  ", ",
    "–":  ", ",
}

# ── Control / non-printable characters ───────────────────────────────────────
_CONTROL_CHARS  = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# Zero-width and invisible unicode
_ZERO_WIDTH     = re.compile(r"[\u200b\u200c\u200d\u200e\u200f\ufeff]")
# Emoji block ranges
_EMOJI          = re.compile(
    "[\U0001F300-\U0001F9FF"
    "\U00002600-\U000027BF"
    "\U0001FA00-\U0001FA9F"
    "\U0001FAB0-\U0001FABF"
    "\U00002300-\U000023FF]+",
    flags=re.UNICODE,
)
# Runs of punctuation that trip up TTS (e.g. "----", ".....", ">>>")
_PUNCT_RUN      = re.compile(r"([^\w\s])\1{2,}")
# Repeated whitespace
_MULTI_SPACE    = re.compile(r"  +")


def sanitize_for_tts(text: str) -> str:
    """
    Clean a text chunk so it is safe and natural-sounding when passed to TTS.
    Returns an empty string if nothing speakable remains after cleaning.
    """
    if not text or not text.strip():
        return ""

    # 1. Normalise unicode to NFC so accented chars render correctly
    text = unicodedata.normalize("NFC", text)

    # 2. Strip control chars and zero-width characters
    text = _CONTROL_CHARS.sub("", text)
    text = _ZERO_WIDTH.sub("", text)

    # 3. Remove markdown structures
    text = _MD_CODE_BLOCK.sub(" ", text)
    text = _MD_INLINE_CODE.sub(" ", text)
    text = _MD_IMAGE.sub("", text)
    text = _MD_LINK.sub(r"\1", text)        # keep link text
    text = _MD_BOLD_ITALIC.sub(r"\1", text) # keep bold/italic text
    text = _MD_HEADING.sub("", text)
    text = _MD_BLOCKQUOTE.sub("", text)
    text = _MD_HR.sub("", text)
    text = _MD_TABLE_ROW.sub("", text)
    text = _MD_TABLE_SEP.sub("", text)
    text = _MD_BULLET.sub("", text)
    text = _MD_NUMBERED.sub("", text)

    # 4. Replace URLs / technical strings with neutral placeholders
    text = _URL.sub("a link", text)
    text = _EMAIL.sub("an email address", text)
    text = _FILE_PATH.sub("a file path", text)
    text = _HEX_COLOR.sub("a colour value", text)
    text = _UUID.sub("an identifier", text)

    # 5. Expand known symbols
    for symbol, replacement in _SYMBOL_MAP.items():
        text = text.replace(symbol, replacement)

    # 6. Strip emoji
    text = _EMOJI.sub("", text)

    # 7. Collapse punctuation runs to a single instance
    text = _PUNCT_RUN.sub(r"\1", text)

    # 8. Collapse whitespace
    text = _MULTI_SPACE.sub(" ", text)
    text = text.strip()

    # 9. Final guard — reject if nothing speakable remains
    if not any(c.isalpha() or c.isdigit() for c in text):
        return ""

    return text