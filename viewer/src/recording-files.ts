/** Capture request time in UTC. Legacy names contain system uptime, not a date. */
export function recordingTimestamp(name: string): number | null {
  const match =
    /^capture-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-pid\d+-\d+\.isaacprof$/i.exec(
      name,
    );
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`,
    time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : null;
}
export function recordingTime(file: Pick<File, 'name' | 'lastModified'>) {
  return recordingTimestamp(file.name) ?? file.lastModified;
}
export function recordingOrder(
  a: { key: string; file: Pick<File, 'name' | 'lastModified'> },
  b: { key: string; file: Pick<File, 'name' | 'lastModified'> },
) {
  return recordingTime(b.file) - recordingTime(a.file) || a.key.localeCompare(b.key);
}
export function recordingLabel(file: Pick<File, 'name' | 'lastModified'>, key = file.name) {
  const time = recordingTimestamp(file.name),
    date = new Date(time ?? file.lastModified),
    pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${time === null ? 'Modified ' : ''}${stamp} \u00b7 ${key}`;
}
