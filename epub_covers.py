"""Extract embedded EPUB cover images safely for PiShelf library thumbnails.

EPUB cover generation is lazy and cached by server.py. This module never
extracts archive members to disk and never executes book HTML, CSS or scripts.
"""
from io import BytesIO
import logging
import posixpath
from urllib.parse import unquote
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_XML_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
MAX_ARCHIVE_ITEMS = 4000
THUMBNAIL_SIZE = (600, 900)


def _archive_path(value):
    """Only use safe, relative ZIP paths; never access the host filesystem."""
    if not value or value.startswith("/") or "\\" in value or "\x00" in value:
        raise ValueError("Unsafe EPUB resource path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Unsafe EPUB resource path")
    return value


def _read_member(archive, name, limit):
    path = _archive_path(name)
    info = archive.getinfo(path)
    if info.is_dir() or info.flag_bits & 1 or info.file_size > limit:
        raise ValueError("EPUB resource is unavailable or oversized")
    data = archive.read(info)
    if len(data) > limit:
        raise ValueError("EPUB resource exceeds limit")
    return data


def _xml(content):
    # EPUB manifests must not use DTDs or entity definitions; reject them
    # before parsing to avoid exponential entity expansion.
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise ValueError("Unsafe EPUB XML declarations")
    return ElementTree.fromstring(content)


def _cover_member_name(archive):
    """Resolve EPUB 2 and EPUB 3 declared cover-image metadata."""
    container = _xml(_read_member(archive, "META-INF/container.xml", MAX_XML_BYTES))
    rootfile = container.find(".//{*}rootfile")
    if rootfile is None:
        return None
    package_path = _archive_path(rootfile.get("full-path", ""))
    package = _xml(_read_member(archive, package_path, MAX_XML_BYTES))
    manifest = package.find(".//{*}manifest")
    if manifest is None:
        return None

    items = list(manifest.findall("{*}item"))
    image_types = ("image/jpeg", "image/png", "image/webp")
    images = [entry for entry in items if entry.get("media-type") in image_types]
    if not images:
        return None

    cover = next(
        (entry for entry in images if "cover-image" in entry.get("properties", "").split()),
        None,
    )
    if cover is None:
        for meta in package.findall(".//{*}metadata/{*}meta"):
            if meta.get("name", "").lower() == "cover":
                cover = next(
                    (entry for entry in images if entry.get("id") == meta.get("content")),
                    None,
                )
                if cover is not None:
                    break
    if cover is None:
        cover = next(
            (
                entry for entry in images
                if "cover" in entry.get("id", "").lower()
                or "cover" in entry.get("href", "").lower()
            ),
            None,
        )
    if cover is None:
        return None

    href = unquote(cover.get("href", "").split("#", 1)[0])
    if not href or href.startswith('/') or '\\' in href or '\x00' in href:
        raise ValueError('Unsafe EPUB cover reference')
    # ../ is legal inside an EPUB package if it resolves within the archive.
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(package_path), href))
    return _archive_path(resolved)


def embedded_cover_jpeg(path):
    """Return a bounded JPEG thumbnail, or None when no embedded cover exists.

    Malformed EPUBs fail closed to the title placeholder instead of taking
    down the library. The 600x900 JPEG is small enough for Pi 5 memory.
    """
    try:
        with ZipFile(path) as archive:
            if len(archive.infolist()) > MAX_ARCHIVE_ITEMS:
                return None
            name = _cover_member_name(archive)
            if not name:
                return None
            raw = _read_member(archive, name, MAX_IMAGE_BYTES)

        with Image.open(BytesIO(raw)) as image:
            if image.width <= 0 or image.height <= 0:
                return None
            if image.width * image.height > MAX_IMAGE_PIXELS:
                return None
            image.load()
            oriented = ImageOps.exif_transpose(image)
            oriented.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            # Alpha masks need a white backing before conversion to JPEG.
            if oriented.mode in ("RGBA", "LA") or "transparency" in oriented.info:
                rgba = oriented.convert("RGBA")
                rgb = Image.new("RGB", rgba.size, (255, 255, 255))
                rgb.paste(rgba, mask=rgba.getchannel("A"))
            else:
                rgb = oriented.convert("RGB")

            output = BytesIO()
            rgb.save(output, format="JPEG", quality=78, optimize=True)
            return output.getvalue()
    except (OSError, KeyError, ValueError, BadZipFile, ElementTree.ParseError,
            RuntimeError, UnidentifiedImageError) as error:
        logging.info("EPUB cover unavailable for %s: %s", path.name, error)
        return None
