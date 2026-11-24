export const config = { maxDuration: 45 };

// 같은 곡을 반복 분석할 때 쿼터를 아끼기 위한 인스턴스 단위 캐시 (콜드스타트 시 초기화됨)
const CACHE = new Map();
const CACHE_MAX = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 응답에서 "일일 한도"인지, 몇 초 뒤 재시도하면 되는지 읽어낸다
function parse429(bodyText) {
  let daily = false, retryMs = 0;
  try {
    const err = JSON.parse(bodyText)?.error;
    for (const d of err?.details || []) {
      if (d["@type"]?.includes("RetryInfo") && d.retryDelay) retryMs = parseFloat(d.retryDelay) * 1000 || 0;
      if (d["@type"]?.includes("QuotaFailure"))
        for (const v of d.violations || []) if (/PerDay/i.test(v.quotaId || "")) daily = true;
    }
  } catch {}
  return { daily, retryMs };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(501).json({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다.", code: "no_key" });

  const body = req.body || {};
  const trackName = String(body.trackName || "").slice(0, 200);
  const artistName = String(body.artistName || "").slice(0, 200);
  const albumName = String(body.albumName || "").slice(0, 200);
  const genreHint = String(body.genreHint || "").slice(0, 80);
  const lyrics = body.lyrics ? String(body.lyrics) : "";
  const { bpm, keyName } = body;
  if (!trackName || !artistName) return res.status(400).json({ error: "trackName과 artistName이 필요합니다." });

  const cacheKey = [trackName, artistName, bpm || "", keyName || "", lyrics ? 1 : 0].join("|").toLowerCase();
  if (CACHE.has(cacheKey)) return res.status(200).json(CACHE.get(cacheKey));

  const prompt = `당신은 프로듀서와 DJ를 위한 음악 분석가입니다. 아래 곡의 사운드 특징을 분석하세요.

- 곡명: ${trackName}
- 아티스트: ${artistName}
- 앨범: ${albumName || "Single"}
- 장르 힌트: ${genreHint || "Unknown"}
- 오디오에서 측정한 BPM: ${bpm || "측정 안 됨"}
- 오디오에서 측정한 키: ${keyName || "측정 안 됨"}
- 가사:
${lyrics ? lyrics.slice(0, 1200) : "(가사 데이터베이스에서 가사를 찾지 못했습니다. 가사가 있는 곡인지는 알 수 없습니다.)"}

규칙:
1. categories는 정확히 4개: "장르 & 세부 장르", "주요 악기", "보컬 스타일", "분위기". 각 2~4개 항목.
2. conf는 해당 태그에 대한 당신의 추정 확신도(50~99 정수)입니다. 모르면 낮게 주세요.
3. lyricsSummary와 moodKeywords, note는 한국어로 작성하세요.
4. 가사를 찾지 못한 것은 연주곡이라는 뜻이 아닙니다. 가사가 제공되지 않았다면 연주곡(Instrumental)이라고 단정하지 말고, 보컬 항목은 확신도를 60 이하로 낮추고 note에 "가사/음원 정보 부족"이라고 쓰세요. lyricsSummary에는 "가사 데이터를 찾지 못해 요약할 수 없습니다"라고 쓰세요.`;

  const item = {
    type: "OBJECT",
    properties: { label: { type: "STRING" }, conf: { type: "INTEGER" }, note: { type: "STRING" } },
    required: ["label", "conf", "note"]
  };
  const responseSchema = {
    type: "OBJECT",
    properties: {
      categories: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { title: { type: "STRING" }, items: { type: "ARRAY", items: item } },
          required: ["title", "items"]
        }
      },
      moodKeywords: { type: "ARRAY", items: { type: "STRING" } },
      lyricsSummary: { type: "STRING" }
    },
    required: ["categories", "moodKeywords", "lyricsSummary"]
  };

  // 모델별 쿼터는 따로 계산되므로, 구형(2.5) 안정 모델을 마지막 보루로 추가
  const models = [...new Set([
    process.env.GEMINI_MODEL,
    "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash",
    "gemini-2.5-flash-lite", "gemini-2.5-flash"
  ].filter(Boolean))];

  const mk = (think) => JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseSchema,
      ...(think ? { thinkingConfig: { thinkingLevel: "low" } } : {})
    }
  });

  const deadline = Date.now() + 40000;
  const left = () => deadline - Date.now();

  // 단일 호출: { ok, status, text }
  const call = async (m, think) => {
    if (left() < 3000) return { ok: false, status: 504, text: "" };
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: mk(think),
        signal: AbortSignal.timeout(Math.min(20000, left()))
      });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch {
      return { ok: false, status: 504, text: "" };
    }
  };

  const tried = [];       // 디버그용 (클라이언트 콘솔에만 표시)
  let saw429 = false, saw5xx = false, sawAuth = false;
  let result = null;

  outer: for (const m of models) {
    let think = true, attempts = 0;
    while (attempts < 2) {
      attempts++;
      let r = await call(m, think);
      // thinkingConfig 미지원 모델이면 옵션 빼고 즉시 재시도 (시도 횟수에 포함하지 않음)
      if (r.status === 400 && think) { think = false; attempts--; continue; }

      if (r.ok) { result = r; break outer; }

      tried.push(`${m}:${r.status}`);

      if (r.status === 429) {
        saw429 = true;
        const { daily, retryMs } = parse429(r.text);
        // 일일 한도면 다른 모델로, 분당 한도이고 짧게 기다리면 되면 같은 모델 재시도
        if (!daily && retryMs > 0 && retryMs <= 4000 && left() > retryMs + 5000 && attempts < 2) {
          await sleep(retryMs + 200);
          continue;
        }
        break; // 다음 모델
      }
      if (r.status === 500 || r.status === 503 || r.status === 504) {
        saw5xx = true;
        // 일시적 과부하: 짧은 백오프 후 같은 모델 1회 재시도
        if (attempts < 2 && left() > 8000) { await sleep(800 + Math.random() * 700); continue; }
        break;
      }
      if (r.status === 401 || r.status === 403) { sawAuth = true; break outer; }
      break; // 400/404 등: 다음 모델
    }
  }

  if (!result) {
    let code = "failed", status = 502, error = "AI 분석에 실패했습니다.";
    if (sawAuth) { code = "auth"; status = 500; error = "Gemini API 키가 유효하지 않거나 권한이 없습니다. 서버 설정을 확인하세요."; }
    else if (saw5xx) { code = "overloaded"; status = 503; error = "AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요."; }
    else if (saw429) { code = "quota"; status = 429; error = "AI 사용 한도를 초과했습니다. 잠시 후 다시 시도하거나 API 요금제/쿼터를 확인하세요."; }
    res.setHeader("Retry-After", "20");
    return res.status(status).json({ error, code, retryable: code !== "auth", debug: tried });
  }

  try {
    const data = JSON.parse(result.text);
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    if (!text) return res.status(502).json({ error: "Gemini 응답이 비어 있습니다.", code: "empty", retryable: true, debug: tried });
    const out = JSON.parse(text);
    if (!Array.isArray(out.categories) || !out.categories.length)
      return res.status(502).json({ error: "AI 응답 형식이 올바르지 않습니다.", code: "bad_format", retryable: true, debug: tried });

    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(cacheKey, out);
    return res.status(200).json(out);
  } catch {
    // 출력이 중간에 잘렸을 때 등
    return res.status(502).json({ error: "AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.", code: "parse", retryable: true, debug: tried });
  }
}
