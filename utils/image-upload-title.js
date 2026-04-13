const path = require('path');
const sharp = require('sharp');

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
    const normalized = String(entity || '').toLowerCase();

    if (normalized === 'amp') return '&';
    if (normalized === 'apos') return "'";
    if (normalized === 'gt') return '>';
    if (normalized === 'lt') return '<';
    if (normalized === 'quot') return '"';

    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return match;
  });
}

function cleanEmbeddedTitle(value) {
  return normalizeWhitespace(
    decodeXmlEntities(String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' '))
  );
}

function deriveTitleFromFilename(originalname = '') {
  const baseName = path.parse(originalname || '').name;

  return normalizeWhitespace(
    String(baseName || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function decodeBinaryText(buffer) {
  if (!buffer || !buffer.length) return '';

  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return utf8;
  }

  return buffer.toString('latin1');
}

function parseXmpTitle(xmpBuffer) {
  const xmp = xmpBuffer ? xmpBuffer.toString('utf8') : '';
  if (!xmp) return '';

  const dcTitleMatch = xmp.match(/<dc:title[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:title>/i);
  if (dcTitleMatch && dcTitleMatch[1]) {
    const title = cleanEmbeddedTitle(dcTitleMatch[1]);
    if (title) return title;
  }

  const headlineMatch = xmp.match(/<photoshop:Headline>([\s\S]*?)<\/photoshop:Headline>/i);
  if (headlineMatch && headlineMatch[1]) {
    const headline = cleanEmbeddedTitle(headlineMatch[1]);
    if (headline) return headline;
  }

  const objectNameMatch = xmp.match(/<(?:Iptc4xmpCore:ObjectName|xmp:Title)>([\s\S]*?)<\/(?:Iptc4xmpCore:ObjectName|xmp:Title)>/i);
  if (objectNameMatch && objectNameMatch[1]) {
    const objectName = cleanEmbeddedTitle(objectNameMatch[1]);
    if (objectName) return objectName;
  }

  return '';
}

function parseIptcTitle(iptcBuffer) {
  if (!iptcBuffer || !iptcBuffer.length) return '';

  let offset = 0;
  while (offset + 5 <= iptcBuffer.length) {
    if (iptcBuffer[offset] !== 0x1c) {
      offset += 1;
      continue;
    }

    const recordNumber = iptcBuffer[offset + 1];
    const datasetNumber = iptcBuffer[offset + 2];
    const sizeMarker = iptcBuffer.readUInt16BE(offset + 3);
    let size = sizeMarker;
    let dataOffset = offset + 5;

    if ((sizeMarker & 0x8000) !== 0) {
      const byteCount = sizeMarker & 0x7fff;
      if (offset + 5 + byteCount > iptcBuffer.length) {
        break;
      }
      size = 0;
      for (let index = 0; index < byteCount; index += 1) {
        size = (size << 8) + iptcBuffer[offset + 5 + index];
      }
      dataOffset += byteCount;
    }

    const endOffset = dataOffset + size;
    if (endOffset > iptcBuffer.length) {
      break;
    }

    if (recordNumber === 2 && (datasetNumber === 5 || datasetNumber === 105)) {
      const title = cleanEmbeddedTitle(decodeBinaryText(iptcBuffer.subarray(dataOffset, endOffset)));
      if (title) {
        return title;
      }
    }

    offset = endOffset;
  }

  return '';
}

function getExifValueBytes(buffer, tiffStart, entryOffset, type, count, readUInt32) {
  const bytesPerValue = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    7: 1,
  }[type];

  if (!bytesPerValue) return Buffer.alloc(0);

  const totalLength = bytesPerValue * count;
  if (!Number.isFinite(totalLength) || totalLength <= 0) {
    return Buffer.alloc(0);
  }

  if (totalLength <= 4) {
    return buffer.subarray(entryOffset + 8, entryOffset + 8 + totalLength);
  }

  const valueOffset = readUInt32(entryOffset + 8);
  const start = tiffStart + valueOffset;
  const end = start + totalLength;
  if (start < 0 || end > buffer.length) {
    return Buffer.alloc(0);
  }

  return buffer.subarray(start, end);
}

function parseExifTitle(exifBuffer) {
  if (!exifBuffer || exifBuffer.length < 14) return '';

  const tiffStart = exifBuffer.subarray(0, 6).toString('ascii') === 'Exif\u0000\u0000' ? 6 : 0;
  if (tiffStart + 8 > exifBuffer.length) return '';

  const byteOrder = exifBuffer.subarray(tiffStart, tiffStart + 2).toString('ascii');
  const isLittleEndian = byteOrder === 'II';
  if (!isLittleEndian && byteOrder !== 'MM') return '';

  const readUInt16 = (offset) => {
    if (offset + 2 > exifBuffer.length) return 0;
    return isLittleEndian ? exifBuffer.readUInt16LE(offset) : exifBuffer.readUInt16BE(offset);
  };
  const readUInt32 = (offset) => {
    if (offset + 4 > exifBuffer.length) return 0;
    return isLittleEndian ? exifBuffer.readUInt32LE(offset) : exifBuffer.readUInt32BE(offset);
  };

  if (readUInt16(tiffStart + 2) !== 42) return '';

  const ifdOffset = readUInt32(tiffStart + 4);
  const ifdStart = tiffStart + ifdOffset;
  if (!ifdOffset || ifdStart + 2 > exifBuffer.length) return '';

  const entryCount = readUInt16(ifdStart);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdStart + 2 + (index * 12);
    if (entryOffset + 12 > exifBuffer.length) break;

    const tag = readUInt16(entryOffset);
    const type = readUInt16(entryOffset + 2);
    const count = readUInt32(entryOffset + 4);

    if (tag === 0x010e) {
      const bytes = getExifValueBytes(exifBuffer, tiffStart, entryOffset, type, count, readUInt32);
      const title = cleanEmbeddedTitle(decodeBinaryText(bytes).split('\u0000')[0]);
      if (title) return title;
    }

    if (tag === 0x9c9b) {
      const bytes = getExifValueBytes(exifBuffer, tiffStart, entryOffset, type, count, readUInt32);
      const title = cleanEmbeddedTitle(bytes.toString('utf16le').replace(/\u0000+/g, ''));
      if (title) return title;
    }
  }

  return '';
}

async function readEmbeddedImageTitle(filePath) {
  if (!filePath) return '';

  try {
    const metadata = await sharp(filePath).metadata();
    return (
      parseExifTitle(metadata.exif) ||
      parseIptcTitle(metadata.iptc) ||
      parseXmpTitle(metadata.xmp) ||
      ''
    );
  } catch (err) {
    return '';
  }
}

async function deriveImageUploadTitle(filePath, originalname = '') {
  const embeddedTitle = await readEmbeddedImageTitle(filePath);
  if (embeddedTitle) {
    return embeddedTitle;
  }

  return deriveTitleFromFilename(originalname);
}

module.exports = {
  deriveImageUploadTitle,
  deriveTitleFromFilename,
};