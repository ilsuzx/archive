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
4. label과 moodKeywords의 표기를 통일하세요. 장르·악기·보컬 스타일은 한국어 표기가 널리 쓰이면 한국어(예: 힙합, 어쿠스틱 기타, 신디사이저), R&B·K-Pop·Lo-fi처럼 영어 표기가 일반적인 용어는 영어로만 쓰고, 괄호로 번역을 병기하지 마세요. 같은 개념은 항상 같은 표기를 쓰세요.
5. 가사를 찾지 못한 것은 연주곡이라는 뜻이 아닙니다. 가사가 제공되지 않았다면 연주곡(Instrumental)이라고 단정하지 말고, 보컬 항목은 확신도를 60 이하로 낮추고 note에 "가사/음원 정보 부족"이라고 쓰세요. lyricsSummary에는 "가사 데이터를 찾지 못해 요약할 수 없습니다"라고 쓰세요.`;

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

  // 모델별 쿼터·혼잡도는 따로라서, 세대가 다른 모델을 섞어 두 줄(lane)로 동시에 시도한다
  const models = [...new Set([
    process.env.GEMINI_MODEL,
    "gemini-3.5-flash-lite", "gemini-2.5-flash-lite",
    "gemini-3.6-flash", "gemini-3.8-flash", "gemini-2.5-flash"
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
  const ctl = new AbortController();   // 한 줄이 성공하면 나머지 요청을 중단

  // 단일 호출: { ok, status, text }
  const call = async (m, think, ms) => {
    if (left() < 3000 || ctl.signal.aborted) return { ok: false, status: 504, text: "" };
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), Math.min(ms, left()));
    const onAbort = () => c.abort();
    ctl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: mk(think),
        signal: c.signal
      });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch {
      return { ok: false, status: 504, text: "" };
    } finally {
      clearTimeout(timer);
      ctl.signal.removeEventListener("abort", onAbort);
    }
  };

  // 응답 본문 → 결과 객체 (형식이 틀리면 null)
  const parseOut = (text) => {
    try {
      const cand = JSON.parse(text)?.candidates?.[0];
      const t = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
      if (!t) return null;
      const out = JSON.parse(t);
      return Array.isArray(out.categories) && out.categories.length ? out : null;
    } catch { return null; }
  };

  const tried = [];       // 디버그용
  let saw429 = false, saw5xx = false, sawAuth = false, finished = false;

  // 한 줄: 모델을 순서대로 시도. 성공하면 결과 객체, 전부 실패하면 null
  const lane = async (list) => {
    for (const m of list) {
      let think = true, attempts = 0;
      while (attempts < 2) {
        if (finished || sawAuth || left() < 3000) return null;
        attempts++;
        const r = await call(m, think, 14000);
        if (finished) return null;
        // thinkingConfig 미지원 모델이면 옵션 빼고 즉시 재시도 (시도 횟수에 포함하지 않음)
        if (r.status === 400 && think) { think = false; attempts--; continue; }

        if (r.ok) {
          const out = parseOut(r.text);
          if (out) return out;
          tried.push(`${m}:bad`);   // 비었거나 잘림 → 다음 모델
          break;
        }
        tried.push(`${m}:${r.status}`);

        if (r.status === 429) {
          saw429 = true;
          const { daily, retryMs } = parse429(r.text);
          if (!daily && retryMs > 0 && retryMs <= 4000 && left() > retryMs + 5000 && attempts < 2) {
            await sleep(retryMs + 200);
            continue;
          }
          break;
        }
        if (r.status === 500 || r.status === 503) {
          saw5xx = true;
          // 일시적 과부하: 짧게 쉬고 같은 모델 1회 재시도
          if (attempts < 2 && left() > 8000) { await sleep(600 + Math.random() * 600); continue; }
          break;
        }
        if (r.status === 504) { saw5xx = true; break; }   // 시간 초과: 기다리지 말고 다음 모델
        if (r.status === 401 || r.status === 403) { sawAuth = true; return null; }
        break; // 400/404 등: 다음 모델
      }
    }
    return null;
  };

  const lanes = [[], []];
  models.forEach((m, i) => lanes[i % 2].push(m));
  const out = await new Promise((resolve) => {
    let pending = lanes.length;
    const done = (o) => {
      if (o) { finished = true; ctl.abort(); resolve(o); }
      else if (--pending === 0) resolve(null);
    };
    lanes.forEach((l) => lane(l).then(done, () => done(null)));
  });

  if (!out) {
    let code = "failed", status = 502, error = "AI 분석에 실패했습니다.";
    if (sawAuth) { code = "auth"; status = 500; error = "Gemini API 키가 유효하지 않거나 권한이 없습니다. 서버 설정을 확인하세요."; }
    else if (saw5xx) { code = "overloaded"; status = 503; error = "AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요."; }
    else if (saw429) { code = "quota"; status = 429; error = "AI 사용 한도를 초과했습니다. 잠시 후 다시 시도하거나 API 요금제/쿼터를 확인하세요."; }
    res.setHeader("Retry-After", "20");
    return res.status(status).json({ error: `${error} [${tried.slice(0, 6).join(", ")}]`, code, retryable: code !== "auth", debug: tried });
  }

  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(cacheKey, out);
  return res.status(200).json(out);
}
