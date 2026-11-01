// 单页 hash 路由：#/stream/<uuid>、#/agents、#/scheduler、#/inbox、#/vms、#/about、#/verify?token=…
import { useEffect, useState } from "react";

export type Route = {
  hash: string;
  segments: string[];
  query: URLSearchParams;
};

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  return {
    hash: raw,
    segments: pathPart.split("/").filter(Boolean),
    query: new URLSearchParams(queryPart ?? ""),
  };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string) {
  const next = to.startsWith("#") ? to : `#${to.startsWith("/") ? to : `/${to}`}`;
  if (window.location.hash === next) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = next;
}
