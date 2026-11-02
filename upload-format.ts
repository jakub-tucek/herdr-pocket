export const MAX_UPLOAD = 8 * 1024 * 1024;
export function uploadName(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").at(-1) || "file";
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[-.]+/, "").slice(-120) || "file";
}
export function pastedPaths(paths: string[]): string {
  return paths.map(path => /^[A-Za-z0-9_./:-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`).join(" ") + " ";
}
