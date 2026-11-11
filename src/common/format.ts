export const age = (timestamp: string | undefined, now = Date.now()): string => {
  if (!timestamp) {
    return "—";
  }

  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));

  if (Number.isNaN(seconds)) {
    return "—";
  }

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;

  return `${Math.floor(seconds / 86400)}d`;
};

export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

export const truncate = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export const compareValues = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }

  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
};

export const kubernetesNameError = (name: string, { dns1123Label = false } = {}): string | undefined => {
  if (!name) {
    return "A name is required";
  }

  if (name.length > (dns1123Label ? 63 : 253)) {
    return `At most ${dns1123Label ? 63 : 253} characters`;
  }

  const pattern = dns1123Label ? /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/ : /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

  return pattern.test(name) ? undefined : "Lowercase letters, digits, '-' and '.' only, starting and ending with a letter or digit";
};
