const ALLOWED = /(^|\.)(itunes\.apple\.com|mzstatic\.com)$/;
const MAX_BYTES = 8 * 1024 * 1024;
const okUrl = (u) => u.protocol === "https:" && ALLOWED.test(u.hostname);

export default async function handler(req, res) {
  try {
    let target = new URL(String(req.query.url || ""));
    if (!okUrl(target)) return res.status(400).json({ error: "허용되지 않는 URL입니다." });

    // 리다이렉트를 자동으로 따라가면 허용 목록 밖으로 나갈 수 있어, 직접 따라가며 매번 검사한다
    let r;
    for (let i = 0; i < 4; i++) {
      r = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      const loc = r.headers.get("location");
      if (r.status < 300 || r.status >= 400 || !loc) break;
      target = new URL(loc, target);
      if (!okUrl(target)) return res.status(400).json({ error: "허용되지 않는 URL입니다." });
    }
    if (!r.ok) return res.status(r.status >= 400 ? r.status : 502).end();

    // 오디오와 JSON만 중계한다 (우리 도메인에서 HTML 등이 내려가는 것을 방지)
    const type = (r.headers.get("content-type") || "").toLowerCase();
    const isJson = /json|javascript/.test(type);
    if (!isJson && !/^(audio\/|video\/mp4)/.test(type)) return res.status(415).json({ error: "지원하지 않는 형식입니다." });
    if (Number(r.headers.get("content-length")) > MAX_BYTES) return res.status(413).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).end();

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", isJson ? "application/json; charset=utf-8" : type);
    res.setHeader("Cache-Control", `public, max-age=${isJson ? 3600 : 86400}`);
    res.send(buf);
  } catch {
    res.status(502).json({ error: "요청을 처리하지 못했습니다." });
  }
}
