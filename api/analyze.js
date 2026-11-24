export const config = { maxDuration: 45 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(501).json({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." });

  const { trackName, artistName, albumName, genreHint, lyrics, bpm, keyName } = req.body || {};
  if (!trackName || !artistName) return res.status(400).json({ error: "trackName과 artistName이 필요합니다." });

  const prompt = `당신은 프로듀서와 DJ를 위한 음악 분석가입니다. 아래 곡의 사운드 특징을 분석하세요.

- 곡명: ${trackName}
- 아티스트: ${artistName}
- 앨범: ${albumName || "Single"}
- 장르 힌트: ${genreHint || "Unknown"}
- 오디오에서 측정한 BPM: ${bpm || "측정 안 됨"}
- 오디오에서 측정한 키: ${keyName || "측정 안 됨"}
- 가사:
${lyrics ? String(lyrics).slice(0, 2500) : "(가사 데이터베이스에서 가사를 찾지 못했습니다. 가사가 있는 곡인지는 알 수 없습니다.)"}

규칙:
1. categories는 정확히 4개: "장르 & 세부 장르", "주요 악기", "보컬 스타일", "분위기". 각 2~4개 항목.
2. conf는 해당 태그에 대한 당신의 추정 확신도(50~99 정수)입니다. 모르면 낮게 주세요.
3. lyricsSummary와 moodKeywords, note는 한국어로 작성하세요.
4. 가사를 찾지 못한 것은 연주곡이라는 뜻이 아닙니다. 가사가 제공되지 않았다면 연주곡(Instrumental)이라고 단정하지 말고, 보컬 항목은 확신도를 60 이하로 낮추고 note에 "가사/음원 정보 부족"이라고 쓰세요. lyricsSummary에는 "가사 데이터를 찾지 못해 요약할 수 없습니다"라고 쓰세요.
5. stylePrompt는 Suno/Udio에 붙여넣을 영어 키워드 한 줄이며, 측정된 BPM과 키가 있으면 포함하세요.`;

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
      lyricsSummary: { type: "STRING" },
      stylePrompt: { type: "STRING" }
    },
    required: ["categories", "moodKeywords", "lyricsSummary", "stylePrompt"]
  };

  try {
    const models = [process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"].filter(Boolean);
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema }
    });
    let r;
    for (const m of models) {
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body,
          signal: AbortSignal.timeout(14000)
        });
      } catch {
        r = { ok: false, status: 504 };
        continue;
      }
      if (r.ok || ![404, 429, 500, 503].includes(r.status)) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    if (!r.ok) return res.status(r.status).json({ error: `Gemini API 오류 (${r.status})` });

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(502).json({ error: "Gemini 응답이 비어 있습니다." });
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({ error: err.message || "분석 실패" });
  }
}
