/** For Docker's health check: the web server is up and answering. (nginx answers /healthz itself for the outside.) */
export function GET(): Response {
  return Response.json({ status: "ok" });
}
