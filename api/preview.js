const ALLOWED = /(^|\.)(itunes\.apple\.com|mzstatic\.com)$/;

export default async function handler(req, res) {
  try {
    const u = new URL(req.query.url);
    if (u.protocol !== "https:" || !ALLOWED.test(u.hostname)) {
      return res.status(400).json({ error: "허용되지 않는 URL입니다." });
    }
    const r = await fetch(u);
    if (!r.ok) return res.status(r.status).end();
    res.setHeader("Content-Type", r.headers.get("content-type") || "audio/mp4");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(400).json({ error: "요청을 처리하지 못했습니다." });
  }
}
