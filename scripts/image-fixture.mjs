import { deflateSync } from "node:zlib";
function crc(bytes) {
  let value = 0xffffffff;
  for (const b of bytes) {
    value ^= b;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function png(left, right) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4),
      check = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128, 0);
  header.writeUInt32BE(96, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(96 * (1 + 128 * 3));
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 128; x++) {
      const p = y * (1 + 128 * 3) + 1 + x * 3;
      const color = x < 64 ? left : right;
      for (let c = 0; c < 3; c++) pixels[p + c] = color[c];
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
