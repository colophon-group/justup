// The supported public hash routes stay explicit and require no custom router framework.
import { useEffect, useState } from "react";
export type Route =
  | { page: "jobs" | "companies" | "request" }
  | { page: "company"; id: string }
  | { page: "invalid" };
export function readRoute(hash: string): Route {
  const [page = "jobs", encoded] = hash.replace(/^#/, "").split("/");
  if (!page || page === "jobs") return { page: "jobs" };
  if (page === "companies" || page === "request") return { page };
  if (page === "company" && encoded) {
    try {
      const id = decodeURIComponent(encoded);
      return id ? { page, id } : { page: "invalid" };
    } catch {
      return { page: "invalid" };
    }
  }
  return { page: "invalid" };
}
export function useRoute(): Route {
  const [route, setRoute] = useState(() => readRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(readRoute(location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
