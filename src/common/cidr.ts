/** IPv4 and IPv6 ranges as BigInt intervals, for containment, overlap and size checks. */
export interface IpRange {
  readonly family: 4 | 6;
  readonly start: bigint;
  readonly end: bigint;
  readonly label: string;
}

export const parseIPv4 = (text: string): bigint | undefined => {
  const parts = text.trim().split(".");

  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256)) {
    return undefined;
  }

  return parts.reduce((sum, part) => sum * 256n + BigInt(Number(part)), 0n);
};

export const parseIPv6 = (text: string): bigint | undefined => {
  let address = text.trim().toLowerCase();

  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }

  // An embedded IPv4 tail, as in ::ffff:10.0.0.1.
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);

  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);

    if (v4 === undefined) {
      return undefined;
    }

    address = `${address.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const halves = address.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;

  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return undefined;
  }

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];

  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return undefined;
  }

  return groups.reduce((sum, group) => (sum << 16n) + BigInt(parseInt(group, 16)), 0n);
};

export const parseIp = (text: string): { family: 4 | 6; value: bigint } | undefined => {
  const v4 = parseIPv4(text);

  if (v4 !== undefined) {
    return { family: 4, value: v4 };
  }

  const v6 = parseIPv6(text);

  return v6 === undefined ? undefined : { family: 6, value: v6 };
};

export const parseCidr = (text: string): IpRange | undefined => {
  const [address, bitsText] = text.trim().split("/");
  const ip = parseIp(address ?? "");

  if (!ip) {
    return undefined;
  }

  const width = ip.family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);

  if (!Number.isInteger(bits) || bits < 0 || bits > width || (bitsText !== undefined && !/^\d+$/.test(bitsText))) {
    return undefined;
  }

  const hostBits = BigInt(width - bits);
  const size = 1n << hostBits;
  const start = (ip.value >> hostBits) << hostBits;

  return { family: ip.family, start, end: start + size - 1n, label: text.trim() };
};

export const rangeFromStartStop = (startText: string, stopText?: string): IpRange | undefined => {
  const start = parseIp(startText);
  const stop = parseIp(stopText ?? startText);

  if (!start || !stop || start.family !== stop.family || stop.value < start.value) {
    return undefined;
  }

  return { family: start.family, start: start.value, end: stop.value, label: stopText ? `${startText}–${stopText}` : startText };
};

export const rangeSize = (range: IpRange) => range.end - range.start + 1n;

export const rangeContains = (range: IpRange, ip: string) => {
  const parsed = parseIp(ip);

  return parsed !== undefined && parsed.family === range.family && parsed.value >= range.start && parsed.value <= range.end;
};

export const rangesOverlap = (a: IpRange, b: IpRange) => a.family === b.family && a.start <= b.end && b.start <= a.end;

/** A pool block as Cilium writes it: `{ cidr }` or `{ start, stop }`. */
export const rangeOfBlock = (block: { cidr?: string; start?: string; stop?: string }): IpRange | undefined =>
  typeof block.cidr === "string" ? parseCidr(block.cidr) : typeof block.start === "string" ? rangeFromStartStop(block.start, block.stop) : undefined;

export const formatCount = (count: bigint) => (count > 1_000_000_000n ? `2^${count.toString(2).length - 1}` : count.toLocaleString());
