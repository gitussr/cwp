import { crc32 as nodeCrc32 } from "node:zlib";

/**
 * CRC-32 (IEEE 802.3 polynomial) checksum — the same algorithm gzip, PNG,
 * and zlib use for integrity checks. We delegate to Node's own C++
 * implementation (`node:zlib`, available since Node 21.7) instead of
 * hand-rolling a lookup-table CRC: it's the same algorithm, already
 * battle-tested, faster than a JS loop, and removes an entire class of
 * off-by-one bugs from this codebase.
 */
export function crc32(data: Uint8Array): number {
  return nodeCrc32(data);
}
