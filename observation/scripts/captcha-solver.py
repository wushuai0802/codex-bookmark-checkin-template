#!/usr/bin/env python3
"""Small stdin/stdout OCR worker for the V2 captcha solver boundary.

The image is never written to disk. The caller supplies the expected length;
the worker returns only bounded candidate strings.
"""

import json
import re
import sys

try:
    import cv2
    import numpy as np
except Exception:
    cv2 = None
    np = None

import ddddocr


def normalize(value, length):
    code = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    return code if len(code) == length else ""


def main():
    length = int(sys.argv[sys.argv.index("--length") + 1]) if "--length" in sys.argv else 5
    length = max(1, min(12, length))
    image = sys.stdin.buffer.read()
    if not image or len(image) > 4 * 1024 * 1024:
        print(json.dumps({"code": "", "candidates": []}))
        return

    engine = ddddocr.DdddOcr(show_ad=False)
    variants = [image]
    if cv2 is not None and np is not None:
        decoded = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_COLOR)
        if decoded is not None:
            gray = cv2.cvtColor(decoded, cv2.COLOR_BGR2GRAY)
            for threshold in (110, 140, 170):
                _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
                encoded = cv2.imencode(".png", mask)[1]
                if encoded is not None:
                    variants.append(encoded.tobytes())

    counts = {}
    for variant in variants[:4]:
        try:
            code = normalize(engine.classification(variant), length)
        except Exception:
            code = ""
        if code:
            counts[code] = counts.get(code, 0) + 1
    ranked = sorted(counts, key=lambda item: (-counts[item], item))[:8]
    print(json.dumps({"code": ranked[0] if ranked else "", "candidates": ranked}, ensure_ascii=True))


if __name__ == "__main__":
    main()
