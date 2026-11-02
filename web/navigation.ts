export type Route = { terminal?: string; query: string };

export function readRoute(href: string): Route {
  const url = new URL(href);
  const terminal = url.searchParams.get("terminal");
  return { terminal: terminal || undefined, query: url.searchParams.get("q") || "" };
}

export function routeUrl(href: string, route: Route): string {
  const url = new URL(href);
  if (route.terminal) url.searchParams.set("terminal", route.terminal);
  else url.searchParams.delete("terminal");
  if (route.query) url.searchParams.set("q", route.query);
  else url.searchParams.delete("q");
  return url.href;
}
