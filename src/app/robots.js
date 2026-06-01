// App Router metadata route → served at /robots.txt.
// Polite layer: well-behaved crawlers self-exclude the private surfaces.
// Hard enforcement (UA block / rate limit) lives in the bot guard.
export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/api", "/login"],
      },
    ],
  };
}
