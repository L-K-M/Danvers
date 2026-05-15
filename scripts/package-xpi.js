const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "dist");
const outputFile = path.join(outputDir, "danvers-karakeep.xpi");
const entries = ["manifest.json", "README.md", "LICENSE", "src", "icons"];
const CRC_TABLE = buildCrcTable();

fs.mkdirSync(outputDir, { recursive: true });

const files = entries.flatMap((entry) => collectFiles(path.join(root, entry), entry));
const chunks = [];
const centralDirectory = [];
let offset = 0;

for (const file of files) {
  const input = fs.readFileSync(file.absolutePath);
  const compressed = zlib.deflateRawSync(input);
  const crc = crc32(input);
  const name = Buffer.from(file.archivePath.replace(/\\/g, "/"));
  const localHeader = Buffer.alloc(30);

  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(input.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);

  chunks.push(localHeader, name, compressed);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(input.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(offset, 42);
  centralDirectory.push(centralHeader, name);

  offset += localHeader.length + name.length + compressed.length;
}

const centralDirectoryOffset = offset;
const centralDirectorySize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
const endRecord = Buffer.alloc(22);
endRecord.writeUInt32LE(0x06054b50, 0);
endRecord.writeUInt16LE(0, 4);
endRecord.writeUInt16LE(0, 6);
endRecord.writeUInt16LE(files.length, 8);
endRecord.writeUInt16LE(files.length, 10);
endRecord.writeUInt32LE(centralDirectorySize, 12);
endRecord.writeUInt32LE(centralDirectoryOffset, 16);
endRecord.writeUInt16LE(0, 20);

fs.writeFileSync(outputFile, Buffer.concat([...chunks, ...centralDirectory, endRecord]));
console.log(`Wrote ${path.relative(root, outputFile)} (${files.length} files)`);

function collectFiles(absolutePath, archivePath) {
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    return [{ absolutePath, archivePath }];
  }

  return fs
    .readdirSync(absolutePath)
    .sort()
    .flatMap((child) =>
      collectFiles(path.join(absolutePath, child), path.posix.join(archivePath, child)),
    );
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}
