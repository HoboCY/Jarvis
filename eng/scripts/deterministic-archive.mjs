import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

const TAR_BLOCK_SIZE = 512;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_UNIX_MADE_BY = (3 << 8) | ZIP_VERSION;
const ZIP_DOS_DATE = 1;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/**
 * Create a deterministic archive from a directory. Archive entry order,
 * timestamps, ownership, extended attributes and compression settings are
 * explicit so two builds from the same input produce the same bytes.
 */
export function createDeterministicArchive(kind, sourceDirectory, outputPath) {
  const source = resolveDirectory(sourceDirectory);
  const output = resolve(outputPath);
  const entries = collectEntries(source);
  const archive = kind === "tar.gz"
    ? createTarGz(entries)
    : kind === "zip"
      ? createZip(entries)
      : (() => {
          throw new Error(`Unsupported deterministic archive kind: ${kind}`);
        })();

  writeFileSync(output, archive, { mode: 0o600 });
  return output;
}

function resolveDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("Archive source must be an explicit absolute directory.");
  }

  const source = resolve(value);
  const stats = lstatSync(source);
  if (!stats.isDirectory()) {
    throw new Error("Archive source must be a directory.");
  }

  return source;
}

function collectEntries(source) {
  const entries = [];
  walk(source, "", entries);
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  return entries;
}

function walk(path, name, entries) {
  const stats = lstatSync(path);
  if (name.length > 0) {
    entries.push({ name: name.replaceAll("\\", "/"), path, stats });
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return;
  }

  const children = readdirSync(path, { encoding: "utf8" })
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  for (const child of children) {
    walk(join(path, child), name.length > 0 ? `${name}/${child}` : child, entries);
  }
}

function createTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = entry.stats.isFile() ? readFileSync(entry.path) : Buffer.alloc(0);
    blocks.push(createTarHeader(entry, data.length));
    if (data.length > 0) {
      blocks.push(data);
      const padding = (TAR_BLOCK_SIZE - (data.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      if (padding > 0) {
        blocks.push(Buffer.alloc(padding));
      }
    }
  }

  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  const tar = Buffer.concat(blocks);
  const gzip = gzipSync(tar, { level: 9, mtime: 0 });
  // Node currently writes a deterministic mtime, but normalize all portable
  // gzip header fields explicitly for older/newer runtimes as well.
  gzip.writeUInt32LE(0, 4);
  gzip[8] = 2;
  gzip[9] = 255;
  return gzip;
}

function createTarHeader(entry, size) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(entry.name);
  writeFixedString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.stats.mode & 0o7777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header[156] = entry.stats.isDirectory()
    ? "5".charCodeAt(0)
    : entry.stats.isSymbolicLink()
      ? "2".charCodeAt(0)
      : "0".charCodeAt(0);
  if (entry.stats.isSymbolicLink()) {
    writeFixedString(header, 157, 100, readlinkSync(entry.path));
  }
  writeFixedString(header, 257, 6, "ustar\0");
  writeFixedString(header, 263, 2, "00");
  writeFixedString(header, 265, 32, "root");
  writeFixedString(header, 297, 32, "wheel");
  writeFixedString(header, 345, 155, prefix);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeFixedString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function splitTarPath(value) {
  const bytes = Buffer.byteLength(value);
  if (bytes <= 100) {
    return { name: value, prefix: "" };
  }

  const slashPositions = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "/") {
      slashPositions.push(index);
    }
  }
  for (const slash of slashPositions.reverse()) {
    const prefix = value.slice(0, slash);
    const name = value.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`Archive entry path is too long for deterministic ustar: ${value}`);
}

function writeOctal(buffer, offset, length, value) {
  const text = `${Math.max(0, value).toString(8).padStart(length - 1, "0")}\0`;
  writeFixedString(buffer, offset, length, text);
}

function writeFixedString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) {
    throw new Error(`Archive field exceeds ${length} bytes: ${value}`);
  }
  bytes.copy(buffer, offset, 0, bytes.length);
}

function createZip(entries) {
  if (entries.length > MAX_UINT16) {
    throw new Error("Deterministic ZIP cannot contain more than 65535 entries.");
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.stats.isDirectory() && !entry.name.endsWith("/")
      ? `${entry.name}/`
      : entry.name;
    const nameBytes = Buffer.from(name, "utf8");
    const data = entry.stats.isFile()
      ? readFileSync(entry.path)
      : entry.stats.isSymbolicLink()
        ? Buffer.from(readlinkSync(entry.path), "utf8")
        : Buffer.alloc(0);
    const crc = crc32(data);
    const compressed = entry.stats.isDirectory()
      ? data
      : deflateRawSync(data, { level: 9 });
    const method = entry.stats.isDirectory() ? 0 : 8;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    writeZipSize(localHeader, 18, compressed.length);
    writeZipSize(localHeader, 22, data.length);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(ZIP_UNIX_MADE_BY, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    writeZipSize(centralHeader, 20, compressed.length);
    writeZipSize(centralHeader, 24, data.length);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    const mode = entry.stats.mode & 0o7777;
    const fileType = entry.stats.isDirectory()
      ? 0o040000
      : entry.stats.isSymbolicLink()
        ? 0o120000
        : 0o100000;
    centralHeader.writeUInt32LE(((fileType | mode) << 16) >>> 0, 38);
    writeZipSize(centralHeader, 42, offset);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localDirectory = Buffer.concat(localParts);
  if (offset > MAX_UINT32 || centralDirectory.length > MAX_UINT32) {
    throw new Error("Deterministic ZIP exceeds the classic ZIP32 size limit.");
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localDirectory.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localDirectory, centralDirectory, end]);
}

function writeZipSize(buffer, offset, value) {
  if (value > MAX_UINT32) {
    throw new Error("Deterministic ZIP field exceeds ZIP32 size limit.");
  }
  buffer.writeUInt32LE(value, offset);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [, , kind, sourceDirectory, outputPath] = process.argv;
  if (!kind || !sourceDirectory || !outputPath) {
    console.error("Usage: deterministic-archive.mjs <tar.gz|zip> <source-directory> <output-path>");
    process.exitCode = 2;
  } else {
    try {
      createDeterministicArchive(kind, sourceDirectory, outputPath);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
