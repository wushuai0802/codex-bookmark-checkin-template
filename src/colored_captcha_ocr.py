import json
import re
import sys

import cv2
import ddddocr
import numpy as np


def main():
    expected_length = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    source = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
    image = cv2.imdecode(source, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("invalid image")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    engine = ddddocr.DdddOcr(show_ad=False)
    candidates = []
    for darkness in [90, 110, 130, 150, 170, 190]:
        for saturation in [30, 45, 60, 80, 110, 140]:
            mask = np.where(
                (gray < darkness) | ((hsv[:, :, 1] > saturation) & (gray < 220)),
                0,
                255,
            ).astype(np.uint8)
            encoded = cv2.imencode(".png", mask)[1].tobytes()
            answer = re.sub(r"[^A-Z0-9]", "", engine.classification(encoded).upper())
            if len(answer) == expected_length:
                candidates.append(answer)

    ranked = sorted(
        ({"code": code, "votes": candidates.count(code)} for code in set(candidates)),
        key=lambda item: (-item["votes"], item["code"]),
    )
    print(json.dumps({"code": ranked[0]["code"] if ranked else "", "candidates": ranked}, ensure_ascii=True))


if __name__ == "__main__":
    main()
