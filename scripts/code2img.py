#!/usr/bin/env python3
"""Render a code snippet to a syntax-highlighted PNG image."""

import sys
import json
import os
import hashlib
import time

from pygments import highlight
from pygments.lexers import get_lexer_by_name, guess_lexer, TextLexer
from pygments.formatters import ImageFormatter
from pygments.styles import get_style_by_name

OUTPUT_DIR = "/tmp/openclaw-qq-codeimg"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def render(code: str, lang: str = "") -> str:
    """Render code to PNG, return the file path."""
    # Pick lexer
    try:
        if lang:
            lexer = get_lexer_by_name(lang, stripall=True)
        else:
            lexer = guess_lexer(code)
    except Exception:
        lexer = TextLexer(stripall=True)

    # Strip trailing whitespace/newlines
    code = code.rstrip()

    # Generate filename from hash
    h = hashlib.md5(f"{lang}:{code}".encode()).hexdigest()[:12]
    out_path = os.path.join(OUTPUT_DIR, f"code_{h}.png")

    # Use a nice dark style
    formatter = ImageFormatter(
        style="monokai",
        font_name="Noto Sans Mono",
        font_size=32,
        line_numbers=False,
        image_pad=20,
        line_pad=6,
    )

    img_data = highlight(code, lexer, formatter)
    with open(out_path, "wb") as f:
        f.write(img_data)

    return out_path

if __name__ == "__main__":
    # Read JSON from stdin: {"code": "...", "lang": "python"}
    data = json.load(sys.stdin)
    path = render(data.get("code", ""), data.get("lang", ""))
    print(path)
