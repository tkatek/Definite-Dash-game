"""Build normalized alpha-WebP runtime frames from the approved PNG masters.

This script never redraws or resizes the character. It only translates each
1254×1254 RGBA master by a measured integer offset so the upper-body centre is
stable and both half-strides share the same rise/contact/compression heights.
The PNG files remain the source of truth and are never overwritten.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "characters"
OUTPUT_DIR = SOURCE_DIR / "runtime"
CANVAS_SIZE = (1254, 1254)

# Measured against the invariant ear/head silhouette. Resulting ear-top rows:
# push-off=15px, air=5px, landing=20px, compression=23px (then mirrored).
OFFSETS = {
    1: (-2, 12),
    2: (2, 4),
    3: (0, 17),
    4: (5, 22),
    5: (-3, 7),
    6: (-4, -9),
    7: (6, 7),
    8: (-4, 21),
}


def build_frame(number: int) -> tuple[Path, int, int]:
    source = SOURCE_DIR / f"fox-run-{number:02d}.png"
    target = OUTPUT_DIR / f"fox-run-{number:02d}.webp"
    image = Image.open(source).convert("RGBA")
    if image.size != CANVAS_SIZE:
        raise ValueError(f"{source.name}: expected {CANVAS_SIZE}, got {image.size}")

    normalized = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
    # Copy RGBA directly. Passing the image again as a paste mask would apply
    # its alpha twice and thin the semi-transparent fur fringe.
    normalized.paste(image, OFFSETS[number])
    normalized.save(
        target,
        format="WEBP",
        quality=95,
        alpha_quality=100,
        # Method 4 is deterministic and keeps the build practical on the
        # bundled runtime while retaining the high quality/alpha settings.
        method=4,
        exact=True,
    )

    verified = Image.open(target).convert("RGBA")
    if verified.size != CANVAS_SIZE or verified.getextrema()[3][0] != 0:
        raise ValueError(f"{target.name}: invalid canvas or missing transparency")
    if verified.getchannel("A").tobytes() != normalized.getchannel("A").tobytes():
        raise ValueError(f"{target.name}: alpha edge changed during encoding")
    return target, source.stat().st_size, target.stat().st_size


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    total_source = 0
    total_runtime = 0
    for number in range(1, 9):
        target, source_bytes, runtime_bytes = build_frame(number)
        total_source += source_bytes
        total_runtime += runtime_bytes
        print(
            f"{target.name}: {source_bytes / 1024:.1f} KiB -> "
            f"{runtime_bytes / 1024:.1f} KiB"
        )
    print(
        f"total: {total_source / 1024 / 1024:.2f} MiB -> "
        f"{total_runtime / 1024 / 1024:.2f} MiB"
    )


if __name__ == "__main__":
    main()

